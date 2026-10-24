import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { Settings } from '../src/companion-settings.mjs';
import { Companion } from '../src/companion.mjs';
import { CompanionCore } from '../src/companion-core/core.mjs';
import { MemoryStore } from '../src/companion-core/store.mjs';
import { completedTurn } from '../src/companion-core/event-adapter.mjs';
import { createConsole } from '../src/console-server.mjs';

function fixture(t, patch = {}) {
  const runtime = mkdtempSync(join(resolve('work'), 'growth-test-')), settings = new Settings(runtime);
  settings.update({ allowedGroups: ['11111','22222'], allowedUsers: ['33333'], mode: 'chat', visionEnabled: false });
  let time = Date.parse('2026-10-24T00:00:00Z'), serial = 0; const sent = [], asks = [];
  const qq = { identity: { id: '99999' }, status: () => ({ connected: true }), send: async (...args) => { sent.push(args); return { message_id: 'out-' + sent.length }; }, call: async () => ({ messages: [] }) };
  const codex = { ready: true, resumed: new Set(), interrupt: async () => {}, ask: async (room, prompt, timeout, options) => {
    asks.push(JSON.parse(prompt)); room.threadId = 'test';
    if (options.outputSchema.properties.reply) return JSON.stringify({ reply: asks.at(-1).learnedStyle ? '有学习风格的预览' : '固定设定预览' });
    if (options.outputSchema.properties.habits) return JSON.stringify({ habits: [], moods: [] });
    return JSON.stringify({ action: 'reply', interest: 'normal', messages: ['收到'], mediaId: '', mention: { mode: 'none', targets: [] }, memory: '', glossary: [] });
  } };
  const config = { runtime, model: 'test', effort: 'high' }, bot = new Companion(config, settings, qq, codex, { now: () => time });
  const core = new CompanionCore(config, settings, codex, bot, { now: () => time }); bot.core = core;
  core.updateSettings({ habitLearningEnabled: true, learningDryRun: false, maxLearningCodexCallsPerHour: 10, maxLearningCodexCallsPerDay: 50, maxLearningTokensPerDay: 200000, maxExtraPromptTokens: 1200, ...patch });
  const f = { runtime, config, settings, bot, qq, codex, core, s: core.store, g: core.growth, sent, asks, now: () => time, advance: ms => time += ms };
  f.seed = async ({ text = '请以后简短一点', roomKey = 'group:11111', replyTo = '', output = '好的，我会简洁回答。' } = {}) => {
    const [kind, id] = roomKey.split(':'), room = bot.room(kind, id), number = ++serial;
    const input = { room, job: { direct: true }, messages: [{ id: 'h' + number, sender: '33333', userText: text, time, replyTo }], outputs: [{ id: 'a' + number, text: output }], now: time };
    core.capture(input); await Promise.all([...core.pendingCaptures]); return completedTurn(input);
  };
  f.extract = (turn, build = id => ({ habits: [{ style: 'concise', context: 'general', kind: 'request', human_event_id: id, assistant_event_id: '' }], moods: [] })) => {
    f.g.createJobs(true, turn.roomKey); const job = f.s.nextJob(() => true, kind => kind === 'growth'); assert.ok(job);
    assert.ok(f.s.startJob(job)); const human = turn.events.find(e => e.actor === 'human'); const result = f.g.ingest(job, build(human.id), new Set(f.s.jobEvents(job).filter(e => e.actor === 'human').map(e => e.id))); return result;
  };
  f.qualified = async roomKey => { for (let i = 0; i < 3; i++) { if (i) f.advance(86400000); const turn = await f.seed({ roomKey }); f.extract(turn); } return f.g.list().find(h => h.evidence.some(e => e.room_key === (roomKey ?? 'group:11111'))); };
  t.after(async () => { await bot.close(); await core.close(); assert.ok(runtime.startsWith(resolve('work') + sep)); rmSync(runtime, { recursive: true, force: true }); });
  return f;
}
function evolve(f, habit) { f.g.updateHabit(habit.id, 'activate'); f.core.updateSettings({ personalityEnabled: true }); const id = f.g.proposal(habit.scope_key); assert.ok(id); return f.g.commit(id); }

