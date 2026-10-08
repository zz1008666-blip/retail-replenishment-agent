/**
 * Client 层 · Web 面板：一个零依赖的轻量面板，用于演示四层架构。
 *
 * 它只做「展示 + 触发」：
 *   - 触发：POST /api/v1/inspect（由 Backend fork Runner 完成决策）
 *   - 展示：GET /api/v1/runs、/api/v1/decision/:id、/api/v1/trace/:id
 *
 * 对应 MiniClaw 的 Web 前端，但裁剪为内联单页（不引入打包器）。
 */

export const WEB_PANEL_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>零售库存补货决策智能体 · 控制台</title>
<style>
  :root {
    --bg: #f7f8fa; --card: #ffffff; --ink: #1f2329; --muted: #6b7280;
    --line: #e5e7eb; --brand: #2f6bff; --brand-ink: #ffffff;
    --red: #d93025; --green: #1e8e3e; --amber: #b26a00;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: var(--bg); color: var(--ink); }
  header { background: var(--card); border-bottom: 1px solid var(--line); padding: 16px 24px; }
  header h1 { margin: 0; font-size: 18px; }
  header p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
  main { max-width: 960px; margin: 24px auto; padding: 0 16px; }
  .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  input[type=text] { flex: 1; min-width: 220px; padding: 10px 12px; border: 1px solid var(--line);
    border-radius: 8px; font-size: 14px; }
  button { padding: 10px 18px; border: 0; border-radius: 8px; background: var(--brand);
    color: var(--brand-ink); font-size: 14px; cursor: pointer; }
  button:hover { filter: brightness(1.05); }
  button.ghost { background: #eef1f6; color: var(--ink); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    padding: 16px; margin-top: 16px; }
  .card h2 { margin: 0 0 12px; font-size: 15px; }
  .kv { display: grid; grid-template-columns: 110px 1fr; row-gap: 8px; font-size: 14px; }
  .kv dt { color: var(--muted); }
  .kv dd { margin: 0; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px;
    font-weight: 600; }
  .stockout { background: #fdecea; color: var(--red); }
  .overstock { background: #fef7e0; color: var(--amber); }
  .none { background: #e6f4ea; color: var(--green); }
  .muted { color: var(--muted); }
  pre { background: #0f172a; color: #e2e8f0; border-radius: 8px; padding: 12px; overflow: auto;
    font-size: 12px; max-height: 360px; }
  ul { margin: 0; padding-left: 0; list-style: none; }
  li { padding: 8px 4px; border-bottom: 1px solid var(--line); font-size: 13px; cursor: pointer; }
  li:hover { background: #f3f6fb; }
  .layers { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .layer { padding: 6px 12px; border-radius: 8px; font-size: 12px; background: #eef1f6; }
</style>
</head>
<body>
<header>
  <h1>零售库存补货决策智能体</h1>
  <p>Client → Backend → Pi Runner → Workspace 四层架构 · 单机离线 · 确定性内核</p>
</header>
<main>
  <div class="card">
    <h2>触发一次巡检</h2>
    <div class="row">
      <input id="sku" type="text" placeholder="SKU 编号，例如 SKU-DEMO-1" value="SKU-DEMO-1" />
      <button id="inspectBtn">巡检</button>
      <button class="ghost" id="refreshBtn">刷新运行记录</button>
    </div>
    <div class="layers">
      <span class="layer">Client = 本页</span>
      <span class="layer">Backend = HTTP + SQLite 真相源</span>
      <span class="layer">Runner = fork 子进程 agent-loop</span>
      <span class="layer">Workspace = 隔离调查目录</span>
    </div>
  </div>

  <div class="card" id="resultCard" style="display:none">
    <h2>巡检结果</h2>
    <dl class="kv" id="result"></dl>
    <div id="traceWrap" style="display:none; margin-top:12px">
      <h2>流式事件轨迹（StreamEvent）</h2>
      <pre id="trace"></pre>
    </div>
  </div>

  <div class="card">
    <h2>运行记录</h2>
    <ul id="runs"><li class="muted">暂无记录</li></ul>
  </div>
</main>

<script>
  const $ = (id) => document.getElementById(id);

  async function refreshRuns() {
    const resp = await fetch('/api/v1/runs');
    const body = await resp.json();
    const list = $('runs');
    list.innerHTML = '';
    if (!body.length) { list.innerHTML = '<li class="muted">暂无记录</li>'; return; }
    for (const r of body) {
      const li = document.createElement('li');
      const kind = r.anomaly && r.anomaly.kind;
      li.innerHTML = '<span class="badge ' + kind + '">' + (kind || '?') + '</span> '
        + '<b>' + r.skuId + '</b> <span class="muted">' + r.runId.slice(0, 8) + '</span>'
        + ' — ' + (r.advice ? r.advice.rationale : '');
      li.onclick = () => loadResult(r.runId);
      list.appendChild(li);
    }
  }

  async function loadResult(runId) {
    const resp = await fetch('/api/v1/decision/' + runId);
    const body = await resp.json();
    if (!body.ok) return;
    const d = body.decision;
    $('resultCard').style.display = '';
    $('result').innerHTML =
      '<dt>SKU</dt><dd>' + d.skuId + '</dd>' +
      '<dt>异常</dt><dd>' + (d.anomaly.kind + ' / ' + d.anomaly.severity + ' / ' + (d.anomaly.reason || '')) + '</dd>' +
      '<dt>建议动作</dt><dd>' + (d.advice.action || '') + '</dd>' +
      '<dt>建议</dt><dd>' + (d.advice.rationale || '') + '</dd>' +
      '<dt>需审批</dt><dd>' + (d.advice.requiresApproval ? '是' : '否') + '</dd>' +
      '<dt>证据条数</dt><dd>' + (d.evidence ? d.evidence.length : 0) + '</dd>' +
      '<dt>是否阻断</dt><dd>' + (d.blocked ? '是（' + (d.blockReason || '') + '）' : '否') + '</dd>';
    const t = await (await fetch('/api/v1/trace/' + runId)).json();
    $('traceWrap').style.display = 'block';
    $('trace').textContent = JSON.stringify(t.events, null, 2);
  }

  $('inspectBtn').onclick = async () => {
    const skuId = $('sku').value.trim();
    const resp = await fetch('/api/v1/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skuId: skuId, principalId: 'demo-operator' })
    });
    const body = await resp.json();
    if (!body.ok) { alert(body.error || '巡检失败'); return; }
    await loadResult(body.runId);
    refreshRuns();
  };
  $('refreshBtn').onclick = refreshRuns;
  refreshRuns();
</script>
</body>
</html>`;