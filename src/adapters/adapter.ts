/**
 * Adapter 抽象：把多系统（BI/ERP/库存/销量/促销）原始数据归一化为统一契约。
 *
 * 归一化分两步：
 *  1. fetchRaw：读取源系统原始数据（各系统格式不同）
 *  2. normalize：映射为标准字段分片，每个字段标记来源系统
 * 最终由 materialize 合并，检测口径冲突。
 */
import type {
  InventorySnapshot,
  PromotionState,
  SourceSystem,
  TimeWindow,
  DataQualityWarning
} from '../contract/types';
import { sellableOf } from '../contract/types';

export type { DataQualityWarning } from '../contract/types';

/** 归一化后的字段分片：每个字段携带来源系统 */
export interface NormalizedFields {
  skuId: string;
  onHand?: { value: number; source: SourceSystem };
  inTransit?: { value: number; source: SourceSystem };
  reserved?: { value: number; source: SourceSystem };
  dailyDemand?: { value: number; source: SourceSystem };
  leadTimeDays?: { value: number; source: SourceSystem };
  safetyStock?: { value: number; source: SourceSystem };
  reorderPoint?: { value: number; source: SourceSystem };
  promotion?: { value: PromotionState; source: SourceSystem };
  cost?: { value: number; source: SourceSystem };
  price?: { value: number; source: SourceSystem };
  asOf?: string;
}

export interface Adapter {
  readonly system: SourceSystem;
  /** 从源系统读取原始数据 */
  fetchRaw(skuId: string): Promise<Record<string, unknown>>;
  /** 原始数据 -> 标准字段分片 */
  normalize(skuId: string, raw: Record<string, unknown>): NormalizedFields;
  /** 从原始数据中提取 SKU 身份标识（用于 SKU 错配校验） */
  extractSkuId(raw: Record<string, unknown>): string | undefined;
}

/** 两个数值是否「口径一致」（相对容差 1%） */
function roughlyEqual(a: number, b: number): boolean {
  if (a === b) return true;
  const diff = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return diff / scale <= 0.01;
}

type FieldDef = {
  key: keyof Omit<NormalizedFields, 'skuId' | 'asOf'>;
  kind: 'number' | 'promotion';
};

const FIELD_ORDER: FieldDef[] = [
  { key: 'onHand', kind: 'number' },
  { key: 'inTransit', kind: 'number' },
  { key: 'reserved', kind: 'number' },
  { key: 'dailyDemand', kind: 'number' },
  { key: 'leadTimeDays', kind: 'number' },
  { key: 'safetyStock', kind: 'number' },
  { key: 'reorderPoint', kind: 'number' },
  { key: 'promotion', kind: 'promotion' },
  { key: 'cost', kind: 'number' },
  { key: 'price', kind: 'number' }
];

/**
 * 合并多个 Adapter 的归一化分片，得到一份完整快照。
 * - 每个字段记录 provenance（来源系统）
 * - 同一字段被多个系统以不同口径提供时，产生 CONFLICT 告警（不静默覆盖）
 * - 关键字段缺失时产生 MISSING 告警
 */
export function materialize(
  skuId: string,
  window: TimeWindow,
  fieldsList: NormalizedFields[]
): { snapshot: InventorySnapshot; warnings: DataQualityWarning[] } {
  const warnings: DataQualityWarning[] = [];
  const merged: Record<string, { value: unknown; source: SourceSystem }> = {};

  for (const fields of fieldsList) {
    for (const { key, kind } of FIELD_ORDER) {
      const f = fields[key] as { value: unknown; source: SourceSystem } | undefined;
      if (f === undefined) continue;
      const existing = merged[key];
      if (existing) {
        const conflict =
          kind === 'number'
            ? !roughlyEqual(existing.value as number, f.value as number)
            : JSON.stringify(existing.value) !== JSON.stringify(f.value);
        if (conflict) {
          warnings.push({
            field: key,
            kind: 'CONFLICT',
            message: `${key} 口径冲突：${existing.source}=${String(existing.value)} vs ${f.source}=${String(f.value)}`,
            sources: [existing.source, f.source]
          });
          continue; // 冲突字段不采纳，交由上层处置
        }
      } else {
        merged[key] = f;
      }
    }
  }

  // 检查关键字段缺失
  const required = ['onHand', 'inTransit', 'reserved', 'dailyDemand', 'leadTimeDays', 'cost', 'price'] as const;
  for (const key of required) {
    if (merged[key] === undefined) {
      warnings.push({
        field: key,
        kind: 'MISSING',
        message: `${key} 缺失，无法完成补货判断`,
        sources: []
      });
    }
  }

  const num = (k: string): number => (merged[k]?.value as number) ?? 0;
  const asOf = fieldsList.map((f) => f.asOf).filter(Boolean).sort().reverse()[0] ?? new Date().toISOString();

  const promotion: PromotionState = (merged['promotion']?.value as PromotionState) ?? {
    active: false,
    type: 'NONE',
    demandFactor: 1,
    stacked: false
  };

  const snapshot: InventorySnapshot = {
    skuId,
    window,
    asOf,
    onHand: num('onHand'),
    inTransit: num('inTransit'),
    reserved: num('reserved'),
    dailyDemand: num('dailyDemand'),
    leadTimeDays: num('leadTimeDays'),
    safetyStock: num('safetyStock'),
    reorderPoint: num('reorderPoint'),
    promotion,
    cost: num('cost'),
    price: num('price'),
    provenance: {}
  };
  for (const [k, v] of Object.entries(merged)) {
    snapshot.provenance[k] = v.source;
  }
  // 可售数量必须为负保护：预留不能超过在库
  if (sellableOf(snapshot) < 0) {
    warnings.push({
      field: 'reserved',
      kind: 'CONFLICT',
      message: `预留(${snapshot.reserved})超过在库(${snapshot.onHand})，数据异常`,
      sources: [merged['onHand']?.source ?? 'INVENTORY', merged['reserved']?.source ?? 'ERP']
    });
  }

  return { snapshot, warnings };
}