test('growth migration preserves version-two settings, source IDs and the selected shared scope', t => {
  const f = fixture(t); const file = join(f.runtime, 'migration.db'); let s = new MemoryStore(file); s.updateSettings({ learnedPersonaScope: 'shared' }); const persona = s.get("SELECT value FROM meta WHERE key='persona'").value; s.close();
  s = new MemoryStore(file); const c = new CompanionCore(f.config, f.settings, f.codex, f.bot, { store: s });
  assert.equal(s.get('PRAGMA user_version').user_version, 3); assert.equal(s.settings().learnedPersonaScope, 'shared'); assert.equal(s.get("SELECT value FROM meta WHERE key='persona'").value, persona); return c.close();
});

test('assistant self-claims, invented IDs and ungrounded requests cannot create habit evidence', async t => {
  const f = fixture(t);
  for (let i = 0; i < 10; i++) {
    const turn = await f.seed({ text: '嗯', output: '我喜欢简短，我已经学会简短。' });
    const result = f.extract(turn, human => ({ habits: [
      { style: 'concise', context: 'general', kind: 'request', human_event_id: human, assistant_event_id: '' },
      { style: 'concise', context: 'general', kind: 'request', human_event_id: turn.events[1].id, assistant_event_id: '' },
      { style: 'concise', context: 'general', kind: 'request', human_event_id: 'invented', assistant_event_id: '' }
    ], moods: [] })); assert.equal(result.accepted, 0);
  }
  assert.equal(f.g.list().length, 0); assert.equal(f.settings.value.persona.includes('我已经学会'), false);
});

test('replayed requests count once and independent days are required before activation', async t => {
  const f = fixture(t); const turn = await f.seed(); f.extract(turn);
  const h = f.g.list()[0]; assert.equal(h.positive, 3); assert.equal(h.days, 1); assert.equal(h.eligible, false);
  f.g.addEvidence(h, turn.events[0].id, null, 'request', 3); assert.equal(f.g.habit(h.id).positive, 3);
  assert.throws(() => f.g.updateHabit(h.id, 'activate'), /证据|支持|日期/);
  for (let i = 0; i < 2; i++) { const next = await f.seed(); f.extract(next); }
  assert.equal(f.g.habit(h.id).eligible, false); assert.equal(f.g.habit(h.id).days, 1);
});

test('praise must quote an actual same-room reply and cannot cite arbitrary assistant messages', async t => {
  const f = fixture(t); const first = await f.seed({ text: '你好' }); f.extract(first, () => ({ habits: [], moods: [] })); f.advance(1000);
  const good = await f.seed({ text: '刚才这样回答很好', replyTo: 'a1' });
  f.extract(good, human => ({ habits: [{ style: 'concise', context: 'general', kind: 'praise', human_event_id: human, assistant_event_id: first.events[1].id }], moods: [] }));
  assert.equal(f.g.list()[0].positive, 3);
  const bad = await f.seed({ text: '刚才这样回答很好' });
  const result = f.extract(bad, human => ({ habits: [{ style: 'concise', context: 'general', kind: 'praise', human_event_id: human, assistant_event_id: first.events[1].id }], moods: [] }));
  assert.equal(result.rejected, 1); assert.equal(f.g.list()[0].positive, 3);
});

test('verified habits evolve only low-risk dimensions and preserve every original behavioral setting', async t => {
  const f = fixture(t), before = structuredClone(f.settings.value), h = await f.qualified();
  assert.equal(h.status, 'consolidated'); const v = evolve(f, h);
  assert.ok(Math.abs(JSON.parse(v.traits).expressiveness - .48) < 1e-9); assert.deepEqual(f.settings.value, before);
  const view = f.core.personaView('group:11111'); assert.match(view.persona, /学习后的说话风格.*|简洁表达/s);
  assert.equal(f.core.personaView('group:22222').learned, view.learned);
  assert.ok(f.core.context(f.bot.room('group', '11111'), '请回答').growth.learnedStyle);
});

test('daily cumulative limits survive repeated proposals, rollback and database reopen', async t => {
  const f = fixture(t), h = await f.qualified(), initial = f.g.head(h.scope_key); evolve(f, h);
  for (let i = 0; i < 5; i++) assert.throws(() => f.g.commit(f.g.proposal(h.scope_key)), /额度|目标/);
  f.g.rollback(h.scope_key, initial.id); assert.throws(() => f.g.commit(f.g.proposal(h.scope_key)), /额度|目标/);
  const file = f.s.file; await f.core.close(); const s = new MemoryStore(file, { now: f.now }); const reopened = new CompanionCore(f.config, f.settings, f.codex, f.bot, { store: s });
  assert.throws(() => reopened.growth.commit(reopened.growth.proposal(h.scope_key)), /额度|目标/); await reopened.close();
});

