import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function loadConfig() {
  const values = {};
  for (const raw of readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i > 0) values[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  const value = (key, fallback = '') => process.env[key] ?? values[key] ?? fallback;
  const config = {
    appId: value('QQ_APP_ID'), secret: value('QQ_APP_SECRET'),
    apiBase: value('QQ_API_BASE', 'https://api.bot.qq.com'),
    tokenUrl: value('QQ_TOKEN_URL', 'https://api.bot.qq.com/app/getAppAccessToken'),
    port: Number(value('PORT', '8787')),
    model: value('CODEX_MODEL', 'gpt-6.1-sol'), effort: value('CODEX_REASONING', 'high'),
    codexBin: value('CODEX_BIN', 'codex'),
    codexProxy: value('CODEX_PROXY'),
    allowedGroups: new Set(value('QQ_ALLOWED_GROUPS').split(',').map(x => x.trim()).filter(Boolean)),
    runtime: resolve(root, 'runtime'), root
  };
  if (!config.appId || !config.secret) throw new Error('请先在 .env 填写 QQ 应用凭证。');
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('PORT 必须是 1024–65535 的整数。');
  mkdirSync(config.runtime, { recursive: true });
  return config;
}
