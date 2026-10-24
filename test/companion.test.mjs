import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { Script } from 'node:vm';
import { Settings, discoverNapcat } from '../src/companion-settings.mjs';
import { Companion, parseDecision } from '../src/companion.mjs';
import { OneBotClient } from '../src/onebot.mjs';
import { createConsole } from '../src/console-server.mjs';

const answer = (action = 'reply', memory = '本群喜欢聊游戏', interest = 'normal') => JSON.stringify({ action, interest, messages: action === 'reply' ? ['你好呀'] : [], memory, glossary: [{ term: '开黑', meaning: '一起组队玩游戏' }] });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, patch = {}) {
  mkdirSync(resolve('work'), { recursive: true });
  const runtime = mkdtempSync(join(resolve('work'), 'companion-test-'));
  const settings = new Settings(runtime); settings.update({ allowedGroups: ['11111', '22222'], allowedUsers: ['33333'], ownerQQ: '55555', mode: 'chat', ...patch });
  const sends = [], asks = [], calls = [], history = new Map(); let time = 1000000, randomValue = 0.5;
  const qq = { identity: { id: '99999', name: 'Test Bot' }, connected: true,
    send: async (...args) => { sends.push(args); return { message_id: 'sent-' + sends.length }; },
    call: async (action, params) => { calls.push({ action, params }); return action === 'get_group_msg_history' ? { messages: history.get(params.group_id) ?? [] } : { group_id: 11111, sender: { user_id: 88888 }, message: [{ type: 'text', data: { text: '另一位群友说的话' } }] }; },
    status: () => ({ connected: true }), reconnect() {} };
  const codex = { ready: true, interrupt: async () => {}, ask: async (room, prompt) => { asks.push(JSON.parse(prompt)); room.threadId ||= 'thread-test'; return answer(); } };
  const config = { runtime, model: 'test-model', effort: 'high' };
  const bot = new Companion(config, settings, qq, codex, { now: () => time, random: () => randomValue });
  t.after(async () => { await bot.close(); for (let i = 0; i < 100 && bot.running.size; i++) await tick(); rmSync(runtime, { recursive: true, force: true }); });
  return { bot, settings, qq, codex, asks, sends, calls, history, config, runtime, now: () => time, advance: n => { time += n; }, random: n => { randomValue = n; } };
}
function msg(id, text, { group = 11111, sender = 33333, at = true, reply, role = 'member', privateChat = false } = {}) {
  return { post_type: 'message', message_type: privateChat ? 'private' : 'group', group_id: group, user_id: sender, self_id: 99999, message_id: id, sender: { nickname: '群友', role }, message: [...(at ? [{ type: 'at', data: { qq: '99999' } }] : []), ...(reply ? [{ type: 'reply', data: { id: reply } }] : []), { type: 'text', data: { text } }] };
}
async function flush(bot) {
  for (const timer of bot.timers.values()) clearTimeout(timer); bot.timers.clear(); bot.drain();
  for (let i = 0; i < 100 && bot.running.size; i++) await tick();
}
function historyAt(time, count = 50, options = {}) {
  return Array.from({ length: count }, (_, i) => ({ ...msg('h' + i, '历史消息' + i, { at: false, ...options }), time: (time - (count - i - 1) * 1000) / 1000 }));
}
function nextCheck(f) { f.advance(f.bot.room('group', '11111').nextCheckAt - f.now()); }
test('two-second active cooldown is accepted, persisted and enforced at the boundary', t => {
  const f = fixture(t, { mode: 'social', cooldownSeconds: 2 });
  const room = f.bot.room('group', '11111'); room.activeUntil = f.now() + 60000; room.lastReplyAt = f.now();
  room.history.push({ seq: 1, sender: '33333', time: f.now(), text: '继续聊' });
  f.advance(1999); assert.equal(f.bot.socialEligible(room, 'active'), false);
  f.advance(1); assert.equal(f.bot.socialEligible(room, 'active'), true);
  assert.equal(new Settings(f.runtime).value.cooldownSeconds, 2);
  assert.throws(() => f.settings.update({ cooldownSeconds: 1 }));
});
test('empty allowlists ignore messages without storing them or calling the model', async t => {
  const f = fixture(t, { allowedGroups: [], allowedUsers: [] });
  await f.bot.accept(msg(1, '你好')); await f.bot.accept(msg(2, '你好', { privateChat: true }));
  assert.equal(Object.keys(f.bot.state.rooms).length, 0); assert.equal(f.asks.length, 0);
});

