import http from 'node:http';
import { signingKeys, verifyCallback, challengeResponse } from './qq.mjs';

export function createWebhookServer(config, bot) {
  const keys = signingKeys(config.secret);
  return http.createServer(async (request, response) => {
    const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); };
    const path = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'GET' && path === '/health') return send(200, { ok: true });
    if (request.method !== 'POST' || path !== '/qq/webhook') return send(404, { error: 'Not found' });
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 256 * 1024) return send(413, { error: 'Too large' });
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      if (!verifyCallback(keys, request.headers, raw)) return send(401, { error: 'Invalid signature' });
      const event = JSON.parse(raw.toString('utf8'));
      const appId = request.headers['x-bot-appid'];
      if (appId && appId !== config.appId) return send(403, { error: 'Wrong app' });
      bot.metrics.verifiedCallbacks++;
      if (event.op === 13) return send(200, challengeResponse(keys, event.d));
      if (event.op === 0) bot.accept(event);
      // QQ receives its ACK immediately, without waiting for AI generation.
      return send(200, { op: 12 });
    } catch (error) {
      if (error instanceof SyntaxError) return send(400, { error: 'Invalid JSON' });
      bot.failure('回调处理失败');
      return send(500, { error: 'Internal error' });
    }
  });
}
