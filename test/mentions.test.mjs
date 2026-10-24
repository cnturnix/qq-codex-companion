import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMention, resolveMention } from '../src/mentions.mjs';
import { OneBotClient } from '../src/onebot.mjs';

const room = { kind: 'group', id: '11111' };
const members = [{ user_id: 99999, nickname: '机器人' }, { user_id: 33333, nickname: '小明', card: '阿明' }, { user_id: 44444, nickname: '小红' }];
test('random mentions select one real member of the current group, excluding self and invalid entries', async () => {
  const calls = [], qq = { identity: { id: '99999' }, call: async (...args) => { calls.push(args); return [...members, { user_id: 'all' }, { user_id: 55555, group_id: 22222 }, members[1]]; } };
  assert.deepEqual((await resolveMention(qq, room, { mode: 'random', targets: [] }, () => 0)).ids, ['33333']);
  assert.deepEqual((await resolveMention(qq, room, { mode: 'random', targets: [] }, () => .999)).ids, ['44444']);
  assert.equal(calls[0][0], 'get_group_member_list'); assert.equal(calls[0][1].group_id, '11111');
});
test('selected IDs and exact names are verified; absent or ambiguous members are not pinged', async () => {
  const qq = { identity: { id: '99999' }, call: async () => members };
  assert.deepEqual((await resolveMention(qq, room, { mode: 'selected', targets: ['阿明', '44444'] })).ids, ['33333', '44444']);
  assert.match((await resolveMention(qq, room, { mode: 'selected', targets: ['55555'] })).error, /没找到/);
  qq.call = async () => [...members, { user_id: 55555, nickname: '小明' }];
  const ambiguous = await resolveMention(qq, room, { mode: 'selected', targets: ['小明'] });
  assert.deepEqual(ambiguous.ids, []); assert.match(ambiguous.error, /重名/);
});
test('no mention, private chats, and mass mentions do not fetch the group roster', async () => {
  let calls = 0; const qq = { call: async () => { calls++; throw Error('unavailable'); } };
  assert.deepEqual(parseMention(undefined), { mode: 'none', targets: [] });
  assert.deepEqual((await resolveMention(qq, room, parseMention(undefined))).ids, []);
  assert.ok((await resolveMention(qq, { kind: 'private' }, { mode: 'random', targets: [] })).error);
  assert.ok((await resolveMention(qq, room, { mode: 'selected', targets: ['all'] })).error);
  assert.equal(calls, 0);
  assert.match((await resolveMention(qq, room, { mode: 'random', targets: [] })).error, /没能发出/);
  assert.throws(() => parseMention({ mode: 'selected', targets: [123] }));
});
test('OneBot emits actual at segments while keeping ordinary CQ text literal', async () => {
  const qq = new OneBotClient(() => {}); let sent;
  qq.call = async (action, params) => { sent = { action, params }; return {}; };
  await qq.send('group', '11111', '抽到你了 [CQ:image,file=secret]', '123', ['33333', '33333']);
  assert.deepEqual(sent.params.message.map(m => m.type), ['reply', 'at', 'text', 'text']);
  assert.equal(sent.params.message[1].data.qq, '33333'); assert.equal(sent.params.message.at(-1).data.text, '抽到你了 [CQ:image,file=secret]');
  await assert.rejects(qq.send('group', '11111', 'hi', null, ['all']));
  await assert.rejects(qq.send('private', '33333', 'hi', null, ['33333']));
});
