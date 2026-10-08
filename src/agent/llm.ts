/**
 * LLM 端口：决策内核可插拔。
 * 默认 DeterministicAdapter 离线 100% 可复现（20 条 case 稳定通过）；
 * 配置了 OPENAI_API_KEY 等凭据后，可替换为 OpenAICompatibleAdapter 接入真模型。
 */
import type { InventorySnapshot } from '../contract/types';
import type { DataQualityWarning } from '../adapters/adapter';
import type { CaseRecord } from '../memory/case';
import { detect, decide, Decision } from './decision';

export interface LLMContext {
  snapshot: InventorySnapshot;
  warnings: DataQualityWarning[];
  cases: CaseRecord[];
}

export interface LLMAdapter {
  readonly name: string;
  decide(ctx: LLMContext): Promise<Decision>;
}

/** 确定性实现：规则内核，无网络、无随机，测试可精确断言 */
export class DeterministicAdapter implements LLMAdapter {
  readonly name = 'deterministic';
  async decide(ctx: LLMContext): Promise<Decision> {
    const det = detect(ctx.snapshot, ctx.warnings);
    const { advice, evidence } = decide(ctx.snapshot, det, ctx.cases);
    return {
      skuId: ctx.snapshot.skuId,
      anomaly: det.anomaly,
      advice,
      evidence,
      dataQualityWarnings: ctx.warnings.map((w) => w.message),
      blocked: det.blocked,
      blockReason: det.blockReason
    };
  }
}

/** OpenAI 兼容适配器：把上下文交给外部模型，仅在配置 Key 时使用（生产/真模型路径） */
export class OpenAICompatibleAdapter implements LLMAdapter {
  readonly name = 'openai-compatible';
  constructor(
    private opts: { baseUrl: string; apiKey: string; model: string }
  ) {}
  async decide(ctx: LLMContext): Promise<Decision> {
    // 真实实现：调用 /v1/chat/completions，让模型产出结构化决策。
    // 为保持离线可复现，本项目测试不启用此路径；此处为端口契约示意。
    const resp = await fetch(`${this.opts.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.apiKey}`
      },
      body: JSON.stringify({
        model: this.opts.model,
        messages: [{ role: 'user', content: JSON.stringify(ctx) }],
        response_format: { type: 'json_object' }
      })
    });
    const json = (await resp.json()) as { choices: { message: { content: string } }[] };
    return JSON.parse(json.choices[0].message.content) as Decision;
  }
}

/** 依据环境变量选择 LLM 适配器 */
export function resolveLLMAdapter(): LLMAdapter {
  const key = process.env['OPENAI_API_KEY'];
  const baseUrl = process.env['OPENAI_BASE_URL'];
  const model = process.env['OPENAI_MODEL'];
  if (key && baseUrl && model) {
    return new OpenAICompatibleAdapter({ baseUrl, apiKey: key, model });
  }
  return new DeterministicAdapter();
}
