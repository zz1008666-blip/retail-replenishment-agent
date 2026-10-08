/**
 * 模拟源系统后端：单机、离线，模拟五套电商系统的「原始」数据。
 * 每个系统的字段命名刻意不同，用于证明「口径不一」这个痛点真实存在。
 */
import type { SourceSystem } from '../contract/types';

/** BI 原始数据：报表口径 */
export interface BiRaw {
  sku: string;
  avg_daily_sales: number;
  sales_window_days: number;
}

/** ERP 原始数据：进销存口径 */
export interface ErpRaw {
  item_code: string;
  on_hand_qty: number;
  reserved_qty: number;
  lead_time_days: number;
  unit_cost: number;
  unit_price: number;
}

/** 库存（WMS）原始数据：仓储口径 */
export interface InventoryRaw {
  sku_id: string;
  available: number;
  in_transit: number;
  safety_stock: number;
  reorder_point: number;
}

/** 销量系统原始数据 */
export interface SalesRaw {
  sku: string;
  daily_units: number;
  window_days: number;
  as_of: string;
}

/** 促销系统原始数据 */
export interface PromotionRaw {
  sku: string;
  active: boolean;
  promo_type: string;
  multiplier: number;
  promo_price: number | null;
  stacked: boolean;
}

/** 各系统原始数据容器 */
export interface BackendData {
  BI?: BiRaw;
  ERP?: ErpRaw;
  INVENTORY?: InventoryRaw;
  SALES?: SalesRaw;
  PROMOTION?: PromotionRaw;
}

/**
 * 模拟后端：按 (skuId, system) 存取原始数据。
 * 测试通过 seed 注入数据，模拟「同一 SKU 在多系统里有不同口径」。
 */
export class MockBackend {
  private store = new Map<string, Record<string, unknown>>();
  private failures = new Map<SourceSystem, number>();

  private key(skuId: string, system: SourceSystem): string {
    return `${system}::${skuId}`;
  }

  put(skuId: string, system: SourceSystem, raw: Record<string, unknown>): void {
    this.store.set(this.key(skuId, system), raw);
  }

  get(skuId: string, system: SourceSystem): Record<string, unknown> | undefined {
    const n = this.failures.get(system) ?? 0;
    if (n > 0) {
      this.failures.set(system, n - 1);
      throw new Error(`${system} 源系统临时不可用（模拟故障）`);
    }
    return this.store.get(this.key(skuId, system));
  }

  /** 注入临时故障：指定系统接下来 N 次读取抛错（模拟工具重试场景） */
  failNext(system: SourceSystem, times = 1): void {
    this.failures.set(system, (this.failures.get(system) ?? 0) + times);
  }

  /** 批量种子：一次把一个 SKU 的多系统数据写入 */
  seed(skuId: string, data: BackendData): void {
    if (data.BI) this.put(skuId, 'BI', data.BI as unknown as Record<string, unknown>);
    if (data.ERP) this.put(skuId, 'ERP', data.ERP as unknown as Record<string, unknown>);
    if (data.INVENTORY) this.put(skuId, 'INVENTORY', data.INVENTORY as unknown as Record<string, unknown>);
    if (data.SALES) this.put(skuId, 'SALES', data.SALES as unknown as Record<string, unknown>);
    if (data.PROMOTION) this.put(skuId, 'PROMOTION', data.PROMOTION as unknown as Record<string, unknown>);
  }

  clear(): void {
    this.store.clear();
  }
}
