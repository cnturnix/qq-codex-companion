import { loadConfig } from './config.mjs';
import { QQClient } from './qq.mjs';
import { CodexClient } from './codex.mjs';

const config = loadConfig();
const codex = new CodexClient(config);
try {
  await new QQClient(config).token();
  console.log('QQ 凭证：通过');
  await codex.start();
  console.log('Codex 登录与模型：通过');
  if (process.argv.includes('--smoke')) {
    const room = {};
    const answer = await codex.ask(room, '这是本机机器人连接测试。请只回复“连接成功”，不要调用工具。', 90_000);
    console.log('本机生成测试：', answer.slice(0, 80));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { codex.close(); }
