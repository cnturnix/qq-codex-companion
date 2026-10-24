import { engineConfig, Settings, discoverNapcat } from './companion-settings.mjs';
import { CodexClient } from './codex.mjs';
import { replySchema, parseDecision } from './companion.mjs';
import { prepareRecords } from './record-storage.mjs';
const config = engineConfig(), records = prepareRecords(config), settings = new Settings(records.text, { tokenRoot: config.runtime });
const found = discoverNapcat(config.root);
console.log('NapCat 消息连接：' + (settings.value.wsUrl ? '手动配置' : found.length === 1 ? '已发现' : found.length > 1 ? '多个连接，请手动指定' : '等待 QQ 登录和 OneBot 配置'));
console.log(`允许范围：${settings.value.allowedGroups.length} 个群，${settings.value.allowedUsers.length} 个好友`);
const codex = new CodexClient(config);
try {
  await codex.start(); console.log('Codex 登录和模型：通过');
  if (process.argv.includes('--smoke')) {
    const room = {};
    const result = await codex.ask(room, JSON.stringify({ task: '本机群友协议测试，不发送到 QQ。请返回 action=reply、interest=normal、messages=[连接成功]、mediaId=空字符串、memory=本机测试、glossary=[] 的 JSON。' }), 90000, { outputSchema: replySchema });
    const decision = parseDecision(result);
    if (decision.action !== 'reply' || !decision.messages.length) throw new Error('决策输出异常。');
    console.log('结构化聊天决策：通过');
    console.log('真实用量事件：' + (room.tokenUsage ? '已收到' : '本次未收到'));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { codex.close(); }
