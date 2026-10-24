import { writeFileSync, openSync, closeSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { engineConfig, Settings, discoverNapcat } from './companion-settings.mjs';
import { OneBotClient } from './onebot.mjs';
import { CodexClient } from './codex.mjs';
import { Companion } from './companion.mjs';
import { createConsole } from './console-server.mjs';
import { prepareRecords } from './record-storage.mjs';
import { MediaLibrary } from './media-library.mjs';

const config = engineConfig();
const lockFile = resolve(config.runtime, 'instance.lock');
if (existsSync(lockFile)) {
  const pid = Number(readFileSync(lockFile, 'utf8'));
  let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
  if (alive) throw new Error('群友机器人已在运行，请打开已有管理页面。');
  unlinkSync(lockFile);
}
const lock = openSync(lockFile, 'wx'); writeFileSync(lock, String(process.pid)); closeSync(lock);
const records = prepareRecords(config);
const settings = new Settings(records.text, { tokenRoot: config.runtime });
const qq = new OneBotClient(() => {
  if (settings.value.wsUrl) return { wsUrl: settings.value.wsUrl, accessToken: settings.value.accessToken };
  const found = discoverNapcat(config.root);
  if (found.length > 1) throw new Error('发现多个 QQ 连接，请在管理页面指定连接地址。');
  return found[0];
});
const codex = new CodexClient(config);
const media = new MediaLibrary(config, settings, codex, { log: message => bot.log(message) });
media.qq = qq;
const bot = new Companion(config, settings, qq, codex, { media });
try {
  const { CompanionCore } = await import('./companion-core/core.mjs');
  bot.core = new CompanionCore(config, settings, codex, bot);
  media.onBackgroundStart = () => bot.core.preempt('media_priority');
} catch { bot.log('新记忆服务初始化失败，已降级为原有群友功能'); }
qq.on('message', event => { void bot.accept(event); });
qq.on('ready', () => bot.log(bot.bindAccount(qq.identity.id) ? 'QQ 小号已连接' : '当前 QQ 与记忆所属账号不同，已暂停聊天，请切回原账号'));
const server = createConsole(settings, bot, qq);
server.requestTimeout = 15000; server.headersTimeout = 10000;
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return; shuttingDown = true;
  await bot.close();
  const coreClosed = bot.core?.close().catch(() => bot.log('新记忆存储关闭未完成，重启时将恢复任务'));
  await media.close(); qq.close(); codex.close(); server.close(); await coreClosed;
  setTimeout(() => process.exit(), 800).unref();
};
process.on('exit', () => { try { if (readFileSync(lockFile, 'utf8') === String(process.pid)) unlinkSync(lockFile); } catch {} });
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '管理页面端口被占用，请先停止旧实例。' : '管理页面启动失败。'); void shutdown(); process.exitCode = 1; });
server.listen(settings.value.consolePort, '127.0.0.1', () => {
  const base = `http://127.0.0.1:${settings.value.consolePort}`;
  writeFileSync(resolve(config.runtime, 'console-url.txt'), `${base}/#token=${settings.token}`, { mode: 0o600 });
  console.log(`群友管理页面：${base}（完整管理入口保存在 runtime/napcat/console-url.txt）`);
  qq.start();
  bot.start();
  bot.core?.start();
  void codex.start().then(() => { bot.log('Codex 登录和模型检查通过'); media.start(qq); }).catch(error => bot.log(error.message));
});