test('explicit human rejection immediately suspends active habits and invalidates their personality versions', async t => {
  const f = fixture(t), h = await f.qualified(), old = evolve(f, h);
  assert.equal(f.core.context(f.bot.room('group', '11111'), '不要那么简短').growth?.learnedStyle, undefined);
  f.advance(1000); await f.seed({ text: '不要那么简短，关键细节没说清楚' });
  const now = f.g.habit(h.id); assert.equal(now.status, 'candidate'); assert.equal(now.negative, 4); assert.equal(now.conflict, true);
  assert.equal(f.core.personaView(h.scope_key).learned, ''); assert.throws(() => f.g.rollback(h.scope_key, old.id), /失效/);
  assert.throws(() => f.g.updateHabit(h.id, 'activate'), /反对|支持/);
});

test('activated group habits affect the shared persona without a separate share approval', async t => {
  const f = fixture(t), h = await f.qualified(); f.g.updateHabit(h.id, 'activate'); f.core.updateSettings({ learnedPersonaScope: 'shared', personalityEnabled: true });
  assert.ok(f.g.proposal('shared')); assert.ok(f.core.context(f.bot.room('group','22222'), '你好').growth?.learnedStyle);
  f.g.commit(f.g.proposal('shared'));
  const other = f.core.context(f.bot.room('group','22222'), '你好'); assert.ok(other.growth.learnedStyle); assert.equal(JSON.stringify(other.growth).includes('33333'), false);
  f.settings.update({ allowedGroups: ['22222'] });
  assert.equal(f.core.context(f.bot.room('group','22222'), '你好').growth?.learnedStyle, undefined);
});

test('private habits apply account-wide, and paused or retired habits do not revive automatically', async t => {
  const f = fixture(t, { habitAutoActivateEnabled: true }), h = await f.qualified('private:33333');
  assert.equal(h.status, 'active'); assert.ok(f.g.hints('group:11111', '请回答').habits.length);
  f.g.updateHabit(h.id, 'pause'); f.advance(86400000); const turn = await f.seed({ roomKey: 'private:33333' }); f.extract(turn);
  assert.equal(f.g.habit(h.id).status, 'paused'); f.g.updateHabit(h.id, 'retire'); f.g.reconcile(h.id); assert.equal(f.g.habit(h.id).status, 'retired');
});

test('group and private feedback contribute to one personality, and manual changes synchronize everywhere', async t => {
  const f = fixture(t, { personalityEnabled: true });
  const group = await f.qualified(); f.g.updateHabit(group.id, 'activate');
  const privateHabit = await f.qualified('private:33333'); f.g.updateHabit(privateHabit.id, 'activate');
  assert.ok(f.g.proposal('private:33333'));
  f.g.queueReflection(true); f.g.reflect();
  assert.ok(f.s.get("SELECT id FROM persona_proposals WHERE scope_key='shared' AND status='pending'"));
  assert.equal(f.s.get("SELECT id FROM persona_proposals WHERE scope_key LIKE 'private:%'"), undefined);
  f.g.commit(f.g.proposal('shared'));
  const view = f.core.personaView('private:33333'); assert.equal(view.scope, 'shared'); assert.ok(view.applied); assert.deepEqual(view.head.source_habits, [group.id]);
  assert.equal(f.core.personaView('group:22222').applied, view.applied);
  assert.ok(f.core.context(f.bot.room('private', '33333'), '请回答').growth.learnedStyle.style);
  const sharedVersion = view.head.id; f.core.updateSettings({ learnedPersonaScope: 'shared' });
  assert.equal(f.core.personaView('private:33333').head.id, sharedVersion);
  assert.equal(f.core.personaView('group:22222').head.id, sharedVersion);
  const manual = f.core.personaView('private:33333');
  f.core.savePersonaSettings({ personaRoom: 'private:33333', personaViewRevision: manual.revision, persona: manual.core + '\n\n【学习后的说话风格】\n轻松一点，少用套话。' });
  assert.equal(f.core.personaView('shared').learned, '轻松一点，少用套话。');
  assert.throws(() => f.core.updateSettings({ learnedPersonaScope: 'room' }), /账号共享/);
  assert.equal(f.core.personaView('private:33333').learned, '轻松一点，少用套话。');
  assert.equal(f.core.personaView('group:22222').learned, '轻松一点，少用套话。');
});

