import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config.mjs';
import { QQClient } from './qq.mjs';
import { CodexClient } from './codex.mjs';
import { GroupBot } from './bot.mjs';
import { createWebhookServer } from './server.mjs';

const config = loadConfig();
const qq = new QQClient(config), codex = new CodexClient(config);
const bot = new GroupBot(config, qq, codex);
const server = createWebhookServer(config, bot);
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.on('error', error => { console.error('服务无法启动：', error.code); process.exitCode = 1; });
server.listen(config.port, '127.0.0.1', () => console.log(`QQ 回调服务已启动：http://127.0.0.1:${config.port}/qq/webhook`));
void qq.token().then(() => console.log('QQ 凭证验证通过。')).catch(error => bot.failure(error.message));
void codex.start().then(() => console.log('Codex 已连接，模型可用。')).catch(error => bot.failure(error.message));
const statusTimer = setInterval(() => {
  writeFileSync(resolve(config.runtime, 'status.json'), JSON.stringify({
    updatedAt: new Date().toISOString(), codexReady: Boolean(codex.ready), model: config.model,
    groupCount: Object.keys(bot.state.rooms).length, activeTasks: bot.workers, ...bot.metrics
  }, null, 2));
}, 2000);
const shutdown = () => { clearInterval(statusTimer); codex.close(); server.close(); setTimeout(() => process.exit(), 1000).unref(); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