test('private allowlist changes create manageable rooms and direct replies bypass social limits', async t => {
  const f = fixture(t, { mode: 'social', allowedUsers: [], activeReplyChance: 0, checkinReplyChance: 0, cooldownSeconds: 3600, maxRepliesPerHour: 1 });
  await f.bot.accept(msg('blocked', '你好', { privateChat: true, at: false }));
  assert.equal(f.bot.state.rooms['private:33333'], undefined);
  const previous = f.settings.value; f.settings.update({ allowedUsers: ['33333'] }); await f.bot.settingsChanged(previous);
  const room = f.bot.state.rooms['private:33333']; assert.ok(room);
  assert.equal(f.bot.presence(room).phase, '私聊消息直接回复');
  room.lastReplyAt = f.now(); room.socialReplyTimes = [f.now()];
  await f.bot.accept(msg('direct', '你好', { privateChat: true, at: false })); await flush(f.bot);
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0][0], 'private'); assert.equal(f.sends[0][1], '33333'); assert.equal(f.asks[0].direct, true);
  assert.equal(f.calls.length, 0); assert.equal(room.nextCheckAt, 0);
  const enabled = f.settings.value; f.settings.update({ allowedUsers: [] }); await f.bot.settingsChanged(enabled);
  await f.bot.accept(msg('blocked-again', '不要保存我', { privateChat: true, at: false })); await flush(f.bot);
  assert.equal(f.sends.length, 1); assert.ok(!room.history.some(m => m.id === 'blocked-again'));
});

test('private text uses at most 30 recent records, respects silent mode and has an appropriate failure reply', async t => {
  const f = fixture(t); const room = f.bot.room('private', '33333');
  room.history = Array.from({ length: 45 }, (_, i) => ({ id: 'old-' + i, sender: '33333', name: '朋友', text: '旧消息', seq: i + 1, time: f.now() })); room.seq = 45;
  await f.bot.accept(msg('new', '继续', { privateChat: true, at: false })); await flush(f.bot);
  assert.equal(f.asks[0].recentMessages.length, 30);
  f.codex.ask = async () => { throw Error('模型生成失败'); };
  await f.bot.accept(msg('failed', '在吗', { privateChat: true, at: false })); await flush(f.bot);
  assert.match(f.sends.at(-1)[2], /收到你的消息/); assert.ok(!f.sends.at(-1)[2].includes('@'));
  f.settings.update({ mode: 'silent' });
  await f.bot.accept(msg('silent', '在吗', { privateChat: true, at: false })); await flush(f.bot);
  assert.equal(f.sends.length, 2);
});

test('private quote lookup cannot import a bot reply from a different recipient', async t => {
  const f = fixture(t); f.qq.call = async () => ({ message_type: 'private', sender: { user_id: 99999 }, target_id: 44444, message: [{ type: 'text', data: { text: '其他人的秘密' } }] });
  await f.bot.accept(msg('unsafe', '这是什么意思', { privateChat: true, at: false, reply: 'external' })); await flush(f.bot);
  assert.equal(JSON.stringify(f.asks[0]).includes('其他人的秘密'), false);
  f.qq.call = async () => ({ message_type: 'private', sender: { user_id: 99999 }, target_id: 33333, message: [{ type: 'text', data: { text: '同一私聊的内容' } }] });
  await f.bot.accept(msg('safe', '这是什么意思', { privateChat: true, at: false, reply: 'verified' })); await flush(f.bot);
  assert.equal(f.asks.at(-1).directedMessages[0].quote.text, '同一私聊的内容');
});

test('friend discovery is authenticated and does not grant access or send messages', async t => {
  const f = fixture(t, { allowedUsers: [] }); const server = createConsole(f.settings, f.bot, f.qq);
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  f.qq.call = async action => { assert.equal(action, 'get_friend_list'); return [{ user_id: 33333, nickname: '<img onerror=alert(1)>', remark: '我的朋友', unrelated: '不得返回' }, { user_id: 'bad' }]; };
  assert.equal((await fetch(base + '/api/friends')).status, 401);
  const response = await fetch(base + '/api/friends', { headers: { Authorization: 'Bearer ' + f.settings.token } });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { friends: [{ id: '33333', name: '我的朋友' }] });
  assert.deepEqual(f.settings.value.allowedUsers, []); assert.equal(f.sends.length, 0);
});
test('group and private namespaces, memory and prompts stay isolated', async t => {
  const f = fixture(t);
  await f.bot.accept(msg(1, '群A的内容')); await flush(f.bot);
  await f.bot.accept(msg(2, '群B的内容', { group: 22222 })); await flush(f.bot);
  await f.bot.accept(msg(3, '私聊内容', { privateChat: true })); await flush(f.bot);
  assert.equal(f.asks.length, 3);
  assert.equal(f.asks[1].recentMessages.some(m => m.text.includes('群A')), false);
  assert.equal(f.asks[2].room.memory, ''); assert.equal(Object.keys(f.bot.state.rooms).length, 3);
});
test('duplicates and self messages never produce duplicate replies', async t => {
  const f = fixture(t); const event = msg(1, '你好');
  await Promise.all([f.bot.accept(event), f.bot.accept(event)]); await flush(f.bot);
  await f.bot.accept(msg(2, '自己的消息', { sender: 99999 }));
  assert.equal(f.sends.length, 1); assert.equal(f.bot.state.metrics.received, 1);
});