test('private facts and preferences share with all allowed conversations and deletion retracts them everywhere', async t => {
  const f = fixture(t, { globalMemoryEnabled: true, learnedPersonaScope: 'shared' });
  const turn = await f.seed({ roomKey: 'private:33333', text: '我喜欢周末玩星露谷' });
  const memory = f.core.addMemory({ scope: 'relationship', scopeKey: 'qq:33333', text: '我喜欢周末玩星露谷', type: 'preference', canonicalKey: 'private-game' });
  f.s.updateMemory(memory.id, { status: 'active' });
  const h = await f.qualified('private:33333'); f.g.updateHabit(h.id, 'activate');
  assert.ok(f.core.context(f.bot.room('private', '33333'), '星露谷').memories.length);
  assert.equal(f.core.context(f.bot.room('group', '11111'), '星露谷').memories[0].source, 'qq:33333');
  f.settings.update({ allowedUsers: ['33333', '44444'] });
  assert.equal(f.core.context(f.bot.room('private', '44444'), '星露谷').memories.length, 1);
  assert.equal(f.g.hints('private:44444', '请回答').habits.length, 1);
  assert.equal(f.g.hints('private:33333', '请回答').habits.length, 1);
  await f.core.erase({ roomKey: turn.roomKey });
  assert.equal(f.core.context(f.bot.room('private', '33333'), '星露谷').memories.length, 0);
  assert.equal(f.g.hints('private:33333', '请回答').habits, undefined);
  assert.equal(f.core.context(f.bot.room('group', '11111'), '星露谷').memories.length, 0);
  assert.equal(f.core.context(f.bot.room('private', '44444'), '星露谷').memories.length, 0);
});

test('editing the original persona window pins the learned section and protects against stale or invalid saves', async t => {
  const f = fixture(t), h = await f.qualified(); evolve(f, h); const before = f.settings.value.persona, view = f.core.personaView(h.scope_key);
  f.core.savePersonaSettings({ personaRoom: h.scope_key, personaViewRevision: view.revision, persona: before + '\n\n【学习后的说话风格】\n自然一点，少用套话。' });
  assert.equal(f.settings.value.persona, before); assert.equal(f.core.personaView(h.scope_key).head.manual_text, '自然一点，少用套话。'); assert.equal(f.g.proposal(h.scope_key), null);
  assert.throws(() => f.core.savePersonaSettings({ personaRoom: h.scope_key, personaViewRevision: view.revision, persona: '旧内容' }), /新版本/);
  const current = f.core.personaView(h.scope_key), count = f.s.get('SELECT COUNT(*) AS n FROM persona_versions').n;
  assert.throws(() => f.core.savePersonaSettings({ personaRoom: h.scope_key, personaViewRevision: current.revision, persona: '不应保存', maxReplyChars: 2 }));
  assert.equal(f.settings.value.persona, before); assert.equal(f.s.get('SELECT COUNT(*) AS n FROM persona_versions').n, count);
  f.g.resumeAutomatic(h.scope_key); assert.equal(f.core.personaView(h.scope_key).head.manual_text, null);
});

test('deleting sources removes shared habits and mood, and cannot resurrect a past version', async t => {
  const f = fixture(t), h = await f.qualified(); evolve(f, h);
  const old = f.g.head('shared'); await f.core.erase({ roomKey: h.scope_key });
  assert.equal(f.g.list().length, 0); assert.equal(f.s.get('SELECT COUNT(*) AS n FROM habit_evidence').n, 0); assert.equal(f.g.head('shared').source_habits, '[]');
  assert.throws(() => f.g.rollback('shared', old.id), /失效/); assert.equal(f.s.get('SELECT id FROM habits WHERE id=?', h.id), undefined);
});

