/**
 * Runner 面向的工具集：与进程内 ToolRegistry 一致，但多注册一个
 * `memory.recall_cases`，让 Runner 通过 IPC 召回历史案例（Runner 不连 DB）。
 *
 * 这组工具只在四层架构的 Backend 侧使用，不污染 src/app.ts 的进程内注册表，
 * 因此 eval 套件的「session 工具面裁剪」断言不受影响。
 */
import type { ToolDef, ToolResult, ToolContext } from '../tools/registry';
import { ToolRegistry } from '../tools/registry';
import type { InventoryCatalog } from '../adapters/catalog';
import type { CaseStore } from '../memory/case';
import type { Acl } from '../acl';
import { buildInventoryTools } from '../tools/inventory-tools';

export function buildRunnerTools(
  acl: Acl,
  catalog: InventoryCatalog,
  caseStore: CaseStore
): ToolRegistry {
  const registry = new ToolRegistry(acl);
  for (const t of buildInventoryTools(catalog)) registry.register(t);

  const recall: ToolDef = {
    name: 'memory.recall_cases',
    description: '召回某个 SKU 相似的历史处置案例（FTS5 相似度检索）',
    inputSchema: {
      type: 'object',
      required: ['skuId'],
      properties: {
        skuId: { type: 'string' },
        keyword: { type: 'string' },
        limit: { type: 'number' }
      }
    },
    resourceType: 'sku',
    requiredAction: 'read_inventory',
    async execute(params, _ctx: ToolContext): Promise<ToolResult> {
      const skuId = params['skuId'] as string;
      const keyword = params['keyword'] as string | undefined;
      const limit = (params['limit'] as number | undefined) ?? 10;
      const cases = caseStore.recall(skuId, { keyword, limit });
      return { ok: true, data: { cases } };
    }
  };
  registry.register(recall);
  return registry;
}