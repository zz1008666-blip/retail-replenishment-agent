/**
 * 确定性决策内核：Monitor → Detect → Investigate → Decide。
 * 不依赖真实 LLM，规则可离线 100% 复现；决策链路产出完整证据。
 */
import type { InventorySnapshot } from '../contract/types';
import { sellableOf, daysOfSupply } from '../contract/types';
import type { DataQualityWarning } from '../adapters/adapter';
import type { CaseRecord } from '../memory/case';

export type AnomalyKind = 'stockout' | 'overstock' | 'none';
export type Severity = 'none' | 'low' | 'high';

export interface Anomaly {
  kind: AnomalyKind;
  severity: Severity;
  reason: string;
}

/** 业务动作（与 ACL ActionType 中 APPROVAL 档对应） */
export type AdviceAction = 'create_replenishment_order' | 'adjust_price' | 'delist' | 'none';

export interface EvidenceItem {
  source: string;
  field: string;
  value: unknown;
}

export interface MarginCheck {
  ok: boolean;
  reason: string;
  grossMargin?: number;
}

export interface Advice {
  action: AdviceAction;
  quantity?: number;
  supplier?: string;
  etaDays?: number;
  targetPrice?: number;
  marginCheck: MarginCheck;
  requiresApproval: boolean;
  rationale: string;
  reusedCaseId?: number;
}

export interface DetectResult {
  anomaly: Anomaly;
  blocked: boolean;
  blockReason?: string;
}

export interface Decision {
  skuId: string;
  anomaly: Anomaly;
  advice: Advice;
  evidence: EvidenceItem[];
  dataQualityWarnings: string[];
  blocked: boolean;
  blockReason?: string;
}

export interface ReplenishmentConfig {
  /** 库销比（可售天数）超过此值判定积压 */
  overstockDays: number;
  /** 补货后目标覆盖天数 */
  targetCoverDays: number;
  /** 毛利安全下限 */
  minGrossMargin: number;
}

export const DEFAULT_CONFIG: ReplenishmentConfig = {
  overstockDays: 60,
  targetCoverDays: 30,
  minGrossMargin: 0.1
};

/** 关键字段：缺失/冲突会导致无法安全决策 */
const CRITICAL_FIELDS = ['onHand', 'reserved', 'dailyDemand', 'cost', 'price'];

/**
 * Detect：判定异常（缺货 / 积压 / 无）。
 * 促销状态是一等公民：促销中的低库存不按「缺货」报（防误报），
 * 只有下探到安全库存硬底线才触发。
 */
export function detect(snapshot: InventorySnapshot, warnings: DataQualityWarning[]): DetectResult {
  // SKU 错配：数据完整性硬伤，先排除再处置
  const mismatch = warnings.filter((w) => w.kind === 'MISMATCH');
  if (mismatch.length > 0) {
    return {
      anomaly: { kind: 'none', severity: 'none', reason: 'SKU 错配，禁止进入处置' },
      blocked: true,
      blockReason: mismatch.map((w) => w.message).join('; ')
    };
  }

  const critical = warnings.filter((w) => w.kind !== 'STALE' && CRITICAL_FIELDS.includes(w.field));
  if (critical.length > 0) {
    return {
      anomaly: { kind: 'none', severity: 'none', reason: '数据口径异常，禁止进入处置' },
      blocked: true,
      blockReason: critical.map((w) => w.message).join('; ')
    };
  }

  const sellable = sellableOf(snapshot);
  const promo = snapshot.promotion;

  if (promo.active) {
    // 促销抢光不算缺货：只用安全库存做硬底线
    if (sellable < snapshot.safetyStock) {
      return {
        anomaly: {
          kind: 'stockout',
          severity: 'high',
          reason: `促销中可售(${sellable})已跌破安全库存(${snapshot.safetyStock})硬底线`
        },
        blocked: false
      };
    }
    return {
      anomaly: { kind: 'none', severity: 'none', reason: '促销中，可售水位正常，不作为缺货误报' },
      blocked: false
    };
  }

  if (sellable <= snapshot.reorderPoint) {
    return {
      anomaly: {
        kind: 'stockout',
        severity: 'high',
        reason: `可售(${sellable})低于再订货点(${snapshot.reorderPoint})`
      },
      blocked: false
    };
  }

  const dos = daysOfSupply(snapshot);
  if (Number.isFinite(dos) && dos >= DEFAULT_CONFIG.overstockDays) {
    return {
      anomaly: {
        kind: 'overstock',
        severity: 'low',
        reason: `可售天数(${dos.toFixed(1)})超过积压阈值(${DEFAULT_CONFIG.overstockDays})天`
      },
      blocked: false
    };
  }

  return { anomaly: { kind: 'none', severity: 'none', reason: '库存水位正常' }, blocked: false };
}

function grossMargin(price: number, cost: number): number {
  if (price <= 0) return -Infinity;
  return (price - cost) / price;
}

/**
 * 有效售价：考虑促销对售价的扭曲。
 * - 促销价存在时以促销价为准
 * - 多活动叠加（stacked）再额外让利 20%
 */
