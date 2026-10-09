# 架构与设计取舍

## 1. 设计目标

把「电商库存补货」从人工看报表下单，升级为可追溯、可审计、有边界的决策闭环。三个核心诉求：

1. **可追溯**：每条补货建议都保留完整决策链（查了哪些数据、依据是什么、谁批准的），不是一次性结论。
2. **有边界**：AI 有建议权，人保留审批权与参数校准权；高风险动作不能越过人工授权。
3. **可复盘**：决策过程用 Trace 记录，质量用故障样例 + 回归门禁守住，改动不能偷偷变差。

## 2. 四层进程架构

这是项目最外层的骨架，决定「哪些代码在哪个进程、谁能碰什么」：

| 层 | 设计原型 | 本项目的载体 | 进程内职责 | 明确的「不做」 |
|---|---|---|---|---|
| **Client** | 客户端 | CLI（eval/run/serve）+ 静态 Web 面板 | 交互与展示 | 不碰数据，不碰决策 |
| **Backend** | 后端 | HTTP（`node:http`）+ SQLite 真相源 + Runner 管理 | 落账、取数、审批 | **不解读 prompt、不跑工具** |
| **Runner** | Runner | `child_process.fork` 子进程 + stdio JSON-RPC | agent-loop 跑六阶段 Turn | **不连数据库**，取数走 tool_call IPC |
| **Workspace** | Workspace | 每次 run 一个隔离目录 | 调查产物落盘隔离 | 不做进程边界外的事 |

### 为什么这样分层（代价与收益）

- **进程隔离换安全**：决策代码（Runner）即使被 prompt 注入诱导，也**没有数据库句柄**——取数只能通过带 ACL 的 `tool_call` 回 Backend 请求，Backend 只认授权、不看 prompt。这是把「别越权」从提示词约束升级为进程边界。
- **真相源唯一**：只有 Backend 写 SQLite，Runner/Client 都是无状态或仅持会话态，崩溃/重启不会污染账本。
- **可并行可扩**：Runner 是子进程，天然多实例；Backend 单真相源；Workspace 每 run 隔离。
- **代价**：多一层 IPC 往返（`tool_call` 取数），补货是低频任务，这个延迟无感；换来的是边界清晰。

### stdio JSON-RPC = MCP 的同构原型

`Backend ↔ Runner` 之间用「换行分隔 JSON」承载三类消息：`request`（带 id，期望响应）、`response`（带 id 回填）、`notification`（无 id，单向）。这与 **MCP（Model Context Protocol）** 的基座形态同构——Runner 想取数，发一个 `tool_call` request 给 Backend，Backend 按 ACL 授权后回 `response`；未经授权的取数被拒（fail-closed）。协议层由本项目基于 stdio 独立实现，无第三方 MCP 依赖。

## 3. 数据契约（Tool Hub 基座）

多系统口径不一是补货判断失真的根源。所有源系统数据先归一化到一份 JSON Schema（`InventorySnapshot`），再进入处置：

| 字段 | 说明 | 为什么必须有 |
|---|---|---|
| `skuId` | 最小可售规格 | 缺货发生在具体规格上 |
| `window` | 数据覆盖时间窗 | 案例召回、口径对齐的时间边界 |
| `onHand / inTransit / reserved` | 在库 / 在途 / 预留 | 可售 = 在库 - 预留，把「已锁单」当可售会漏算真实可售量 |
| `promotion` | 促销状态（含叠加） | 促销会制造需求，「促销抢光」≠「备货不足」 |
| `provenance` | 字段级来源追踪 | 证据链：结论能追溯到「这个值来自哪个系统」 |

归一化分两步：`fetchRaw` 读源系统原始数据 → `normalize` 映射为标准字段分片（每字段带 source）。最后 `materialize` 合并并检测**口径冲突**（同一字段多系统取值不一致）与 **SKU 错配**（源系统返回的身份标识与查询不符）。冲突不静默覆盖，而是进入 `DataQualityWarning`，由 Detect 阶段阻断处置。

**为什么注册成 MCP Tool 而不是直连数据库**：直连绕过授权层。注册成工具后，取数走 Tool Registry 的三层检查（ACL 授权 → Session 范围 → 执行），fail-closed（默认拒绝），AI 只能调用它被允许的工具。

## 4. Workflow Runtime（六阶段可恢复 Turn）

决策链拆成六个不可省略的问题：

