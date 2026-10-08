/**
 * 库存数据 JSON Schema：把多系统数据统一到一份字段说明书。
 * 这份 Schema 是 Tool Hub 的数据契约，也是 MCP Tool 的 inputSchema 基座。
 */

export const INVENTORY_SNAPSHOT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'InventorySnapshot',
  type: 'object',
  required: ['skuId', 'window', 'asOf', 'onHand', 'inTransit', 'reserved', 'dailyDemand', 'leadTimeDays', 'safetyStock', 'reorderPoint', 'promotion', 'cost', 'price'],
  properties: {
    skuId: { type: 'string', description: '最小可售规格编号（黑色 M 码 = 一个 skuId）' },
    window: {
      type: 'object',
      required: ['start', 'end'],
      properties: {
        start: { type: 'string', format: 'date' },
        end: { type: 'string', format: 'date' }
      }
    },
    asOf: { type: 'string', format: 'date-time', description: '数据采集时间戳' },
    onHand: { type: 'number', description: '在库数量' },
    inTransit: { type: 'number', description: '在途数量' },
    reserved: { type: 'number', description: '预留（已锁单）数量' },
    dailyDemand: { type: 'number', description: '近 N 日均销量' },
    leadTimeDays: { type: 'number', description: '补货提前期（天）' },
    safetyStock: { type: 'number', description: '安全库存' },
    reorderPoint: { type: 'number', description: '再订货点 ROP' },
    promotion: {
      type: 'object',
      required: ['active', 'type', 'demandFactor', 'stacked'],
      properties: {
        active: { type: 'boolean' },
        type: { type: 'string', enum: ['NONE', 'FULL_REDUCTION', 'FLASH_SALE', 'COUPON', 'BUNDLE'] },
        demandFactor: { type: 'number' },
        promoPrice: { type: 'number' },
        stacked: { type: 'boolean' }
      }
    },
    cost: { type: 'number', description: '单位成本' },
    price: { type: 'number', description: '标准售价' }
  }
} as const;