test('mood is scoped, confidence-gated, idempotent and decays to baseline under a fake clock', async t => {
  const f = fixture(t, { moodSimulationEnabled: true }); const turn = await f.seed({ text: '谢谢，今天一起聊天很开心' });
  f.extract(turn, id => ({ habits: [], moods: [{ event_id: id, emotion: '开心', delta: 4, strength: 8, confidence: .9 }, { event_id: 'invented', emotion: '难过', delta: -5, strength: 9, confidence: 1 }] }));
  assert.equal(f.g.mood(turn.roomKey).value, 74); assert.equal(f.g.mood('group:22222').value, 70);
  f.advance(90 * 60000); assert.ok(Math.abs(f.g.mood(turn.roomKey).emotions.开心 - 4) < 1e-9);
  f.advance(10.5 * 3600000); assert.ok(Math.abs(f.g.mood(turn.roomKey).value - 72) < 1e-9);
  await f.core.erase({ roomKey: turn.roomKey }); assert.equal(f.g.mood(turn.roomKey).value, 70);
});

test('reflection queue persists and respects cadence; auto commits remain bounded and pause under dry run', async t => {
  const f = fixture(t, { reflectionEnabled: true, personalityEnabled: true, personalityAutoCommitEnabled: true, habitAutoActivateEnabled: true }); const h = await f.qualified();
  assert.equal(f.g.queueReflection(), true); assert.equal(f.g.queueReflection(), false); f.g.reflect(); assert.ok(JSON.parse(f.g.head(h.scope_key).traits).expressiveness < .5);
  assert.equal(f.g.queueReflection(), false); f.advance(86400001); f.core.updateSettings({ learningDryRun: true }); f.g.queueReflection(); f.g.reflect();
  assert.ok(Math.abs(JSON.parse(f.g.head(h.scope_key).traits).expressiveness - .48) < 1e-9); assert.ok(f.s.get("SELECT id FROM persona_proposals WHERE status='pending'"));
});

test('preview uses isolated Codex calls, respects quota, and sends no QQ messages', async t => {
  const f = fixture(t), h = await f.qualified(); evolve(f, h); f.advance(3600001);
  const result = await f.core.preview(h.scope_key, '这是一个虚构的对话预览'); assert.equal(result.sentToQQ, false); assert.equal(f.sent.length, 0); assert.notEqual(result.withoutLearning, result.withLearning);
  assert.equal(f.s.quota().hourlyCalls, 2); f.core.updateSettings({ maxLearningCodexCallsPerHour: 2 }); await assert.rejects(f.core.preview(h.scope_key, '预览'), /额度/);
});

test('growth endpoints use existing authentication and never let a chat payload approve personality', async t => {
  const f = fixture(t), server = createConsole(f.settings, f.bot, f.qq); server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(() => { server.closeAllConnections(); server.close(); }); const base = 'http://127.0.0.1:' + server.address().port;
  for (const route of ['habit','proposal','rollback','reflect','preview']) assert.equal((await fetch(base+'/api/companion/'+route,{method:'POST',body:'{}'})).status,401);
  const headers = { Authorization: 'Bearer '+f.settings.token, Origin: 'https://foreign.invalid' }; assert.equal((await fetch(base+'/api/companion/persona',{headers})).status,403);
});

test('enabled growth still ignores resting traffic, and direct mentions preempt its model without probability checks', async t => {
  const f = fixture(t), h = await f.qualified(); evolve(f,h);
  f.settings.update({ mode: 'social', checkinReplyChance: 0, lowInterestReplyChance: 0, highInterestReplyChance: 0, activeReplyChance: 0, cooldownSeconds: 3600, maxRepliesPerHour: 1 });
  const event = (id, at) => ({ post_type:'message',message_type:'group',group_id:'11111',user_id:'33333',self_id:'99999',message_id:id,message:[...(at?[{type:'at',data:{qq:'99999'}}]:[]),{type:'text',data:{text:'请简短说明'}}] });
  const count = f.s.summary().events; await f.bot.accept(event('rest-ignored',false)); assert.equal(f.s.summary().events,count); assert.equal(f.asks.length,0);
  await f.seed(); let release, interrupted=false; const ask=f.codex.ask;
  f.codex.interrupt=async()=>{interrupted=true};
  f.codex.ask=async(room,prompt,timeout,options)=>{if(options.outputSchema.properties.habits){room.threadId='growth';return new Promise(r=>{release=()=>r(JSON.stringify({habits:[],moods:[]}))})}return ask(room,prompt,timeout,options)};
  f.core.extract(); for(let i=0;!release&&i<30;i++)await new Promise(r=>setImmediate(r)); assert.ok(release);
  try {
    await f.bot.accept(event('at-always',true));for(const timer of f.bot.timers.values())clearTimeout(timer);f.bot.timers.clear();f.bot.drain();
    for(let i=0;f.bot.running.size&&i<100;i++)await new Promise(r=>setImmediate(r));
    assert.equal(f.sent.length,1); assert.equal(interrupted,true); assert.ok(f.asks.at(-1).learnedStyle); assert.equal(f.asks.at(-1).direct,true);
  } finally {release();await f.core.running?.promise}
});