test('a random mention request uses the real roster and sends structured mentions without CQ text', async t => {
  const f = fixture(t); f.qq.call = async () => [{ user_id: 99999 }, { user_id: 33333 }, { user_id: 44444 }];
  f.codex.ask = async (room, prompt) => { f.asks.push(JSON.parse(prompt)); return JSON.stringify({ ...JSON.parse(answer()), mention: { mode: 'random', targets: [] }, messages: ['[CQ:at,qq=55555] 随机点名，抽到你了。'] }); };
  await f.bot.accept(msg(1, '你@一下群里的随便一个人')); await flush(f.bot);
  assert.equal(f.sends.length, 1); assert.deepEqual(f.sends[0][4], ['44444']); assert.equal(f.sends[0][2], '随机点名，抽到你了。');
  assert.match(f.asks[0].mentionRules, /真实/);
  assert.deepEqual(f.bot.room('group', '11111').history.at(-1).mentions, ['44444']);
});

test('member lookup failure reports the problem instead of pretending a mention was sent', async t => {
  const f = fixture(t); f.qq.call = async () => { throw Error('offline'); };
  f.codex.ask = async () => JSON.stringify({ ...JSON.parse(answer()), mention: { mode: 'selected', targets: ['33333'] }, messages: ['已经叫到他了'] });
  await f.bot.accept(msg(1, '叫一下他')); await flush(f.bot);
  assert.equal(f.sends.length, 1); assert.match(f.sends[0][2], /没能发出/); assert.deepEqual(f.sends[0][4], []);
});

