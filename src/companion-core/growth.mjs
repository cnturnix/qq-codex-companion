import { randomUUID } from 'node:crypto';
import { eventId, stableId, relevance } from './policy.mjs';
import { traits, neutralTraits, contexts, styleCatalog, localDay, explicitPraise, feedbackText, styleRejected, styleRequested, traitDescription } from './growth-policy.mjs';

const marker = '\n\n【学习后的说话风格】\n';
const parse = JSON.parse;
export class Growth {
  constructor(store, settings, allowed) {
    this.s = store; this.settings = settings; this.allowed = allowed; this.now = store.now;
    store.tx(() => {
      if (!store.all('PRAGMA table_info(jobs)').some(c => c.name === 'kind')) store.db.exec("ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'memory'");
      store.db.exec(`
        CREATE TABLE IF NOT EXISTS growth_pending(turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,processed INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS event_replies(event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,reply_event_id TEXT REFERENCES events(id) ON DELETE SET NULL);
        CREATE TABLE IF NOT EXISTS habits(id TEXT PRIMARY KEY,scope TEXT NOT NULL,scope_key TEXT NOT NULL,style TEXT NOT NULL,context TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(scope,scope_key,style,context));
        CREATE TABLE IF NOT EXISTS habit_evidence(habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,reply_event_id TEXT REFERENCES events(id) ON DELETE CASCADE,kind TEXT NOT NULL,weight REAL NOT NULL,resolved INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(habit_id,event_id));
        CREATE TABLE IF NOT EXISTS habit_dependencies(parent_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,child_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,PRIMARY KEY(parent_id,child_id));
        CREATE TABLE IF NOT EXISTS persona_versions(id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,at INTEGER NOT NULL,actor TEXT NOT NULL,reason TEXT NOT NULL,traits TEXT NOT NULL,manual_text TEXT,source_habits TEXT NOT NULL,valid INTEGER NOT NULL DEFAULT 1,parent_id TEXT);
        CREATE TABLE IF NOT EXISTS persona_heads(scope_key TEXT PRIMARY KEY,version_id TEXT NOT NULL REFERENCES persona_versions(id));
        CREATE TABLE IF NOT EXISTS persona_proposals(id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,at INTEGER NOT NULL,status TEXT NOT NULL,base_version TEXT NOT NULL,targets TEXT NOT NULL,source_habits TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS trait_changes(id INTEGER PRIMARY KEY,scope_key TEXT NOT NULL,trait TEXT NOT NULL,old_value REAL NOT NULL,new_value REAL NOT NULL,amount REAL NOT NULL,at INTEGER NOT NULL,proposal_id TEXT,version_id TEXT NOT NULL,actor TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS trait_budget ON trait_changes(scope_key,trait,at);
        CREATE TABLE IF NOT EXISTS reflection_jobs(id TEXT PRIMARY KEY,at INTEGER NOT NULL,status TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS mood_impulses(event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,room_key TEXT NOT NULL,at INTEGER NOT NULL,emotion TEXT NOT NULL,delta REAL NOT NULL,strength REAL NOT NULL,confidence REAL NOT NULL);
        PRAGMA user_version=3;
      `);
      store.run("UPDATE reflection_jobs SET status='queued' WHERE status='running'");
      store.run("UPDATE jobs SET status='cancelled',error_code='restart_recovery' WHERE kind='preview' AND status IN ('queued','running')");
      if (!store.get("SELECT value FROM meta WHERE key='account_persona'")) {
        for (const group of store.all('SELECT DISTINCT style,context FROM habits')) {
          const peers = store.all('SELECT id,status FROM habits WHERE style=? AND context=?', group.style, group.context);
          const status = peers.some(h => h.status === 'retired') ? 'retired' : peers.some(h => h.status === 'paused') ? 'paused' : null;
          if (status) { store.run('UPDATE habits SET status=? WHERE style=? AND context=?', status, group.style, group.context); this.invalidate(new Set(peers.map(h => h.id)), 'account_migration'); }
        }
        const heads = store.all('SELECT v.* FROM persona_heads h JOIN persona_versions v ON v.id=h.version_id WHERE v.valid=1 ORDER BY v.at DESC,v.rowid DESC');
        const meaningful = v => v && (v.manual_text !== null || v.source_habits !== '[]' || v.traits !== JSON.stringify(neutralTraits()));
        const shared = heads.find(v => v.scope_key === 'shared'), previous = heads.find(meaningful);
        if (!meaningful(shared) && previous) this.version('shared', parse(previous.traits), previous.manual_text, parse(previous.source_habits), 'system', 'account_migration', shared?.id ?? null);
        store.run("UPDATE persona_proposals SET status='invalidated' WHERE scope_key<>'shared' AND status='pending'");
        store.run("INSERT INTO meta VALUES ('account_persona','1')");
      }
    });
    store.beforeErase = (ids, room) => this.eraseSources(ids, room);
  }
  enabled() { const c = this.s.settings(); return c.habitLearningEnabled || c.moodSimulationEnabled; }
  capture(turn) {
    if (!this.enabled()) return;
    this.s.tx(() => {
      this.s.run('INSERT OR IGNORE INTO growth_pending(turn_id) VALUES (?)', turn.id);
      for (const e of turn.events.filter(e => e.actor === 'human')) {
        if (!this.s.get('SELECT id FROM events WHERE id=?', e.id)) continue;
        const reply = e.replyTo ? this.s.get("SELECT e.id FROM events e JOIN turns t ON t.id=e.turn_id WHERE e.id=? AND e.actor='assistant' AND t.room_key=? AND e.at<=?", eventId(turn.roomKey, e.replyTo, 'assistant'), turn.roomKey, e.at) : null;
        if (reply) this.s.run('INSERT OR IGNORE INTO event_replies VALUES (?,?)', e.id, reply.id);
        if (!this.s.settings().habitLearningEnabled) continue;
        for (const h of this.s.all("SELECT * FROM habits WHERE status<>'retired'")) if (styleRejected(h.style, e.content)) {
          this.addEvidence(h, e.id, null, 'rejection', 4); this.suspend(h.id, 'human_rejection');
        }
      }
    });
  }
  createJobs(manual = false, roomKey) {
    if (!this.enabled()) return 0;
    let n = 0;
    this.s.tx(() => { for (const r of this.s.all('SELECT t.room_key,COUNT(*) AS n FROM growth_pending g JOIN turns t ON t.id=g.turn_id WHERE g.processed=0 GROUP BY t.room_key')) {
      if (!this.allowed(r.room_key) || (roomKey && roomKey !== r.room_key) || (!manual && r.n < this.s.settings().batchTurns)) continue;
      const ids = this.s.all('SELECT t.id FROM growth_pending g JOIN turns t ON t.id=g.turn_id WHERE g.processed=0 AND t.room_key=? ORDER BY t.at LIMIT ?', r.room_key, this.s.settings().batchTurns).map(x => x.id);
      this.s.run("INSERT INTO jobs(id,room_key,turn_ids,status,created_at,kind) VALUES (?,?,?,'queued',?,'growth')", randomUUID(), r.room_key, JSON.stringify(ids), this.now());
      for (const id of ids) this.s.run('UPDATE growth_pending SET processed=1 WHERE turn_id=?', id); n++;
    } }); return n;
  }
  evidence(id) { return this.s.all('SELECT x.*,e.content,e.actor_ref,e.at,e.turn_id,t.room_key FROM habit_evidence x JOIN events e ON e.id=x.event_id JOIN turns t ON t.id=e.turn_id WHERE x.habit_id=? ORDER BY e.at,e.id', id); }
  habit(id) {
    const h = this.s.get('SELECT * FROM habits WHERE id=?', id); if (!h) throw Error('习惯不存在。');
    const peers = this.s.all('SELECT id FROM habits WHERE style=? AND context=?', h.style, h.context);
    const unique = new Map();
    for (const e of peers.flatMap(p => this.evidence(p.id))) if (!unique.has(e.event_id) || !e.resolved) unique.set(e.event_id, e);
    const evidence = [...unique.values()], byTurn = new Map();
    for (const e of evidence) { const t = byTurn.get(e.turn_id) ?? { positive: 0, negative: 0 }; const k = e.kind === 'rejection' ? 'negative' : 'positive'; t[k] = Math.max(t[k], e.weight); byTurn.set(e.turn_id, t); }
    const positive = [...byTurn.values()].reduce((n, e) => n + e.positive, 0), negative = [...byTurn.values()].reduce((n, e) => n + e.negative, 0);
    const days = new Set(evidence.filter(e => e.kind !== 'rejection').map(e => localDay(e.at))).size;
    const support = (2 + positive) / (4 + positive + negative), conflict = evidence.some(e => e.kind === 'rejection' && !e.resolved), cfg = this.s.settings();
    const reasons = []; if (positive < cfg.habitMinPositive) reasons.push('真人正向支持不足'); if (days < cfg.habitMinDays) reasons.push('独立日期不足'); if (support < cfg.habitMinSupport) reasons.push('支持度不足'); if (conflict) reasons.push('有未处理的反对证据'); if (!evidence.length) reasons.push('没有有效来源');
    if (evidence.some(e => !this.allowed(e.room_key))) reasons.push('来源会话已移出允许名单');
    return { ...h, label: styleCatalog[h.style].label, rule: styleCatalog[h.style].rule, contextLabel: contexts[h.context], evidence, positive, negative, days, distinctTurns: byTurn.size, distinctRooms: new Set(evidence.map(e => e.room_key)).size, humanFeedbackCount: evidence.length, support, conflict, eligible: !reasons.length, reasons };
  }
  list() { return [...new Map(this.s.all('SELECT id FROM habits ORDER BY updated_at,id LIMIT 1000').map(h => this.habit(h.id)).map(h => [h.style + ':' + h.context, h])).values()].slice(-200).reverse(); }
  addEvidence(h, human, reply, kind, weight) { const added = this.s.run('INSERT OR IGNORE INTO habit_evidence(habit_id,event_id,reply_event_id,kind,weight) VALUES (?,?,?,?,?)', h.id, human, reply, kind, weight); if (added.changes) this.s.run('UPDATE habits SET updated_at=? WHERE id=?', this.now(), h.id); }
  ingest(job, data, supplied) {
    if (!Array.isArray(data.habits) || data.habits.length > 12 || !Array.isArray(data.moods) || data.moods.length > 5) throw Error('成长候选格式无效。');
    const events = new Map(this.s.jobEvents(job).map(e => [e.id, e])); let accepted = 0, rejected = 0;
    this.s.tx(() => {
      if (this.s.get('SELECT status FROM jobs WHERE id=?', job.id)?.status !== 'running') return;
      if (this.s.settings().habitLearningEnabled) for (const p of data.habits) {
        const e = events.get(p.human_event_id), style = styleCatalog[p.style];
        if (!e || !supplied.has(e.id) || e.actor !== 'human' || !e.actor_ref || !style || !Object.hasOwn(contexts, p.context) || !['request','praise','rejection'].includes(p.kind)) { rejected++; continue; }
        let reply = null;
        if (p.kind === 'request' && !styleRequested(p.style, e.content)) { rejected++; continue; }
        if (p.kind === 'rejection' && !styleRejected(p.style, e.content)) { rejected++; continue; }
        if (p.kind === 'praise') {
          reply = this.s.get("SELECT a.id,a.content FROM event_replies x JOIN events a ON a.id=x.reply_event_id JOIN turns t ON t.id=a.turn_id WHERE x.event_id=? AND a.id=? AND a.actor='assistant' AND t.room_key=?", e.id, p.assistant_event_id, job.room_key);
          if (!reply || !explicitPraise(feedbackText(e.content))) { rejected++; continue; }
          // A praise about an unrelated behavior cannot endorse every style in the catalog.
          if (!style.positive.test(reply.content) && !(p.style === 'concise' && reply.content.length <= 100) && !(p.style === 'detailed' && reply.content.length >= 150)) { rejected++; continue; }
        }
        const scope = job.room_key.startsWith('group:') ? 'room' : 'relationship';
        let h = this.s.get('SELECT * FROM habits WHERE style=? AND context=? ORDER BY created_at,id LIMIT 1', p.style, p.context);
        if (!h) { const id = randomUUID(); this.s.run('INSERT INTO habits VALUES (?,?,?,?,?,?,?,?)', id, scope, job.room_key, p.style, p.context, 'candidate', this.now(), this.now()); h = this.s.get('SELECT * FROM habits WHERE id=?', id); }
        this.addEvidence(h, e.id, reply?.id ?? null, p.kind, p.kind === 'rejection' ? 4 : 3);
        if (p.kind === 'rejection') this.suspend(h.id, 'human_rejection'); else this.reconcile(h.id);
        accepted++;
      }
      if (this.s.settings().moodSimulationEnabled) for (const p of data.moods) {
        const e = events.get(p.event_id);
        if (!e || !supplied.has(e.id) || e.actor !== 'human' || !e.actor_ref || !['开心','踏实','甜蜜','心疼','担心','难过','吃醋'].includes(p.emotion) || !Number.isFinite(p.delta) || Math.abs(p.delta) > 5 || !Number.isFinite(p.strength) || p.strength < 0 || p.strength > 10 || !Number.isFinite(p.confidence) || p.confidence < .8 || p.confidence > 1) { rejected++; continue; }
        this.s.run('INSERT OR IGNORE INTO mood_impulses VALUES (?,?,?,?,?,?,?)', e.id, job.room_key, e.at, p.emotion, p.delta, p.strength, p.confidence); accepted++;
      }
      this.s.run("UPDATE jobs SET status='done',error_code=? WHERE id=?", rejected ? 'some_candidates_rejected' : '', job.id);
      this.s.audit('growth_extracted', job.id, `accepted=${accepted},rejected=${rejected}`); this.s.bump();
    }); return { accepted, rejected };
  }
  reconcile(id) {
    const h = this.habit(id); if (['retired','rejected','paused'].includes(h.status)) return;
    if (h.conflict) return this.suspend(id, 'conflicting_feedback');
    if (h.eligible && h.status !== 'active') { const status = this.s.settings().habitAutoActivateEnabled && !this.s.settings().learningDryRun ? 'active' : 'consolidated'; this.s.run('UPDATE habits SET status=?,updated_at=? WHERE id=?', status, this.now(), id); if (status !== h.status) this.s.audit('habit_' + status, id); }
  }
  suspend(id, reason) {
    const h = this.s.get('SELECT style,context FROM habits WHERE id=?', id);
    const ids = new Set(this.s.all('SELECT id FROM habits WHERE style=? AND context=?', h.style, h.context).map(v => v.id));
    for (const key of ids) { this.s.run("UPDATE habits SET status=CASE WHEN status IN ('retired','paused') THEN status ELSE 'candidate' END,updated_at=? WHERE id=?", this.now(), key); this.s.audit(reason, key); }
    this.invalidate(ids, reason); this.s.bump();
  }
  updateHabit(id, action, resolveConflict = false) {
    return this.s.tx(() => {
      if (!['activate','pause','retire','review'].includes(action)) throw Error('习惯操作无效。');
      const h = this.habit(id);
      const peers = this.s.all('SELECT id FROM habits WHERE style=? AND context=?', h.style, h.context).map(p => p.id);
      if (resolveConflict) { for (const peer of peers) this.s.run("UPDATE habit_evidence SET resolved=1 WHERE habit_id=? AND kind='rejection'", peer); this.s.audit('habit_conflict_reviewed', id); }
      if (action === 'activate') {
        if (this.s.settings().learningDryRun) throw Error('请先关闭只收集候选。');
        const checked = this.habit(id); if (!checked.eligible) throw Error('不能启用：' + checked.reasons.join('、'));
        for (const peer of peers) this.s.run("UPDATE habits SET status='active',updated_at=? WHERE id=?", this.now(), peer);
      } else { this.suspend(id, 'habit_' + action); for (const peer of peers) this.s.run('UPDATE habits SET status=?,updated_at=? WHERE id=?', action === 'retire' ? 'retired' : action === 'pause' ? 'paused' : 'candidate', this.now(), peer); }
      this.s.audit('habit_' + action, id); this.s.bump(); return this.habit(id);
    });
  }
  share(id) {
    return this.updateHabit(id, 'activate'); // Compatibility with older authenticated management pages.
  }
  scope() { return 'shared'; }
  head(scope) {
    scope = 'shared';
    const row = this.s.get('SELECT v.* FROM persona_heads h JOIN persona_versions v ON v.id=h.version_id WHERE h.scope_key=?', scope);
    return row ?? this.version(scope, neutralTraits(), null, [], 'system', 'initial', null);
  }
  version(scope, values, manual, sources, actor, reason, parent, proposal = null) {
    scope = 'shared';
    return this.s.tx(() => {
    const id = randomUUID(), old = parent ? parse(this.s.get('SELECT traits FROM persona_versions WHERE id=?', parent).traits) : neutralTraits();
    this.s.run('INSERT INTO persona_versions VALUES (?,?,?,?,?,?,?,?,?,?)', id, scope, this.now(), actor, reason, JSON.stringify(values), manual, JSON.stringify(sources), 1, parent);
    this.s.run('INSERT INTO persona_heads VALUES (?,?) ON CONFLICT(scope_key) DO UPDATE SET version_id=excluded.version_id', scope, id);
    for (const trait of traits) if (Math.abs(values[trait] - old[trait]) > .0000001) this.s.run('INSERT INTO trait_changes(scope_key,trait,old_value,new_value,amount,at,proposal_id,version_id,actor) VALUES (?,?,?,?,?,?,?,?,?)', scope, trait, old[trait], values[trait], Math.abs(values[trait] - old[trait]), this.now(), proposal, id, actor);
    this.s.audit('persona_version', id, reason); this.s.bump(); return this.s.get('SELECT * FROM persona_versions WHERE id=?', id);
    });
  }
  sourcesValid(ids) { return ids.length > 0 && ids.every(id => { try { const h = this.habit(id); return h.status === 'active' && h.eligible; } catch { return false; } }); }
  proposal(scope) {
    scope = 'shared';
    const rows = [...new Map(this.s.all("SELECT id FROM habits WHERE status='active' ORDER BY created_at,id").map(h => this.habit(h.id)).filter(h => h.eligible && this.sourcesValid([h.id])).map(h => [h.style + ':' + h.context, h])).values()];
    if (!rows.length) return null;
    const head = this.head(scope); if (head.manual_text !== null) return null;
    const targets = {}, sources = rows.map(h => h.id).sort();
    for (const trait of traits) { const related = rows.filter(h => styleCatalog[h.style].trait === trait); if (related.length) targets[trait] = related.reduce((n, h) => n + styleCatalog[h.style].target, 0) / related.length; }
    const existing = this.s.get("SELECT id FROM persona_proposals WHERE scope_key=? AND base_version=? AND status='pending' AND targets=? AND source_habits=?", scope, head.id, JSON.stringify(targets), JSON.stringify(sources));
    if (existing) return existing.id;
    const id = randomUUID(); this.s.run('INSERT INTO persona_proposals VALUES (?,?,?,?,?,?,?)', id, scope, this.now(), 'pending', head.id, JSON.stringify(targets), JSON.stringify(sources)); this.s.audit('persona_proposed', id); return id;
  }
  commit(id, actor = 'admin') {
    return this.s.tx(() => {
      const p = this.s.get('SELECT * FROM persona_proposals WHERE id=?', id); if (!p || p.status !== 'pending' || p.scope_key !== 'shared') throw Error('提案不存在或已处理。');
      if (this.s.settings().learningDryRun) throw Error('试运行只生成提案。');
      const head = this.head(p.scope_key), sources = parse(p.source_habits); if (head.id !== p.base_version || head.manual_text !== null) throw Error('人格版本已变更或正在手动接管，请重新反思。');
      if (!this.sourcesValid(sources)) throw Error('提案来源已撤销、暂停或证据不足。');
      const values = parse(head.traits), targets = parse(p.targets); let changed = false;
      for (const [trait, target] of Object.entries(targets)) {
        if (!traits.includes(trait) || !Number.isFinite(target) || target < 0 || target > 1) throw Error('非法人格维度。');
        const spent = this.s.get('SELECT COALESCE(SUM(amount),0) AS n FROM trait_changes WHERE trait=? AND at>?', trait, this.now() - 86400000).n;
        const remaining = Math.max(0, this.s.settings().traitDailyLimit - spent), step = Math.max(-remaining, Math.min(remaining, .1 * (target - values[trait])));
        if (Math.abs(step) > .0000001) { values[trait] = Math.max(0, Math.min(1, values[trait] + step)); changed = true; }
      }
      if (!changed) throw Error('当前 24 小时变化额度已用完，或已接近目标。');
      const version = this.version(p.scope_key, values, null, [...new Set([...parse(head.source_habits).filter(id => this.sourcesValid([id])), ...sources])], actor, 'evolution', head.id, id);
      this.s.audit('persona_policy_passed', version.id, JSON.stringify({ validHumanEvidence: true, scoped: true, fixedCoreUnchanged: true, dailyLimit: this.s.settings().traitDailyLimit, rate: .1 }));
      this.s.run("UPDATE persona_proposals SET status='committed' WHERE id=?", id); return version;
    });
  }
  cancel(id) { this.s.run("UPDATE persona_proposals SET status='cancelled' WHERE id=? AND status='pending'", id); this.s.audit('persona_proposal_cancelled', id); }
  rollback(scope, id) {
    scope = 'shared';
    return this.s.tx(() => {
      const target = this.s.get('SELECT * FROM persona_versions WHERE id=? AND scope_key=? AND valid=1', id, scope);
      if (!target || (parse(target.source_habits).length && !this.sourcesValid(parse(target.source_habits)))) throw Error('该版本来源已失效，不能恢复。');
      return this.version(scope, parse(target.traits), target.manual_text, parse(target.source_habits), 'admin', 'rollback', this.head(scope).id);
    });
  }
  invalidate(ids, reason) {
    for (const v of this.s.all('SELECT * FROM persona_versions WHERE valid=1')) if (parse(v.source_habits).some(id => ids.has(id))) this.s.run("UPDATE persona_versions SET valid=0,manual_text=NULL,source_habits='[]',traits=? WHERE id=?", JSON.stringify(neutralTraits()), v.id);
    for (const p of this.s.all("SELECT * FROM persona_proposals WHERE status='pending'")) if (parse(p.source_habits).some(id => ids.has(id))) this.s.run("UPDATE persona_proposals SET status='invalidated',source_habits='[]',targets='{}' WHERE id=?", p.id);
    for (const h of this.s.all("SELECT h.scope_key,h.version_id FROM persona_heads h JOIN persona_versions v ON v.id=h.version_id WHERE v.valid=0 AND h.scope_key='shared'")) {
      const previous = this.s.get('SELECT * FROM persona_versions WHERE scope_key=? AND valid=1 ORDER BY at DESC,rowid DESC LIMIT 1', h.scope_key);
      this.version(h.scope_key, previous ? parse(previous.traits) : neutralTraits(), previous?.manual_text ?? null, previous ? parse(previous.source_habits) : [], 'system', reason, h.version_id);
    }
  }
  eraseSources(turnIds, roomKey) {
    const ids = new Set(roomKey ? this.s.all('SELECT id FROM habits WHERE scope_key=?', roomKey).map(h => h.id) : []);
    for (const turn of turnIds) for (const h of this.s.all('SELECT DISTINCT x.habit_id FROM habit_evidence x JOIN events e ON e.id=x.event_id WHERE e.turn_id=?', turn)) ids.add(h.habit_id);
    for (const id of ids) for (const h of this.s.all('SELECT child_id FROM habit_dependencies WHERE parent_id=?', id)) ids.add(h.child_id);
    const rows = [...ids].map(id => this.s.get('SELECT * FROM habits WHERE id=?', id)), affected = new Set(ids);
    for (const h of rows.filter(Boolean)) for (const peer of this.s.all('SELECT id FROM habits WHERE style=? AND context=?', h.style, h.context)) affected.add(peer.id);
    this.invalidate(affected, 'source_erased');
    for (const id of ids) this.s.run('DELETE FROM habits WHERE id=?', id);
    if (roomKey) this.s.run('DELETE FROM mood_impulses WHERE room_key=?', roomKey);
    return { rooms: rows.filter(h => h && h.scope !== 'persona').map(h => h.scope_key), allRooms: rows.some(h => h?.scope === 'persona') };
  }
  queueReflection(manual = false) {
    const cfg = this.s.settings(); if (!manual && !cfg.reflectionEnabled) return false;
    if (this.s.get("SELECT id FROM reflection_jobs WHERE status IN ('queued','running')")) return false;
    const last = this.s.get('SELECT MAX(at) AS at FROM reflection_jobs')?.at ?? 0;
    if (!manual && this.now() - last < cfg.reflectionHours * 3600000) return false;
    this.s.run("INSERT INTO reflection_jobs VALUES (?,?,'queued')", randomUUID(), this.now()); return true;
  }
  reflect() {
    const job = this.s.get("SELECT * FROM reflection_jobs WHERE status='queued' ORDER BY at LIMIT 1"); if (!job) return false;
    this.s.tx(() => {
      this.s.run("UPDATE reflection_jobs SET status='running' WHERE id=?", job.id);
      const cfg = this.s.settings(), scopes = ['shared'];
      for (const scope of scopes) { const proposal = this.proposal(scope); if (proposal && cfg.personalityEnabled && cfg.personalityAutoCommitEnabled && !cfg.learningDryRun) { try { this.commit(proposal, 'automatic'); } catch { /* Existing limits, evidence and manual ownership remain authoritative. */ } } }
      this.s.run("UPDATE reflection_jobs SET status='done' WHERE id=?", job.id); this.s.audit('reflection_completed', job.id);
    }); return true;
  }
  mood(roomKey) {
    const cfg = this.s.settings(), emotions = {}; let value = 70;
    for (const row of this.s.all('SELECT * FROM mood_impulses WHERE room_key=?', roomKey)) {
      const hours = Math.max(0, this.now() - row.at) / 3600000;
      value += row.delta * 2 ** (-hours / cfg.moodHalfLifeHours); emotions[row.emotion] = (emotions[row.emotion] ?? 0) + row.strength * 2 ** (-(hours * 60) / cfg.moodEmotionHalfLifeMinutes);
    }
    return { value: Math.max(0, Math.min(100, value)), baseline: 70, emotions: Object.fromEntries(Object.entries(emotions).map(([key, v]) => [key, Math.min(100, v)])), at: this.now() };
  }
  resetMood(roomKey) { this.s.run('DELETE FROM mood_impulses WHERE room_key=?', roomKey); this.s.audit('mood_reset', '', roomKey); this.s.bump(); }
  view(roomKey) {
    const scope = this.scope(roomKey), head = this.head(scope), cfg = this.s.settings();
    const sourceValid = !parse(head.source_habits).length || this.sourcesValid(parse(head.source_habits));
    const text = sourceValid ? head.manual_text ?? traitDescription(parse(head.traits)) : '';
    const effective = cfg.personalityEnabled && !cfg.learningDryRun && this.settings.value.memoryEnabled ? text : '';
    return { scope, core: this.settings.value.persona, learned: text, applied: effective, persona: this.settings.value.persona + (effective ? marker + effective : ''),
      revision: stableId(this.settings.personaRevision(), scope, head.id, cfg.personalityEnabled, cfg.learningDryRun, this.settings.value.memoryEnabled, sourceValid), head: { ...head, traits: parse(head.traits), source_habits: parse(head.source_habits) },
      versions: this.s.all('SELECT * FROM persona_versions WHERE scope_key=? ORDER BY at DESC,rowid DESC LIMIT 20', scope).map(v => ({ ...v, traits: parse(v.traits), source_habits: parse(v.source_habits) })),
      proposals: this.s.all('SELECT * FROM persona_proposals WHERE scope_key=? ORDER BY at DESC,rowid DESC LIMIT 20', scope).map(p => ({ ...p, targets: parse(p.targets), source_habits: parse(p.source_habits) })), mood: this.mood(roomKey) };
  }
  edit(view, text) {
    const split = text.indexOf(marker), core = split < 0 ? text : text.slice(0, split), learned = split < 0 ? '' : text.slice(split + marker.length);
    if (learned.length > 1500) throw Error('学习风格的手动内容最多 1500 字。');
    if (learned !== view.applied) this.version(view.scope, view.head.traits, learned, view.head.source_habits, 'admin', 'manual_override', view.head.id);
    return core;
  }
  resumeAutomatic(scope) { const h = this.head(scope); return this.s.tx(() => this.version(scope, parse(h.traits), null, parse(h.source_habits), 'admin', 'resume_automatic', h.id)); }
  hints(roomKey, query) {
    const cfg = this.s.settings(); if (!this.settings.value.memoryEnabled || cfg.learningDryRun) return {};
    const result = {};
    if (cfg.personalityEnabled) { const v = this.view(roomKey); if (v.applied && !v.head.source_habits.some(id => { const h = this.s.get('SELECT style FROM habits WHERE id=?', id); return h && styleRejected(h.style, query); })) result.style = v.applied; }
    if (cfg.habitLearningEnabled) {
      const rows = this.s.all("SELECT id FROM habits WHERE status='active'").map(h => this.habit(h.id)).filter(h => h.eligible && this.sourcesValid([h.id]) && !styleRejected(h.style, query) && (h.context === 'general' || relevance(query, contexts[h.context]) > 0 || (h.context === 'technical' && /代码|报错|编程|函数|程序|技术/.test(query)) || (h.context === 'game' && /游戏|星露谷|开黑|副本/.test(query)) || (h.context === 'casual' && /哈哈|好玩|闲聊/.test(query))));
      const rules = [...new Set(rows.slice(0, 3).map(h => h.rule))]; if (rules.length) result.habits = rules;
    }
    if (cfg.moodSimulationEnabled) { const m = this.mood(roomKey); const top = Object.entries(m.emotions).filter(([, v]) => v >= .5).sort((a, b) => b[1] - a[1]).slice(0, 2); if (Math.abs(m.value - 70) >= .5 || top.length) result.mood = { value: Math.round(m.value), emotions: top.map(([key]) => key) }; }
    return result;
  }
}