test('queued reflection and decaying mood survive a process restart', async t => {
  const f=fixture(t,{moodSimulationEnabled:true,reflectionEnabled:true});const turn=await f.seed();f.extract(turn,id=>({habits:[],moods:[{event_id:id,emotion:'踏实',delta:4,strength:8,confidence:.9}]}));
  f.g.queueReflection();f.s.run("UPDATE reflection_jobs SET status='running'");const path=f.s.file;await f.core.close();f.advance(12*3600000);
  const s=new MemoryStore(path,{now:f.now}),c=new CompanionCore(f.config,f.settings,f.codex,f.bot,{store:s});
  assert.equal(s.get('SELECT status FROM reflection_jobs').status,'queued');assert.equal(c.growth.mood(turn.roomKey).value,72);c.growth.reflect();assert.equal(s.get('SELECT status FROM reflection_jobs').status,'done');await c.close();
});

test('independent days of feedback can accumulate across groups and private chats, and rejection applies globally', async t => {
  const f = fixture(t, { personalityEnabled: true });
  for (const roomKey of ['group:11111', 'group:22222', 'private:33333']) { const turn = await f.seed({ roomKey }); f.extract(turn); f.advance(86400000); }
  assert.equal(f.g.list().length, 1); const h = f.g.list()[0];
  assert.equal(h.days, 3); assert.equal(h.distinctRooms, 3); assert.equal(h.positive, 9); assert.equal(h.eligible, true);
  f.g.updateHabit(h.id, 'activate'); f.g.commit(f.g.proposal('shared'));
  for (const room of ['group:11111','group:22222','private:33333']) assert.ok(f.core.personaView(room).applied);
  await f.seed({ roomKey: 'private:33333', text: '不要那么简短' });
  for (const room of ['group:11111','group:22222','private:33333']) assert.equal(f.core.personaView(room).applied, '');
  assert.equal(f.g.habit(h.id).status, 'candidate');
});

test('legacy independent settings and personality migrate without losing source rows or the manual override', async t => {
  const f = fixture(t, { personalityEnabled: true }); const turn = await f.seed();
  const old = f.g.version('shared', f.g.view('shared').head.traits, '保留原来手动填写的学习性格。', [], 'admin', 'manual_override', f.g.head('shared').id);
  f.s.run("UPDATE persona_versions SET scope_key='group:11111' WHERE id=?", old.id);
  f.s.run("UPDATE persona_heads SET scope_key='group:11111' WHERE scope_key='shared'");
  const saved = { ...f.s.settings(), learnedPersonaScope: 'room', maxLearningCodexCallsPerDay: 9 };
  f.s.run("UPDATE meta SET value=? WHERE key='settings'", JSON.stringify(saved));
  f.s.run("DELETE FROM meta WHERE key IN ('account_sharing','account_persona')");
  const file = f.s.file; await f.core.close();
  const s = new MemoryStore(file, { now: f.now }), core = new CompanionCore(f.config, f.settings, f.codex, f.bot, { store: s });
  assert.equal(s.settings().learnedPersonaScope, 'shared'); assert.equal(s.settings().maxLearningCodexCallsPerDay, 9);
  assert.ok(s.get('SELECT id FROM events WHERE id=?', turn.events[0].id)); assert.ok(s.get('SELECT id FROM persona_versions WHERE id=?', old.id));
  for (const key of ['group:11111','group:22222','private:33333']) assert.equal(core.personaView(key).learned, '保留原来手动填写的学习性格。');
  assert.equal(core.personaView('shared').head.reason, 'account_migration'); await core.close();
});