test('cancellation during member lookup suppresses the mention', async t => {
  const f = fixture(t); let release;
  f.qq.call = () => new Promise(resolve => { release = resolve; });
  f.codex.ask = async () => JSON.stringify({ ...JSON.parse(answer()), mention: { mode: 'random', targets: [] } });
  await f.bot.accept(msg(1, '随机叫一个人')); await flush(f.bot); await f.bot.stop('group:11111');
  release([{ user_id: 33333 }]); await flush(f.bot); assert.equal(f.sends.length, 0);
});
test('chat mode remembers ordinary messages but responds only when addressed', async t => {
  const f = fixture(t);
  await f.bot.accept(msg(1, '今天想玩游戏', { at: false })); await flush(f.bot); assert.equal(f.asks.length, 0);
  await f.bot.accept(msg(2, '小柚一起吗', { at: false })); await flush(f.bot);
  assert.equal(f.asks.length, 1); assert.equal(f.asks[0].recentMessages.length, 2);
});
test('referencing another user does not count as addressing the bot', async t => {
  const f = fixture(t);
  await f.bot.accept(msg(1, '是的', { at: false, reply: '100' })); await flush(f.bot);
  assert.equal(f.asks.length, 0);
  f.qq.call = async () => ({ group_id: 11111, sender: { user_id: 99999 }, message: [{ type: 'text', data: { text: '机器人的上一句话' } }] });
  await f.bot.accept(msg(2, '继续说', { at: false, reply: '101' })); await flush(f.bot); assert.equal(f.asks.length, 1);
});
test('resting groups do not retain ordinary content, inspect quotes, or call the model', async t => {
  const f = fixture(t, { mode: 'social' });
  for (let i = 0; i < 30; i++) await f.bot.accept(msg(i, '小柚看我', { at: false, reply: 'external' }));
  await flush(f.bot);
  assert.equal(f.bot.room('group', '11111').history.length, 0);
  assert.equal(f.bot.state.seen.length, 0); assert.equal(f.bot.state.metrics.received, 0);
  assert.equal(f.asks.length, 0); assert.equal(f.calls.length, 0);
});
test('scheduled wake-up reads at most 50 recent messages and rolls once at 37 percent', async t => {
  const f = fixture(t, { mode: 'social', allowedGroups: ['11111'] });
  await f.bot.checkPresence(); assert.equal(f.calls.length, 0);
  nextCheck(f); f.history.set('11111', historyAt(f.now(), 60)); f.random(0.369);
  await f.bot.checkPresence(); await flush(f.bot);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].params.count, 50);
  assert.equal(f.asks[0].recentMessages.length, 50); assert.equal(f.asks[0].recentMessages[0].id, 'h10');
  assert.equal(f.sends.length, 1); assert.equal(f.bot.room('group', '11111').lastCheckDecision.chance, 37);
  await f.bot.checkPresence(); await flush(f.bot); assert.equal(f.asks.length, 1);
  nextCheck(f); f.history.set('11111', historyAt(f.now())); f.random(0.37);
  await f.bot.checkPresence(); await flush(f.bot);
  assert.equal(f.sends.length, 1); assert.equal(f.bot.presence(f.bot.room('group', '11111')).phase, '间歇中');
});
test('quiet wake-up skips generation, then ignores new ordinary messages until the next check', async t => {
  const f = fixture(t, { mode: 'social', allowedGroups: ['11111'] });
  nextCheck(f); f.history.set('11111', historyAt(f.now() - 61000));
  await f.bot.checkPresence(); await flush(f.bot); assert.equal(f.asks.length, 0);
  const room = f.bot.room('group', '11111'), snapshot = JSON.stringify(room.history);
  await f.bot.accept(msg('new', '现在有人说话', { at: false })); await flush(f.bot);
  assert.equal(JSON.stringify(room.history), snapshot); assert.equal(f.calls.length, 1);
  nextCheck(f); f.history.set('11111', historyAt(f.now(), 1, { sender: 99999 }));
  await f.bot.checkPresence(); await flush(f.bot); assert.equal(f.asks.length, 0);
});
test('exactly 60-second-old history is eligible; missing timestamps are not fresh activity', async t => {
  const f = fixture(t, { mode: 'social', allowedGroups: ['11111'], checkinReplyChance: 100 });
  nextCheck(f); f.history.set('11111', historyAt(f.now() - 60000, 1));
  await f.bot.checkPresence(); await flush(f.bot); assert.equal(f.sends.length, 1);
  nextCheck(f); f.history.set('11111', [msg('missing', '无时间', { at: false })]);
  await f.bot.checkPresence(); await flush(f.bot); assert.equal(f.sends.length, 1);
});
test('interest adjusts first reply probability, with neutral fallback and configurable values', async t => {
  const f = fixture(t, { mode: 'social', allowedGroups: ['11111'] });
  for (const [interest, adjustment, chance, expected] of [['high', true, 55.5, true], ['low', true, 18.5, false], ['unknown', true, 37, false], ['high', false, 37, false]]) {
    f.settings.update({ interestAdjustment: adjustment });
    nextCheck(f); f.history.set('11111', historyAt(f.now())); f.random(0.5);
    f.codex.ask = async () => answer('reply', '', interest);
    const before = f.sends.length;
    await f.bot.checkPresence(); await flush(f.bot);
    assert.equal(f.bot.room('group', '11111').lastCheckDecision.chance, chance);
    assert.equal(f.sends.length > before, expected);
  }
  f.settings.update({ interestAdjustment: true, lowInterestReplyChance: 70.5 });
  nextCheck(f); f.history.set('11111', historyAt(f.now())); f.codex.ask = async () => answer('reply', '', 'low');
  await f.bot.checkPresence(); await flush(f.bot); assert.equal(f.bot.room('group', '11111').lastCheckDecision.chosen, true);
});
test('@ alone wakes with 30 messages and bypasses probability, cooldown, cap and model silence', async t => {
  const f = fixture(t, { mode: 'social', allowedGroups: ['11111'], checkinReplyChance: 0, lowInterestReplyChance: 0, highInterestReplyChance: 0, activeReplyChance: 0, maxRepliesPerHour: 1 });
  f.history.set('11111', historyAt(f.now(), 50));
  const room = f.bot.room('group', '11111'); room.socialReplyTimes = [f.now()]; room.lastReplyAt = f.now();
  room.lastCheckDecision = { at: f.now(), chosen: false, chance: 0, interest: 'low' }; f.random(0.999);
  f.codex.ask = async (r, p, timeout, opts) => { f.asks.push(JSON.parse(p)); assert.deepEqual(opts.outputSchema.properties.action.enum, ['reply']); return answer('silent'); };
  await f.bot.accept(msg('at', '')); await flush(f.bot);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].params.count, 30);
  assert.equal(f.asks[0].recentMessages.length, 30); assert.equal(f.asks[0].direct, true);
  assert.equal(f.asks[0].previousCheck, null); assert.match(f.asks[0].behavior.rules, /必回消息/);
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0][3], 'at'); assert.ok(room.activeUntil > f.now());
  assert.equal(f.bot.state.metrics.silent, 0);
});

