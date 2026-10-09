/**
 * Backend 的 HTTP 服务：REST API + Web 面板。
 *
 * 对应分层架构的 Hono 服务入口，但零依赖手搓（node:http）。
 * 提供四个端点：
 *   GET  /health                → 四层架构存活探针
 *   GET  /api/v1/runs           → 已产生的巡检记录摘要
 *   POST /api/v1/inspect        → 触发一次巡检（走 Runner 子进程）
 *   GET  /api/v1/decision/:id   → 某次巡检的决策
 *   GET  /api/v1/trace/:id      → 某次巡检的流式事件轨迹
 *   GET  /                      → Web 面板
 */
import http from 'node:http';
import type { Backend } from './index';
import type { Principal } from '../acl';

export interface HttpServerOptions {
  port?: number;
  host?: string;
  /** Web 面板 HTML（由 client/web-panel 提供，若缺省则返回纯文本提示） */
  webHtml?: string;
}

export interface HttpServerHandle {
  server: http.Server;
  url: string;
  port: number;
  close(): Promise<void>;
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body) as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

export function startHttpServer(
  backend: Backend,
  opts: HttpServerOptions = {}
): Promise<HttpServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 4610;
  const webHtml = opts.webHtml ?? '';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`);
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    try {
      if (method === 'GET' && pathname === '/health') {
        return sendJson(res, 200, {
          ok: true,
          service: 'retail-replenishment-agent',
          layers: ['client', 'backend', 'runner', 'workspace']
        });
      }

      if (method === 'GET' && pathname === '/api/v1/runs') {
        return sendJson(
          res,
          200,
          backend.records().map((r) => ({
            runId: r.runId,
            skuId: r.skuId,
            anomaly: r.decision.anomaly,
            advice: r.decision.advice
          }))
        );
      }

      if (method === 'POST' && pathname === '/api/v1/inspect') {
        const body = await readJsonBody(req);
        const skuId = String(body['skuId'] ?? '');
        const principalId = String(body['principalId'] ?? 'demo-operator');
        if (!skuId) return sendJson(res, 400, { ok: false, error: '缺少 skuId' });
        const principal: Principal = { id: principalId, role: 'operator' };
        const record = await backend.inspect(skuId, principal, {
          id: 'web-session',
          skuIds: [skuId]
        });
        return sendJson(res, 200, {
          ok: true,
          runId: record.runId,
          skuId: record.skuId,
          decision: record.decision
        });
      }

      const decisionMatch = pathname.match(/^\/api\/v1\/decision\/([a-zA-Z0-9_-]+)$/);
      if (method === 'GET' && decisionMatch) {
        const decision = backend.decision(decisionMatch[1]);
        if (!decision) return sendJson(res, 404, { ok: false, error: 'decision 不存在' });
        return sendJson(res, 200, { ok: true, decision });
      }

      const traceMatch = pathname.match(/^\/api\/v1\/trace\/([a-zA-Z0-9_-]+)$/);
      if (method === 'GET' && traceMatch) {
        return sendJson(res, 200, { ok: true, events: backend.trace(traceMatch[1]) });
      }

      if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(webHtml || '<h1>retail-replenishment-agent</h1><p>Web 面板未注入</p>');
      }

      sendJson(res, 404, { ok: false, error: `未找到 ${method} ${pathname}` });
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        server,
        port: actualPort,
        url: `http://${host}:${actualPort}`,
        close: () =>
          new Promise<void>((res2) => {
            server.close(() => res2());
          })
      });
    });
  });
}