/**
 * 库存数据 MCP Tool 集合：把取数能力注册成标准化工具。
 * 数据来自 InventoryCatalog（多 Adapter 归一化），走 Tool Registry 授权与裁剪。
 */
import type { ToolDef, ToolContext, ToolResult } from './registry';
import type { InventoryCatalog } from '../adapters/catalog';
import type { TimeWindow } from '../contract/types';
import { INVENTORY_SNAPSHOT_SCHEMA } from '../contract/schema';

function defaultWindow(): TimeWindow {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 3600 * 1000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export function buildInventoryTools(catalog: InventoryCatalog): ToolDef[] {
  const query: ToolDef = {
    name: 'inventory.query',
    description: '查询某 SKU 的归一化库存快照（在库/在途/预留/日均需求/促销状态等）',
    inputSchema: INVENTORY_SNAPSHOT_SCHEMA,
    resourceType: 'sku',
    requiredAction: 'read_inventory',
    async execute(params, _ctx: ToolContext): Promise<ToolResult> {
      const skuId = params.skuId as string;
      const { snapshot, warnings } = await catalog.query(skuId, defaultWindow());
      return { ok: true, data: { snapshot, warnings } };
    }
  };

  const sales: ToolDef = {
    name: 'inventory.sales',
    description: '查询某 SKU 近 N 日销量（日均需求与时间窗）',
    inputSchema: {
      type: 'object',
      required: ['skuId'],
      properties: { skuId: { type: 'string' } }
    },
    resourceType: 'sku',
    requiredAction: 'read_inventory',
    async execute(params, _ctx: ToolContext): Promise<ToolResult> {
      const { snapshot } = await catalog.query(params.skuId as string, defaultWindow());
      return { ok: true, data: { skuId: snapshot.skuId, dailyDemand: snapshot.dailyDemand, window: snapshot.window } };
    }
  };

  const promotion: ToolDef = {
    name: 'inventory.promotion',
    description: '查询某 SKU 的促销状态（是否促销、叠加、促销价、放大系数）',
    inputSchema: {
      type: 'object',
      required: ['skuId'],
      properties: { skuId: { type: 'string' } }
    },
    resourceType: 'sku',
    requiredAction: 'read_inventory',
    async execute(params, _ctx: ToolContext): Promise<ToolResult> {
      const { snapshot } = await catalog.query(params.skuId as string, defaultWindow());
      return { ok: true, data: { skuId: snapshot.skuId, promotion: snapshot.promotion } };
    }
  };

  const supply: ToolDef = {
    name: 'inventory.supply',
    description: '查询某 SKU 的供应侧信息（提前期、在途、成本、供应商）',
    inputSchema: {
      type: 'object',
      required: ['skuId'],
      properties: { skuId: { type: 'string' } }
    },
    resourceType: 'sku',
    requiredAction: 'read_inventory',
    async execute(params, _ctx: ToolContext): Promise<ToolResult> {
      const { snapshot } = await catalog.query(params.skuId as string, defaultWindow());
      return {
        ok: true,
        data: {
          skuId: snapshot.skuId,
          leadTimeDays: snapshot.leadTimeDays,
          inTransit: snapshot.inTransit,
          cost: snapshot.cost
        }
      };
    }
  };

  return [query, sales, promotion, supply];
}