test('@ upgrades a queued check-in to a mandatory reply even with all chances zero', async t => {
  const f = fixture(t, { mode: 'social', checkinReplyChance: 0, lowInterestReplyChance: 0, highInterestReplyChance: 0, activeReplyChance: 0 });
  nextCheck(f); f.history.set('11111', historyAt(f.now())); await f.bot.checkPresence();
  await f.bot.accept(msg('urgent', '问你')); await flush(f.bot);
  assert.equal(f.asks.length, 1); assert.equal(f.asks[0].trigger, 'direct'); assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0][3], 'urgent'); assert.equal(f.bot.room('group', '11111').lastCheckDecision, undefined);
});

test('@ queued during a failing reply is still answered and fallback does not quote', async t => {
  const f = fixture(t, { mode: 'social', checkinReplyChance: 0, activeReplyChance: 0 }); let rejectFirst;
  f.codex.ask = () => new Promise((resolve, reject) => { rejectFirst = reject; });
  await f.bot.accept(msg('first', '第一次')); await flush(f.bot);
  await f.bot.accept(msg('second', '第二次')); f.codex.ask = async () => answer();
  rejectFirst(Error('Codex 请求失败（代码 -32603）。')); await flush(f.bot);
  assert.equal(f.sends.length, 2); assert.equal(f.sends[0][3], undefined); assert.equal(f.sends[1][3], 'second');
  assert.ok(f.bot.events.some(e => e.message.includes('模型接口错误（代码 -32603）')));
  assert.equal(f.bot.state.metrics.silent, 0);
});

test('context preparation errors cannot silently discard a direct mention', async t => {
  const f = fixture(t, { mode: 'social' });
  f.bot.media = { register: () => [], prepareRecent: async () => {}, describeMessage: () => { throw Error('broken image cache'); } };
  await f.bot.accept(msg('at', '你在吗')); await flush(f.bot);
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0][3], undefined);
  assert.ok(f.bot.events.some(e => e.message.includes('@ 必回准备上下文失败')));
});

test('an explicitly rejected quoted reply retries the same text without a quote once', async t => {
  const f = fixture(t, { mode: 'social' }), attempts = [];
  f.qq.send = async (...args) => {
    attempts.push(args);
    if (args[3]) throw Object.assign(Error('rejected'), { code: 'QQ_API_REJECTED', retcode: 1200 });
    f.sends.push(args); return { message_id: 'sent' };
  };
  await f.bot.accept(msg('at', '测试')); await flush(f.bot);
  assert.equal(attempts.length, 2); assert.equal(attempts[0][2], attempts[1][2]); assert.equal(attempts[1][3], undefined);
  assert.equal(f.sends.length, 1); assert.equal(f.bot.state.metrics.replies, 1);
});

test('an @ segment beyond the text truncation limit still forces a reply', async t => {
  const f = fixture(t, { mode: 'social', checkinReplyChance: 0, activeReplyChance: 0 });
  const event = msg('long-at', '', { at: false });
  event.message = [...Array.from({ length: 50 }, () => ({ type: 'face', data: { id: 1 } })), { type: 'at', data: { qq: '99999' } }];
  await f.bot.accept(event); await flush(f.bot); assert.equal(f.sends.length, 1); assert.equal(f.asks[0].direct, true);
});

