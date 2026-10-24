import { sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config.mjs';
import { signingKeys } from './qq.mjs';

const config = loadConfig();
const log = readFileSync(resolve(config.runtime, 'tunnel-error.log'), 'utf8');
const matches = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
if (!matches?.length) throw new Error('临时地址尚未生成。');
const base = matches.at(-1), callback = base + '/qq/webhook';
const keys = signingKeys(config.secret);
const timestamp = String(Math.floor(Date.now() / 1000));
const event = { op: 13, d: { plain_token: 'local-connection-test', event_ts: timestamp } };
const body = JSON.stringify(event);
const headers = {
  'content-type': 'application/json', 'x-bot-appid': config.appId,
  'x-signature-timestamp': timestamp,
  'x-signature-ed25519': sign(null, Buffer.from(timestamp + body), keys.privateKey).toString('hex')
};
const health = await fetch(base + '/health', { signal: AbortSignal.timeout(25_000) });
if (!health.ok || !(await health.json()).ok) throw new Error('公网健康检查失败。');
const response = await fetch(callback, { method: 'POST', headers, body, signal: AbortSignal.timeout(25_000) });
if (!response.ok) throw new Error(`公网签名回调失败：HTTP ${response.status}`);
const result = await response.json();
if (result.plain_token !== event.d.plain_token || !verify(null, Buffer.from(timestamp + result.plain_token), keys.publicKey, Buffer.from(result.signature, 'hex'))) throw new Error('回调挑战签名验证失败。');
const unsigned = await fetch(callback, { method: 'POST', body, signal: AbortSignal.timeout(25_000) });
if (unsigned.status !== 401) throw new Error('无签名请求未被正确拒绝。');
const fileProbe = await fetch(base + '/.env', { signal: AbortSignal.timeout(25_000) });
if (fileProbe.status !== 404) throw new Error('文件路径没有正确返回 404。');
writeFileSync(resolve(config.runtime, 'callback-url.txt'), callback + '\n');
console.log('公网健康检查、签名挑战、拒绝无签名请求和文件隔离：全部通过。');
console.log('QQ 后台回调地址：' + callback);
