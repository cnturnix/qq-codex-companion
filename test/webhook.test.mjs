import test from 'node:test';
import assert from 'node:assert/strict';
import { sign, verify } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { signingKeys, verifyCallback, challengeResponse, QQClient } from '../src/qq.mjs';
import { createWebhookServer } from '../src/server.mjs';
import { GroupBot } from '../src/bot.mjs';

// Official Tencent reference vector, not a real application credential.
test('Ed25519 matches Tencent reference and rejects modified body', () => {
  const keys = signingKeys('naOC0ocQE3shWLAfffVLB1rhYPG7');
  const body = Buffer.from('{ "op": 0,"d": {}, "t": "GATEWAY_EVENT_NAME"}');
  assert.deepEqual([...keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)], [215,195,98,254,120,174,248,31,242,50,135,180,147,98,139,93,176,42,60,79,227,11,33,94,77,25,96,155,93,118,103,58]);
  // The public-key vector is stable; signatures depend on the exact JSON whitespace.
  const headers = { 'x-signature-timestamp': '1725442341', 'x-signature-ed25519': sign(null, Buffer.concat([Buffer.from('1725442341'), body]), keys.privateKey).toString('hex') };
  assert.ok(verifyCallback(keys, headers, body, 1725442341000));
  assert.equal(verifyCallback(keys, headers, Buffer.from('{}'), 1725442341000), false);
  assert.equal(verifyCallback(keys, headers, body, 1725442941000), false);
});

test('signed challenge succeeds; unsigned challenge cannot become a signing oracle', async () => {
  const config = { secret: 'test-secret', appId: 'test' };
  const keys = signingKeys(config.secret);
  const accepted = [];
  const bot = { metrics: { verifiedCallbacks: 0 }, accept: event => accepted.push(event), failure() {} };
  const server = createWebhookServer(config, bot);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/qq/webhook`;
  try {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const event = { op: 13, d: { plain_token: 'verify-me', event_ts: timestamp } };
    const body = JSON.stringify(event);
    const headers = { 'x-signature-timestamp': timestamp, 'x-signature-ed25519': sign(null, Buffer.from(timestamp + body), keys.privateKey).toString('hex') };
    assert.equal((await fetch(url, { method: 'POST', body })).status, 401);
    const response = await fetch(url, { method: 'POST', body, headers });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.plain_token, 'verify-me');
    assert.ok(verify(null, Buffer.from(timestamp + result.plain_token), keys.publicKey, Buffer.from(result.signature, 'hex')));
    assert.equal(accepted.length, 0);
    assert.deepEqual(challengeResponse(keys, event.d), result);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('QQ tokens are reused; reply uses original message id and one sequence', async () => {
  const calls = [];
  const qq = new QQClient({ appId: 'test', secret: 'test-secret', tokenUrl: 'https://example.invalid/token', apiBase: 'https://example.invalid' }, async (url, options) => {
    calls.push({ url, ...options });
    return new Response(JSON.stringify(url.endsWith('/token') ? { access_token: 'fake', expires_in: 7200 } : {}));
  });
  await Promise.all([qq.token(), qq.token()]);
  await qq.reply('group', 'message', '你好');
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].body), { content: '你好', msg_type: 0, msg_id: 'message', msg_seq: 1 });
});

test('duplicate events do not reply twice and groups have isolated history', async () => {
  const runtime = mkdtempSync(join(resolve('work'), 'qqbot-test-'));
  const replies = [];
  const config = { runtime, allowedGroups: new Set(), model: 'test-model', effort: 'high' };
  const bot = new GroupBot(config, { reply: async (...args) => replies.push(args) }, { ready: false });
  try {
    const command = { t: 'GROUP_AT_MESSAGE_CREATE', d: { group_openid: 'A', id: '1', content: '/状态', author: { id: 'user' } } };
    bot.accept(command); bot.accept(command);
    bot.accept({ t: 'GROUP_MESSAGE_CREATE', d: { group_openid: 'A', id: '2', content: 'A的消息' } });
    bot.accept({ t: 'GROUP_MESSAGE_CREATE', d: { group_openid: 'B', id: '3', content: 'B的消息' } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(replies.length, 1);
    assert.equal(bot.room('A').history[0].text, 'A的消息');
    assert.equal(bot.room('B').history[0].text, 'B的消息');
    assert.equal(new GroupBot(config, {}, {}).state.seen.length, 3);
  } finally { rmSync(runtime, { recursive: true, force: true }); }
});