test('stopping while a quoted send is rejected suppresses retry and fallback', async t => {
  const f = fixture(t, { mode: 'social' }); let rejectSend, attempts = 0;
  f.qq.send = () => { attempts++; return new Promise((resolve, reject) => { rejectSend = reject; }); };
  await f.bot.accept(msg('at', '测试')); await flush(f.bot); await f.bot.stop('group:11111');
  rejectSend(Object.assign(Error('rejected'), { code: 'QQ_API_REJECTED', retcode: 1200 })); await flush(f.bot);
  assert.equal(attempts, 1); assert.equal(f.bot.state.metrics.replies, 0);
});
test('successful first reply starts a fixed 5–10 minute active period and later @ does not extend it', async t => {
  const f = fixture(t, { mode: 'social', allowedGroups: ['11111'], activeReplyChance: 100 });
  f.random(0); await f.bot.accept(msg(1, '你好')); await flush(f.bot);
  const room = f.bot.room('group', '11111'), until = room.activeUntil;
  assert.equal(until - f.now(), 5 * 60000);
  f.advance(46000); await f.bot.accept(msg(2, '跟聊', { at: false })); await flush(f.bot);
  assert.equal(f.sends.length, 2); assert.equal(room.activeUntil, until); assert.equal(f.calls.length, 1);
  await f.bot.accept(msg(3, '继续@')); await flush(f.bot); assert.equal(room.activeUntil, until);
  f.advance(until - f.now()); const history = JSON.stringify(room.history);
  await f.bot.accept(msg(4, '已休息', { at: false })); await flush(f.bot); assert.equal(JSON.stringify(room.history), history);
  f.random(1 - Number.EPSILON); await f.bot.accept(msg(5, '重新唤醒')); await flush(f.bot);
  assert.equal(room.activeUntil - f.now(), 10 * 60000); assert.equal(f.calls.at(-1).params.count, 30);
});
test('active probability is drawn once per burst, with cooldown on skipped draws and a reply cap', async t => {
  const f = fixture(t, { mode: 'social', allowedGroups: ['11111'], maxRepliesPerHour: 1 });
  await f.bot.accept(msg(1, '唤醒')); await flush(f.bot);
  f.advance(46000); f.random(0.8);
  await f.bot.accept(msg(2, '第一句', { at: false })); await f.bot.accept(msg(3, '第二句', { at: false })); await flush(f.bot);
  assert.equal(f.asks.length, 1); assert.equal(f.bot.state.metrics.silent, 1);
  f.random(0); await f.bot.accept(msg(4, '不立即重抽', { at: false })); await flush(f.bot); assert.equal(f.asks.length, 1);
  f.advance(46000); await f.bot.accept(msg(5, '接话', { at: false })); await flush(f.bot); assert.equal(f.asks.length, 2);
  f.advance(46000); await f.bot.accept(msg(6, '达到上限', { at: false })); await flush(f.bot); assert.equal(f.asks.length, 2);
  await f.bot.accept(msg(7, '直接叫')); await flush(f.bot); assert.equal(f.asks.length, 3);
});
test('late active responses cannot renew the window; an in-flight @ still gets answered', async t => {
  const f = fixture(t, { mode: 'social', allowedGroups: ['11111'], activeReplyChance: 100 });
  await f.bot.accept(msg(1, '醒醒')); await flush(f.bot);
  const room = f.bot.room('group', '11111'); let release;
  f.codex.ask = () => new Promise(resolve => { release = resolve; });
  f.advance(room.activeUntil - f.now() - 1000);
  await f.bot.accept(msg(2, '最后跟聊', { at: false })); await flush(f.bot);
  f.advance(2000); release(answer()); await flush(f.bot);
  assert.equal(f.sends.length, 1); assert.equal(f.bot.presence(room).phase, '间歇中');
  f.codex.ask = async () => answer(); await f.bot.accept(msg(3, '醒醒')); await flush(f.bot);
  f.advance(room.activeUntil - f.now() - 1000); const until = room.activeUntil;
  f.codex.ask = () => new Promise(resolve => { release = resolve; });
  await f.bot.accept(msg(4, '临走前问一句')); await flush(f.bot);
  f.advance(2000); release(answer()); await flush(f.bot);
  assert.equal(f.sends.length, 3); assert.equal(room.activeUntil, until);
});
test('@ preempts an active debounce and quotes the directed message, not intervening chatter', async t => {
  const f = fixture(t, { mode: 'social', allowedGroups: ['11111'], activeReplyChance: 0 });
  await f.bot.accept(msg(1, '唤醒')); await flush(f.bot); f.advance(46000);
  await f.bot.accept(msg(2, '普通', { at: false })); const old = f.bot.timers.get('group:11111');
  await f.bot.accept(msg(3, '问你')); assert.notEqual(f.bot.timers.get('group:11111'), old);
  await f.bot.accept(msg(4, '别人聊天', { at: false })); await flush(f.bot);
  assert.equal(f.sends.length, 2); assert.equal(f.sends[1][3], '3');
});
test('history failures never fall back to monitoring rest messages, and @ still gets a reply', async t => {
  const f = fixture(t, { mode: 'social', allowedGroups: ['11111'] });
  f.qq.call = async () => { throw Error('history unavailable'); };
  nextCheck(f); await f.bot.checkPresence(); await flush(f.bot); assert.equal(f.asks.length, 0);
  await f.bot.accept(msg(1, '忽略', { at: false })); assert.equal(f.bot.room('group', '11111').history.length, 0);
  await f.bot.accept(msg(2, '叫你')); await flush(f.bot); assert.equal(f.sends.length, 1);
});
test('revoking access during a history fetch prevents storage and generation', async t => {
  const f = fixture(t, { mode: 'social', allowedGroups: ['11111'] }); let release;
  f.qq.call = () => new Promise(resolve => { release = resolve; });
  nextCheck(f); const checking = f.bot.checkPresence(); await tick();
  f.settings.update({ allowedGroups: [] }); await f.bot.settingsChanged();
  release({ messages: historyAt(f.now()) }); await checking; await flush(f.bot);
  assert.equal(f.bot.room('group', '11111').history.length, 0); assert.equal(f.asks.length, 0);
});
test('jitter and active state persist across restart; changing cadence re-plans allowed groups', async t => {
  const f = fixture(t, { mode: 'social', allowedGroups: ['11111'] }); const room = f.bot.room('group', '11111');
  f.random(0); f.bot.planCheck(room); assert.equal(room.nextCheckAt - f.now(), 45 * 60000);
  f.random(1 - Number.EPSILON); f.bot.planCheck(room); assert.equal(room.nextCheckAt - f.now(), 75 * 60000);
  room.activeUntil = f.now() + 400000; room.threadId = 'persisted'; f.bot.save(); await f.bot.close();
  const restored = new Companion(f.config, f.settings, f.qq, f.codex, { now: f.now, random: () => 0 });
  t.after(() => restored.close()); const saved = restored.room('group', '11111');
  assert.equal(saved.nextCheckAt, room.nextCheckAt); assert.equal(saved.activeUntil, room.activeUntil); assert.equal(saved.threadId, 'persisted');
  const previous = f.settings.value; f.settings.update({ checkIntervalMinutes: 30, checkJitterMinutes: 0 }); await restored.settingsChanged(previous);
  assert.equal(saved.nextCheckAt - f.now(), 30 * 60000); assert.equal(saved.activeUntil, 0);
  await restored.close();
});
test('context is incremental, capped at 12, and decision JSON is never sent', async t => {
  const f = fixture(t);
  for (let i = 1; i <= 20; i++) await f.bot.accept(msg(i, '消息' + i, { at: false }));
  await f.bot.accept(msg(21, '你好')); await flush(f.bot);
  assert.equal(f.asks[0].recentMessages.length, 12);
  await f.bot.accept(msg(22, '再聊聊')); await flush(f.bot);
  assert.equal(f.asks[1].recentMessages.some(m => m.id === '21'), false);
  assert.equal(f.sends[0][2], '你好呀');
});
test('cancellation suppresses replies and memory updates arriving after stop', async t => {
  const f = fixture(t); let release;
  f.codex.ask = () => new Promise(resolve => { release = resolve; });
  await f.bot.accept(msg(1, '任务')); for (const timer of f.bot.timers.values()) clearTimeout(timer); f.bot.timers.clear(); f.bot.drain(); await tick();
  await f.bot.stop('group:11111'); release(answer('reply', '不应该保存')); await flush(f.bot);
  assert.equal(f.sends.length, 0); assert.equal(f.bot.state.rooms['group:11111'].memory, '');
});
test('removing a room from allowlist suppresses in-flight output', async t => {
  const f = fixture(t); let release;
  f.codex.ask = () => new Promise(resolve => { release = resolve; });
  await f.bot.accept(msg(1, '任务')); for (const timer of f.bot.timers.values()) clearTimeout(timer); f.bot.timers.clear(); f.bot.drain(); await tick();
  f.settings.update({ allowedGroups: [] }); release(answer()); await flush(f.bot); assert.equal(f.sends.length, 0);
});
test('only configured owner changes global mode; clear removes retained context', async t => {
  const f = fixture(t);
  await f.bot.accept(msg(1, '/模式 静默', { role: 'admin' })); assert.equal(f.settings.value.mode, 'chat');
  await f.bot.accept(msg(2, '/模式 静默', { sender: 55555 })); assert.equal(f.settings.value.mode, 'silent');
  const room = f.bot.room('group', '11111'); room.memory = '旧记忆'; room.threadId = 'old'; room.glossary = [{ term: '旧词', meaning: '意思' }];
  await f.bot.reset(room.key, true); assert.equal(room.memory, ''); assert.equal(room.threadId, null); assert.deepEqual(room.history, []); assert.deepEqual(room.glossary, []);
});
test('settings validation rejects remote endpoints and preserves previous settings', t => {
  const f = fixture(t);
  assert.throws(() => f.settings.update({ wsUrl: 'ws://example.com:3001' }));
  assert.throws(() => f.settings.update({ allowedGroups: ['abc'] }));
  assert.throws(() => f.settings.update({ checkJitterMinutes: 60 }));
  assert.throws(() => f.settings.update({ activeMinMinutes: 11 }));
  assert.throws(() => f.settings.update({ checkinReplyChance: 101 }));
  assert.throws(() => f.settings.update({ lowInterestReplyChance: -0.1 }));
  assert.throws(() => f.settings.update({ highInterestReplyChance: '90' }));
  assert.throws(() => f.settings.update({ interestAdjustment: 'true' }));
  assert.equal(f.settings.value.wsUrl, '');
  f.settings.update({ accessToken: 'fake-local-test-token' }); assert.equal(JSON.stringify(f.settings.public()).includes('fake-local-test-token'), false);
});
test('saved legacy settings migrate without replacing persona, access or secrets', t => {
  const f = fixture(t);
  writeFileSync(f.settings.file, JSON.stringify({ name: '旧人设', persona: '保留原性格', minMessages: 4, allowedGroups: ['12345'], accessToken: 'local-test-only', cooldownSeconds: 50 }));
  const migrated = new Settings(f.runtime);
  assert.equal(migrated.value.name, '旧人设'); assert.equal(migrated.value.persona, '保留原性格');
  assert.deepEqual(migrated.value.allowedGroups, ['12345']); assert.equal(migrated.value.accessToken, 'local-test-only');
  assert.equal(migrated.value.cooldownSeconds, 50); assert.equal(migrated.value.checkinReplyChance, 37); assert.equal(migrated.value.lowInterestReplyChance, 18.5);
  assert.equal(Object.hasOwn(migrated.value, 'minMessages'), false);
  assert.equal(new Settings(f.runtime).value.highInterestReplyChance, 55.5);
});
test('NapCat discovery uses default config until an account-specific config exists', t => {
  const f = fixture(t);
  const path = join(f.runtime, 'NapCat.Test.Shell', 'versions', 'test', 'resources', 'app', 'napcat', 'config');
  mkdirSync(path, { recursive: true });
  const config = port => JSON.stringify({ network: { websocketServers: [{ enable: true, host: '127.0.0.1', port, token: 'test-only' }] } });
  writeFileSync(join(path, 'onebot11.json'), config(3001));
  assert.equal(discoverNapcat(f.runtime)[0].wsUrl, 'ws://127.0.0.1:3001');
  writeFileSync(join(path, 'onebot11_99999.json'), config(3002));
  const found = discoverNapcat(f.runtime); assert.equal(found.length, 1); assert.equal(found[0].wsUrl, 'ws://127.0.0.1:3002');
});
test('console requires token, rejects foreign origins and does not expose connection tokens', async t => {
  const f = fixture(t); f.settings.update({ accessToken: 'fake-connection-secret' });
  const server = createConsole(f.settings, f.bot, f.qq); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`; const headers = { Authorization: 'Bearer ' + f.settings.token };
  assert.equal((await fetch(base + '/api/status')).status, 401);
  assert.equal((await fetch(base + '/api/status', { headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
  const response = await fetch(base + '/api/status', { headers }); assert.equal(response.status, 200); assert.equal((await response.text()).includes('fake-connection-secret'), false);
  assert.equal((await fetch(base + '/.env', { headers })).status, 404);
  assert.equal((await fetch(base + '/api/settings', { method: 'POST', headers, body: JSON.stringify({ persona: '测试人设' }) })).status, 200);
});
test('UI embedded script parses and uses text rendering for messages', () => {
  const page = readFileSync(new URL('../ui/console.html', import.meta.url), 'utf8');
  new Script(page.match(/<script>([\s\S]*)<\/script>/)[1]); assert.equal(page.includes('innerHTML'), false);
  assert.throws(() => parseDecision('broken JSON')); assert.throws(() => parseDecision('{"action":"send"}'));
});
test('OneBot correlates concurrent calls, rejects API failures, and sends segments literally', async t => {
  class Socket extends EventTarget {
    constructor(url) { super(); this.url = url; this.readyState = 1; Socket.instance = this; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(raw) { const p = JSON.parse(raw); Socket.sent.push(p); queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ echo: p.echo, retcode: p.action === 'bad' ? 100 : 0, data: p.action === 'get_login_info' ? { user_id: 99999, nickname: 'test' } : { message_id: 100 } }) }))); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
    static sent = [];
  }
  const client = new OneBotClient(() => ({ wsUrl: 'ws://127.0.0.1:3001', accessToken: 'test-token' }), { WebSocketClass: Socket });
  t.after(() => client.close()); client.start(); await once(client, 'ready');
  assert.equal(client.identity.id, '99999');
  await Promise.all([client.send('group', '11111', '[CQ:at,qq=all] hello', '123'), client.call('get_group_list')]);
  const sent = Socket.sent.find(s => s.action === 'send_group_msg'); assert.equal(sent.params.message[1].type, 'text'); assert.equal(sent.params.message[1].data.text, '[CQ:at,qq=all] hello');
  await assert.rejects(client.call('bad'), error => error.code === 'QQ_API_REJECTED' && error.action === 'bad' && error.retcode === 100); assert.equal(client.pending.size, 0);
});