function effectiveSellPrice(snapshot: InventorySnapshot): number {
  let p = snapshot.price;
  if (snapshot.promotion.active && snapshot.promotion.promoPrice != null) {
    p = snapshot.promotion.promoPrice;
  }
  if (snapshot.promotion.stacked) {
    p = p * 0.8;
  }
  return p;
}

/**
 * Decide：依据异常与历史案例计算处置建议（补货量 / 调价 / 下架），并做毛利约束检查。
 */
export function decide(
  snapshot: InventorySnapshot,
  det: DetectResult,
  cases: CaseRecord[],
  config: ReplenishmentConfig = DEFAULT_CONFIG
): { advice: Advice; evidence: EvidenceItem[] } {
  const evidence: EvidenceItem[] = [
    { source: snapshot.provenance['onHand'] ?? 'unknown', field: 'onHand', value: snapshot.onHand },
    { source: snapshot.provenance['inTransit'] ?? 'unknown', field: 'inTransit', value: snapshot.inTransit },
    { source: snapshot.provenance['reserved'] ?? 'unknown', field: 'reserved', value: snapshot.reserved },
    { source: snapshot.provenance['dailyDemand'] ?? 'unknown', field: 'dailyDemand', value: snapshot.dailyDemand },
    { source: snapshot.provenance['cost'] ?? 'unknown', field: 'cost', value: snapshot.cost },
    { source: snapshot.provenance['price'] ?? 'unknown', field: 'price', value: snapshot.price },
    { source: 'PROMOTION', field: 'promotion.active', value: snapshot.promotion.active },
    { source: 'PROMOTION', field: 'promotion.stacked', value: snapshot.promotion.stacked }
  ];

  if (det.blocked) {
    return {
      advice: {
        action: 'none',
        marginCheck: { ok: false, reason: det.blockReason ?? '数据口径异常' },
        requiresApproval: false,
        rationale: '数据口径异常，禁止处置，转人工'
      },
      evidence
    };
  }

  // 复用历史案例：优先取同 SKU 同异常类型、处置有效的最近案例
  const reused = cases.find((c) => c.outcomeOk);

  if (det.anomaly.kind === 'stockout') {
    const quantity = replenishQty(snapshot, config);
    const effPrice = effectiveSellPrice(snapshot);
    const mg = grossMargin(effPrice, snapshot.cost);
    const marginOk = mg >= config.minGrossMargin;
    if (!marginOk) {
      // 毛利约束冲突：补货建议被拦，转人工（不执行）
      return {
        advice: {
          action: 'none',
          marginCheck: {
            ok: false,
            reason: `促销叠加致毛利为负（有效价 ${effPrice.toFixed(2)} < 成本 ${snapshot.cost}），补货建议被拦`,
            grossMargin: mg
          },
          requiresApproval: false,
          rationale: '毛利约束冲突，建议拦截并转人工复核'
        },
        evidence
      };
    }
    return {
      advice: {
        action: 'create_replenishment_order',
        quantity,
        supplier: '供应商-A',
        etaDays: snapshot.leadTimeDays,
        marginCheck: { ok: true, reason: '毛利满足下限', grossMargin: mg },
        requiresApproval: true,
        rationale: reused
          ? `复用历史调查路径（case#${reused.id}）：${reused.cause}`
          : `缺货：建议补货 ${quantity} 件，覆盖 ${config.targetCoverDays} 天`,
        reusedCaseId: reused?.id
      },
      evidence
    };
  }

  if (det.anomaly.kind === 'overstock') {
    const dos = daysOfSupply(snapshot);
    // 积压处置：优先调价清库存；若促销叠加导致毛利不可修复则建议下架
    const price = snapshot.price;
    const target = Math.max(snapshot.cost * 1.05, price * 0.85);
    const mg = grossMargin(target, snapshot.cost);
    const marginOk = mg >= config.minGrossMargin;
    return {
      advice: {
        action: marginOk ? 'adjust_price' : 'delist',
        targetPrice: Number(target.toFixed(2)),
        marginCheck: { ok: marginOk, reason: marginOk ? '调价后毛利可接受' : '促销叠加致毛利不可修复', grossMargin: mg },
        requiresApproval: true,
        rationale: `积压：可售天数 ${dos.toFixed(1)}，建议${marginOk ? '调价清库存' : '下架'}`,
        reusedCaseId: reused?.id
      },
      evidence
    };
  }

  return {
    advice: {
      action: 'none',
      marginCheck: { ok: true, reason: '无需处置', grossMargin: grossMargin(snapshot.price, snapshot.cost) },
      requiresApproval: false,
      rationale: '库存正常，无动作'
    },
    evidence
  };
}

/** 补货量 = 目标覆盖需求 - 现有可售（含在途）- 安全库存兜底 */
export function replenishQty(snapshot: InventorySnapshot, config: ReplenishmentConfig): number {
  const coverDemand = snapshot.dailyDemand * config.targetCoverDays;
  const availableNow = snapshot.onHand + snapshot.inTransit - snapshot.reserved;
  return Math.max(0, Math.ceil(coverDemand - availableNow));
}
