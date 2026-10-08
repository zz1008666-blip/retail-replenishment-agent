/**
 * 五个源系统 Adapter：各自把「原始格式」翻译成统一契约分片。
 */
import type { NormalizedFields, Adapter } from './adapter';
import type { MockBackend } from './mock-backend';
import type { PromotionType } from '../contract/types';

function toPromoType(t: string): PromotionType {
  const map: Record<string, PromotionType> = {
    NONE: 'NONE',
    FULL_REDUCTION: 'FULL_REDUCTION',
    FLASH_SALE: 'FLASH_SALE',
    COUPON: 'COUPON',
    BUNDLE: 'BUNDLE'
  };
  return map[t] ?? 'NONE';
}

/** BI Adapter：报表口径 -> 日均销量 + 时间窗 */
export class BiAdapter implements Adapter {
  readonly system = 'BI' as const;
  constructor(private backend: MockBackend) {}
  async fetchRaw(skuId: string): Promise<Record<string, unknown>> {
    const raw = this.backend.get(skuId, 'BI');
    if (!raw) return {};
    return raw;
  }
  normalize(_skuId: string, raw: Record<string, unknown>): NormalizedFields {
    const r = raw as unknown as { avg_daily_sales?: number; sales_window_days?: number };
    const fields: NormalizedFields = { skuId: _skuId };
    if (typeof r.avg_daily_sales === 'number') {
      fields.dailyDemand = { value: r.avg_daily_sales, source: 'BI' };
    }
    return fields;
  }
  extractSkuId(raw: Record<string, unknown>): string | undefined {
    const v = raw['sku'];
    return typeof v === 'string' ? v : undefined;
  }
}

/** ERP Adapter：进销存口径 -> 在库/预留/提前期/成本 */
export class ErpAdapter implements Adapter {
  readonly system = 'ERP' as const;
  constructor(private backend: MockBackend) {}
  async fetchRaw(skuId: string): Promise<Record<string, unknown>> {
    return this.backend.get(skuId, 'ERP') ?? {};
  }
  normalize(skuId: string, raw: Record<string, unknown>): NormalizedFields {
    const r = raw as unknown as {
      on_hand_qty?: number;
      reserved_qty?: number;
      lead_time_days?: number;
      unit_cost?: number;
      unit_price?: number;
    };
    const fields: NormalizedFields = { skuId };
    if (typeof r.on_hand_qty === 'number') fields.onHand = { value: r.on_hand_qty, source: 'ERP' };
    if (typeof r.reserved_qty === 'number') fields.reserved = { value: r.reserved_qty, source: 'ERP' };
    if (typeof r.lead_time_days === 'number') fields.leadTimeDays = { value: r.lead_time_days, source: 'ERP' };
    if (typeof r.unit_cost === 'number') fields.cost = { value: r.unit_cost, source: 'ERP' };
    if (typeof r.unit_price === 'number') fields.price = { value: r.unit_price, source: 'ERP' };
    return fields;
  }
  extractSkuId(raw: Record<string, unknown>): string | undefined {
    const v = raw['item_code'];
    return typeof v === 'string' ? v : undefined;
  }
}

/**
 * 库存（WMS）Adapter：仓储口径 -> 在途/安全库存/再订货点。
 * 注：WMS 的 available（可售）与 ERP 的 onHand/reserved 存在「口径重叠」，
 * 此处不重复提供 onHand，避免制造人为冲突；真实场景中该重叠由口径对齐器统一。
 */
export class InventoryAdapter implements Adapter {
  readonly system = 'INVENTORY' as const;
  constructor(private backend: MockBackend) {}
  async fetchRaw(skuId: string): Promise<Record<string, unknown>> {
    return this.backend.get(skuId, 'INVENTORY') ?? {};
  }
  normalize(skuId: string, raw: Record<string, unknown>): NormalizedFields {
    const r = raw as unknown as {
      in_transit?: number;
      safety_stock?: number;
      reorder_point?: number;
    };
    const fields: NormalizedFields = { skuId };
    if (typeof r.in_transit === 'number') fields.inTransit = { value: r.in_transit, source: 'INVENTORY' };
    if (typeof r.safety_stock === 'number') fields.safetyStock = { value: r.safety_stock, source: 'INVENTORY' };
    if (typeof r.reorder_point === 'number') fields.reorderPoint = { value: r.reorder_point, source: 'INVENTORY' };
    return fields;
  }
  extractSkuId(raw: Record<string, unknown>): string | undefined {
    const v = raw['sku_id'];
    return typeof v === 'string' ? v : undefined;
  }
}

/** 销量 Adapter：实时销售口径 -> 日均销量 + 采集时间 */
export class SalesAdapter implements Adapter {
  readonly system = 'SALES' as const;
  constructor(private backend: MockBackend) {}
  async fetchRaw(skuId: string): Promise<Record<string, unknown>> {
    return this.backend.get(skuId, 'SALES') ?? {};
  }
  normalize(skuId: string, raw: Record<string, unknown>): NormalizedFields {
    const r = raw as unknown as { daily_units?: number; as_of?: string };
    const fields: NormalizedFields = { skuId };
    if (typeof r.daily_units === 'number') fields.dailyDemand = { value: r.daily_units, source: 'SALES' };
    if (typeof r.as_of === 'string') fields.asOf = r.as_of;
    return fields;
  }
  extractSkuId(raw: Record<string, unknown>): string | undefined {
    const v = raw['sku'];
    return typeof v === 'string' ? v : undefined;
  }
}

/** 促销 Adapter：活动口径 -> 促销状态 */
export class PromotionAdapter implements Adapter {
  readonly system = 'PROMOTION' as const;
  constructor(private backend: MockBackend) {}
  async fetchRaw(skuId: string): Promise<Record<string, unknown>> {
    return this.backend.get(skuId, 'PROMOTION') ?? {};
  }
  normalize(skuId: string, raw: Record<string, unknown>): NormalizedFields {
    const r = raw as unknown as {
      active?: boolean;
      promo_type?: string;
      multiplier?: number;
      promo_price?: number | null;
      stacked?: boolean;
    };
    const fields: NormalizedFields = { skuId };
    if (r !== undefined && typeof r.active === 'boolean') {
      fields.promotion = {
        value: {
          active: r.active,
          type: toPromoType(r.promo_type ?? 'NONE'),
          demandFactor: r.multiplier ?? 1,
          promoPrice: r.promo_price ?? undefined,
          stacked: r.stacked ?? false
        },
        source: 'PROMOTION'
      };
    }
    return fields;
  }
  extractSkuId(raw: Record<string, unknown>): string | undefined {
    const v = raw['sku'];
    return typeof v === 'string' ? v : undefined;
  }
}

/** 组装全部 Adapter */
export function buildAdapters(backend: MockBackend): Adapter[] {
  return [
    new BiAdapter(backend),
    new ErpAdapter(backend),
    new InventoryAdapter(backend),
    new SalesAdapter(backend),
    new PromotionAdapter(backend)
  ];
}