| 阶段 | 回答的问题 | 可加的审计点 |
|---|---|---|
| Monitor | 有没有事 | 取数快照落账 |
| Detect | 是不是事 | 异常判定 + 阻断原因 |
| Investigate | 为什么 | 历史案例召回 |
| Decide | 怎么办 | 建议 + 毛利检查 |
| Act | 谁批准执行 | 审批 + 幂等执行 |
| Review | 做对没有 | 沉淀案例 |

**可恢复 Turn**：每个 Turn 由逻辑键派生 `runId`（`sha256(logicalKey)`），同一条触发消息无论重放多少次只产生同一 Turn。阶段状态、动作参数持久化在 `turn` 表，`checkpoint` 字段保存当前阶段的证据与动作参数。

**审批后从 Checkpoint 恢复**：审批通过只是把状态从 `awaiting_approval` 推进到 `approved`，恢复时读断点里的动作参数（补货量、供应商、到货时间）直接执行，**不重跑 Monitor→Decide**（case-11 断言 Investigate 只执行一次）。

**幂等**：有副作用的动作（补货单/调价/下架）通过 `executed_action` 表（`action_key` 唯一约束）+ INSERT 抢占实现「同 key 只执行一次」，崩溃重试 / 重复审批不会重复下单（case-13）。

**同 SKU 串行**：Session Scheduler 为每个 `skuId` 建一条 lane，同 SKU 的任务串行推进（防并发改写同一 SKU 状态打架），异 SKU 并行。

## 5. 定时巡检调度器（Cron 双层模型）

| 层 | 表 | 职责 |
|---|---|---|
| 定义层 | `scheduled_task` | 周期/一次性任务，`next_run` 游标兼乐观锁 |
| 触发实例层 | `task_occurrence` | 每次触发的物化，`occurrence_key` 唯一约束 |

- **乐观锁**：认领任务用 `UPDATE ... WHERE next_run = ?`，多实例竞争时谁先推进谁执行，后到的看到行已改即放弃。
- **幂等物化**：`occurrence_key = taskId@runAt` 唯一约束 + `INSERT OR IGNORE`，重复物化只生效一次。
- **重启语义**：周期任务错过的轮次「missed 不补跑」——缺货是持续状态，下一轮仍能抓到，补跑 N 轮会形成追债级联；一次性任务错过就永远错过，必须「必达」backfill（case-14 / case-15）。

## 6. ACL 权限矩阵（两维正交）

权限分两个正交维度，判断函数里**绝不读 role 字段**：

1. **系统能力**（角色）：谁能做系统级管理
2. **资源归属**（授权）：谁能碰哪个 SKU / 工作区

动作三级分级：`read_inventory` / `generate_advice` = AUTO；`create_replenishment_order` / `adjust_price` / `delist` = APPROVAL；`delete_data` = BLOCKED。

**admin 无旁路**：admin 只持有系统能力，对具体 SKU 资源的访问仍走资源归属检查。授权是资源层硬边界，不放进提示词（提示词可被注入操纵）。

## 7. Case Memory（CAS + FTS5）

案例三段式 Schema（`cause` 原因 / `action` 动作 / `outcome` 结果）。并发写用 `revision` compare-and-set：`UPDATE ... WHERE id=? AND revision=?`，不匹配抛 `CaseConflictError`（等价 409），显式暴露冲突而非静默覆盖。

召回用 FTS5 trigram + bm25：案例召回是**精确匹配**（SKU 编号、关键词），不是语义相似，所以用 FTS5 而非向量 RAG。短关键词（<3 字符，如中文两字词）降级 LIKE。

## 8. Trace Eval + 回归门禁

评测看 Trace 不看最终输出（防「过程错、结果碰对」）。三项断言：

- **SKU Matching**：决策与轨迹始终指向同一 SKU，调查不串数据
- **Evidence Coverage**：结论覆盖关键字段且来源可追溯
- **Action Safety**：无越权动作、执行必经过审批

六类故障样例覆盖「数据 → 规则 → 流程 → 基建」四个失败面，回归门禁对照三项指标，任一低于基线即阻断发布。

## 9. 关键取舍

- **确定性内核 > 真模型**：离线可复现优先，LLM 端口可插拔，二者不冲突。
- **精确召回 > 语义召回**：案例复用要的是「可复用」而非「语义相近」。
- **串行 > 吞吐**：同 SKU 串行换正确性，补货是低频任务，串行不是瓶颈。
- **约束下沉数据库**：业务不变量用 CHECK/UNIQUE 编码在写入层，应用代码漏判/绕过不了。
- **宁可卡住，不可重复**：副作用动作只认幂等键，不靠应用层判断重试。
- **进程边界 > 提示词约束**：把「不越权」从 prompt 伦理升级为「Runner 无 DB 句柄」的进程隔离（详见 §2）。