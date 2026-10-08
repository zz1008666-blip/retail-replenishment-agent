/**
 * 数据契约：库存补货场景的统一领域模型。
 *
 * 设计动机（见 docs/ARCHITECTURE.md）：
 * 电商多系统（BI / ERP / 库存 / 销量 / 促销）口径不一，缺货判断容易失真。
 * 所有 Adapter 归一化到这一份 Schema，把「可售 / 在途 / 预留」「促销状态」
 * 显式建模，先排除规格与活动差异，再进入处置。
 */

/** 源系统枚举：与五类 Adapter 一一对应 */
export type SourceSystem = 'BI' | 'ERP' | 'INVENTORY' | 'SALES' | 'PROMOTION';

/** 促销类型 */
export type PromotionType =
  | 'NONE'
  | 'FULL_REDUCTION' // 满减
  | 'FLASH_SALE' // 秒杀
  | 'COUPON' // 优惠券
  | 'BUNDLE'; // 组合装

/** 促销状态：促销是「需求扭曲」的一等公民，缺货判断必须可见 */
export interface PromotionState {
  active: boolean;
  type: PromotionType;
  /** 促销对销量的放大系数：2.0 表示促销期销量约为平日 2 倍 */
  demandFactor: number;
  /** 促销价（若存在），用于毛利约束检查 */
  promoPrice?: number;
  /** 是否多活动叠加（满减 + 秒杀 同时命中） */
  stacked: boolean;
}

/** 数据覆盖的时间窗 */
export interface TimeWindow {
  start: string; // ISO 日期 YYYY-MM-DD
  end: string;
}

/**
 * 归一化后的库存快照：补货判断所需的全部字段。
 * 每一个业务字段都带 provenance 记录「这个值来自哪个系统」，
 * 形成可复核的证据链（Evidence Chain）。
 */
export interface InventorySnapshot {
  skuId: string;
  window: TimeWindow;
  /** 采集时间戳 */
  asOf: string;
  /** 在库数量 */
  onHand: number;
  /** 在途数量（已下单未到货） */
  inTransit: number;
  /** 预留数量（已锁单未发出） */
  reserved: number;
  /** 近 N 日均销量 */
  dailyDemand: number;
  /** 补货提前期（天） */
  leadTimeDays: number;
  /** 安全库存 */
  safetyStock: number;
  /** 再订货点 ROP */
  reorderPoint: number;
  promotion: PromotionState;
  /** 单位成本 */
  cost: number;
  /** 标准售价 */
  price: number;
  /** 字段级来源追踪：字段名 -> 来源系统 */
  provenance: Record<string, SourceSystem>;
}

/** 计算可售数量：在库 - 预留（已锁单的货不能算可售） */
export function sellableOf(s: InventorySnapshot): number {
  return s.onHand - s.reserved;
}

/** 可售天数（库销比的倒数）：可售 / 日均需求 */
export function daysOfSupply(s: InventorySnapshot): number {
  if (s.dailyDemand <= 0) return Number.POSITIVE_INFINITY;
  return sellableOf(s) / s.dailyDemand;
}

/** 数据质量告警：口径冲突 / 数据陈旧 / SKU 错配等，需在处置前排除 */
export interface DataQualityWarning {
  field: string;
  kind: 'CONFLICT' | 'STALE' | 'MISSING' | 'MISMATCH';
  message: string;
  sources: SourceSystem[];
}
