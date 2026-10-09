/**
 * Client 层 · serve 命令：拉起四层架构的本地服务。
 *
 * 步骤：
 *   1. 造 4 个演示 SKU（覆盖缺货 / 积压 / 促销 / 促销跌破安全库存）
 *   2. 给 demo-operator 授权这些 SKU 的 read/advise/execute
 *   3. createApp（真相源）→ createBackend（fork Runner）→ startHttpServer + Web 面板
 *   4. 阻塞保持存活，直到 Ctrl+C
 */
import { createApp } from '../app';
import { createBackend } from '../backend';
import { startHttpServer } from '../backend/server';
import { WEB_PANEL_HTML } from './web-panel';

interface DemoSku {
  id: string;
  seed: Record<string, Record<string, unknown>>;
}

const DEMO_SKUS: DemoSku[] = [
  {
    id: 'SKU-DEMO-1',
    seed: {
      BI: { sku: 'SKU-DEMO-1', avg_daily_sales: 25, sales_window_days: 7 },
      ERP: { item_code: 'SKU-DEMO-1', on_hand_qty: 40, reserved_qty: 8, lead_time_days: 5, unit_cost: 30, unit_price: 59 },
      INVENTORY: { sku_id: 'SKU-DEMO-1', available: 32, in_transit: 10, safety_stock: 40, reorder_point: 120 },
      SALES: { sku: 'SKU-DEMO-1', daily_units: 25, window_days: 7, as_of: new Date().toISOString() },
      PROMOTION: { sku: 'SKU-DEMO-1', active: false, promo_type: 'NONE', multiplier: 1, promo_price: null, stacked: false }
    }
  },
  {
    id: 'SKU-DEMO-2',
    seed: {
      BI: { sku: 'SKU-DEMO-2', avg_daily_sales: 10, sales_window_days: 7 },
      ERP: { item_code: 'SKU-DEMO-2', on_hand_qty: 2000, reserved_qty: 0, lead_time_days: 5, unit_cost: 40, unit_price: 79 },
      INVENTORY: { sku_id: 'SKU-DEMO-2', available: 2000, in_transit: 0, safety_stock: 40, reorder_point: 100 },
      SALES: { sku: 'SKU-DEMO-2', daily_units: 10, window_days: 7, as_of: new Date().toISOString() },
      PROMOTION: { sku: 'SKU-DEMO-2', active: false, promo_type: 'NONE', multiplier: 1, promo_price: null, stacked: false }
    }
  },
  {
    id: 'SKU-DEMO-3',
    seed: {
      BI: { sku: 'SKU-DEMO-3', avg_daily_sales: 20, sales_window_days: 7 },
      ERP: { item_code: 'SKU-DEMO-3', on_hand_qty: 300, reserved_qty: 0, lead_time_days: 5, unit_cost: 25, unit_price: 49 },
      INVENTORY: { sku_id: 'SKU-DEMO-3', available: 300, in_transit: 0, safety_stock: 40, reorder_point: 120 },
      SALES: { sku: 'SKU-DEMO-3', daily_units: 20, window_days: 7, as_of: new Date().toISOString() },
      PROMOTION: { sku: 'SKU-DEMO-3', active: true, promo_type: 'FLASH_SALE', multiplier: 2, promo_price: 45, stacked: false }
    }
  },
  {
    id: 'SKU-DEMO-4',
    seed: {
      BI: { sku: 'SKU-DEMO-4', avg_daily_sales: 15, sales_window_days: 7 },
      ERP: { item_code: 'SKU-DEMO-4', on_hand_qty: 30, reserved_qty: 0, lead_time_days: 5, unit_cost: 35, unit_price: 69 },
      INVENTORY: { sku_id: 'SKU-DEMO-4', available: 30, in_transit: 0, safety_stock: 40, reorder_point: 100 },
      SALES: { sku: 'SKU-DEMO-4', daily_units: 15, window_days: 7, as_of: new Date().toISOString() },
      PROMOTION: { sku: 'SKU-DEMO-4', active: true, promo_type: 'FULL_REDUCTION', multiplier: 1.5, promo_price: 30, stacked: true }
    }
  }
];

export async function cmdServe(port = 4610): Promise<{ url: string }> {
  const fs = await import('node:fs');
  fs.mkdirSync('data', { recursive: true });
  const app = createApp({ dbPath: 'data/app.db' });

  // 造数据 + 授权
  for (const sku of DEMO_SKUS) {
    app.backend.seed(sku.id, sku.seed as never);
    for (const p of ['read', 'advise', 'execute'] as const) {
      app.grants.grant('demo-operator', 'sku', sku.id, p);
    }
  }

  const backend = await createBackend(app, {
    workspaceRoot: 'workspaces',
    onLog: (line) => console.log(line)
  });

  const handle = await startHttpServer(backend, { port, webHtml: WEB_PANEL_HTML });
  console.log('四层架构已启动：' + handle.url);
  console.log('  Client    → Web 面板（浏览器打开 ' + handle.url + '）');
  console.log('  Backend   → HTTP + SQLite 真相源');
  console.log('  Runner → fork 子进程 agent-loop（stdio JSON-RPC）');
  console.log('  Workspace → workspaces/<runId> 隔离目录');
  console.log('\n按 Ctrl+C 退出。');

  // 阻塞保持存活；收到退出信号时优雅关闭
  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      await backend.close();
      await handle.close();
      resolve();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });

  return { url: handle.url };
}