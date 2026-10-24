import { Agent, request } from 'node:https';
import { Readable } from 'node:stream';

// This agent is used only by image lookup/model downloads, not QQ connections.
export function mediaFetch(proxy = '') {
  const agent = new Agent({ ...(proxy ? { proxyEnv: { HTTPS_PROXY: proxy } } : {}), keepAlive: true });
  return (url, options = {}) => new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password) return reject(Error('需要安全的图片服务地址。'));
    const req = request(target, { agent, method: options.method ?? 'GET', headers: options.headers, signal: options.signal }, res => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(res.headers)) if (value != null) headers.set(key, String(value));
      resolve(new Response(Readable.toWeb(res), { status: res.statusCode, headers }));
    });
    req.on('error', reject); req.end(options.body);
  });
}
export async function smallJson(response, limit = 2 * 1024 * 1024) {
  if (!response.ok) { await response.body?.cancel(); throw Error('图片服务暂不可用（HTTP ' + response.status + '）。'); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw Error('图片服务返回内容过大。'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
