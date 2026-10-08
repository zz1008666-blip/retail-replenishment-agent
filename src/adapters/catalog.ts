/**
 * 库存目录：把多个 Adapter 的归一化分片合并为一份快照（含口径告警）。
 */
import type { InventorySnapshot, TimeWindow } from '../contract/types';
import { materialize } from './adapter';
import type { Adapter } from './adapter';

export interface CatalogResult {
  snapshot: InventorySnapshot;
  warnings: import('./adapter').DataQualityWarning[];
}

export class InventoryCatalog {
  constructor(private adapters: Adapter[]) {}

  /** 读取某 SKU 的完整归一化快照 */
  async query(skuId: string, window: TimeWindow): Promise<CatalogResult> {
    const fieldsList = [];
    const mismatchWarnings: import('./adapter').DataQualityWarning[] = [];
    for (const adapter of this.adapters) {
      const raw = await adapter.fetchRaw(skuId);
      const id = adapter.extractSkuId(raw);
      if (id !== undefined && id !== skuId) {
        mismatchWarnings.push({
          field: 'sku_id',
          kind: 'MISMATCH',
          message: `${adapter.system} 返回的 SKU 身份(${id})与查询(${skuId})错配`,
          sources: [adapter.system]
        });
        continue; // 错配数据不参与合并，防止用错数据
      }
      fieldsList.push(adapter.normalize(skuId, raw));
    }
    const { snapshot, warnings } = materialize(skuId, window, fieldsList);
    warnings.push(...mismatchWarnings);
    return { snapshot, warnings };
  }
}
