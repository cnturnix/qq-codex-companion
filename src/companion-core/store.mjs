import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { learningDefaults, validateSettings, cleanText, sensitive, relevance } from './policy.mjs';

export class MemoryStore {
  constructor(file, { now = Date.now } = {}) {
    this.now = now; this.file = file; this.depth = 0;
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file, { timeout: 50, enableForeignKeyConstraints: true, allowExtension: false });
    try {
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > 3) throw Error('记忆数据库版本较新，请使用匹配的程序。');
      if (version === 0 && this.get("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) throw Error('发现未标记版本的现有数据库，未覆盖。');
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;');
      this.tx(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, room_key TEXT NOT NULL, principal TEXT, trigger TEXT NOT NULL, at INTEGER NOT NULL, processed INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS identities (principal TEXT PRIMARY KEY, room_key TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE, provider_id TEXT NOT NULL, actor TEXT NOT NULL CHECK(actor IN ('human','assistant')), content TEXT NOT NULL, at INTEGER NOT NULL);
          CREATE INDEX IF NOT EXISTS events_turn ON events(turn_id);
          CREATE INDEX IF NOT EXISTS turns_pending ON turns(processed, room_key, at);
          CREATE TABLE IF NOT EXISTS tombstones (id TEXT PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('persona','room','relationship','private_local')), scope_key TEXT NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL, canonical_key TEXT NOT NULL, confidence REAL NOT NULL, importance REAL NOT NULL, status TEXT NOT NULL CHECK(status IN ('candidate','active','disabled','superseded')), manual INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, superseded_by TEXT);
          CREATE INDEX IF NOT EXISTS memory_scope ON memories(scope, scope_key, status);
          CREATE UNIQUE INDEX IF NOT EXISTS memory_active_key ON memories(scope, scope_key, canonical_key) WHERE status='active';
          CREATE TABLE IF NOT EXISTS evidence (memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE, PRIMARY KEY(memory_id,event_id));
          CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, room_key TEXT NOT NULL, turn_ids TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, not_before INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, error_code TEXT NOT NULL DEFAULT '');
          CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, started_at INTEGER NOT NULL, tokens INTEGER NOT NULL, state TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL, entity_id TEXT NOT NULL, detail TEXT NOT NULL);
        `);
        if (version < 2) this.db.exec('ALTER TABLE events ADD COLUMN actor_ref TEXT; PRAGMA user_version=2;');
        this.run('INSERT OR IGNORE INTO meta VALUES (?,?)', 'persona', randomUUID());
        this.run('INSERT OR IGNORE INTO meta VALUES (?,?)', 'settings', JSON.stringify(learningDefaults));
        this.run('INSERT OR IGNORE INTO meta VALUES (?,?)', 'revision', '0');
        const settings = JSON.parse(this.get("SELECT value FROM meta WHERE key='settings'").value);
        if (!this.get("SELECT value FROM meta WHERE key='account_sharing'")) {
          settings.learnedPersonaScope = 'shared';
          this.run("UPDATE meta SET value=? WHERE key='settings'", JSON.stringify(settings));
          this.run("INSERT INTO meta VALUES ('account_sharing','1')");
          this.audit('account_sharing_enabled'); this.bump();
        }
        this.run("UPDATE jobs SET status=CASE WHEN attempts>=2 THEN 'failed' ELSE 'queued' END, error_code='restart_recovery' WHERE status='running'");
      });
    } catch (error) { this.db.close(); throw error; }
  }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  tx(fn) {
    if (this.depth) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.depth++;
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.depth--; }
  }
  settings() { return { ...learningDefaults, ...JSON.parse(this.get("SELECT value FROM meta WHERE key='settings'").value) }; }
  updateSettings(patch) {
    const next = validateSettings(this.settings(), patch);
    this.tx(() => { this.run("UPDATE meta SET value=? WHERE key='settings'", JSON.stringify(next)); this.audit('settings_updated', '', Object.keys(patch).join(',')); this.bump(); });
    return next;
  }
  audit(action, id = '', detail = '') { this.run('INSERT INTO audit(at,action,entity_id,detail) VALUES (?,?,?,?)', this.now(), action, id, detail); }
  bump() { this.run("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'"); }
  revision() { return Number(this.get("SELECT value FROM meta WHERE key='revision'").value); }
  forgotten(id) { return Boolean(this.get('SELECT id FROM tombstones WHERE id=?', id)); }
  capture(turn) {
    if (this.forgotten(turn.id) || this.get('SELECT id FROM turns WHERE id=?', turn.id)) return false;
    if (this.get('SELECT COUNT(*) AS n FROM events').n >= 50000 || this.get('SELECT COUNT(*) AS n FROM turns WHERE processed=0').n >= 1000) return false;
    const events = turn.events.filter(e => !this.forgotten(e.id) && !this.get('SELECT id FROM events WHERE id=?', e.id) && e.content && !sensitive(e.content));
    if (!events.some(e => e.actor === 'human')) return false;
    return this.tx(() => {
      this.run('INSERT INTO turns(id,room_key,principal,trigger,at) VALUES (?,?,?,?,?)', turn.id, turn.roomKey, turn.principal, turn.trigger, turn.at);
      if (turn.principal && turn.roomKey.startsWith('private:')) this.run('INSERT OR REPLACE INTO identities VALUES (?,?)', turn.principal, turn.roomKey);
      for (const e of events) this.run('INSERT INTO events(id,turn_id,provider_id,actor,content,at,actor_ref) VALUES (?,?,?,?,?,?,?)', e.id, turn.id, e.providerId, e.actor, e.content, e.at, e.actorRef ?? null);
      return true;
    });
  }
  createJobs({ manual = false, roomKey = null, allowed = () => true } = {}) {
    const batch = this.settings().batchTurns;
    const rooms = this.all('SELECT room_key,COUNT(*) AS n FROM turns WHERE processed=0 GROUP BY room_key'); let created = 0;
    this.tx(() => { for (const r of rooms) {
      if (!allowed(r.room_key) || (roomKey && r.room_key !== roomKey) || (!manual && r.n < batch)) continue;
      const rows = this.all('SELECT id FROM turns WHERE processed=0 AND room_key=? ORDER BY at,id LIMIT ?', r.room_key, batch);
      const id = randomUUID(); this.run('INSERT INTO jobs(id,room_key,turn_ids,status,created_at) VALUES (?,?,?,?,?)', id, r.room_key, JSON.stringify(rows.map(r => r.id)), 'queued', this.now());
      for (const row of rows) this.run('UPDATE turns SET processed=1 WHERE id=?', row.id);
      this.audit('extraction_queued', id, manual ? 'manual' : 'batch'); created++;
    } });
    return created;
  }
  jobEvents(job) {
    const ids = JSON.parse(job.turn_ids);
    if (!ids.length) return [];
    return this.all(`SELECT e.*,t.room_key,t.principal,t.trigger FROM events e JOIN turns t ON t.id=e.turn_id WHERE t.room_key=? AND t.id IN (${ids.map(() => '?').join(',')}) ORDER BY t.at DESC,e.at`, job.room_key, ...ids);
  }
  nextJob(allowed, kindAllowed = () => true) { return this.all("SELECT * FROM jobs WHERE status='queued' AND attempts<2 AND not_before<=? ORDER BY created_at LIMIT 100", this.now()).find(j => allowed(j.room_key) && kindAllowed(j.kind ?? 'memory')); }
  quota() {
    const limits = this.settings();
    const day = this.get('SELECT COUNT(*) AS calls,COALESCE(SUM(tokens),0) AS tokens FROM calls WHERE started_at>?', this.now() - 86400000);
    const hour = this.get('SELECT COUNT(*) AS calls FROM calls WHERE started_at>?', this.now() - 3600000);
    return { ...day, hourlyCalls: hour.calls, permitted: day.calls < limits.maxLearningCodexCallsPerDay && hour.calls < limits.maxLearningCodexCallsPerHour && day.tokens + 4000 <= limits.maxLearningTokensPerDay };
  }
  startJob(job) {
    return this.tx(() => {
      if (!this.quota().permitted || this.get('SELECT status FROM jobs WHERE id=?', job.id)?.status !== 'queued') return null;
      this.run("UPDATE jobs SET status='running',attempts=attempts+1,error_code='' WHERE id=?", job.id);
      const callId = randomUUID(); this.run('INSERT INTO calls VALUES (?,?,?,?,?)', callId, job.id, this.now(), 4000, 'running'); return callId;
    });
  }
  finishCall(id, tokens, state) { this.run('UPDATE calls SET tokens=?,state=? WHERE id=?', Math.max(4000, Number(tokens) || 0), state, id); }
  failJob(id, code) {
    this.run("UPDATE jobs SET status=CASE WHEN attempts>=2 THEN 'failed' ELSE 'queued' END,not_before=?,error_code=? WHERE id=? AND status='running'", this.now() + 300000, code, id);
    this.audit('extraction_not_completed', id, code);
  }
  propose(job, proposals, suppliedIds) {
    if (!Array.isArray(proposals) || proposals.length > 12) throw Error('候选格式无效。');
    return this.tx(() => {
      if (this.get('SELECT status FROM jobs WHERE id=?', job.id)?.status !== 'running') return 0;
      let count = 0, rejected = 0;
      for (const p of proposals) {
        try {
          const content = cleanText(p.text), canonical = cleanText(p.canonical_key, 100);
          if (sensitive(content) || !['episodic', 'semantic', 'preference'].includes(p.type) || !/^[\p{L}\p{N}_.:\- ]+$/u.test(canonical)) throw Error();
          if (![p.confidence, p.importance].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) throw Error();
          if (!Array.isArray(p.evidence_ids) || !p.evidence_ids.length || p.evidence_ids.length > 6 || p.evidence_ids.some(id => !suppliedIds.has(id))) throw Error();
          const events = [...new Set(p.evidence_ids)].map(id => this.get('SELECT e.*,t.room_key,t.principal FROM events e JOIN turns t ON t.id=e.turn_id WHERE e.id=?', id));
          if (events.some(e => !e || e.actor !== 'human' || e.room_key !== job.room_key || this.forgotten(e.id))) throw Error();
          const scope = job.room_key.startsWith('group:') ? 'room' : 'relationship';
          if (p.scope !== scope) throw Error();
          const key = scope === 'room' ? job.room_key : events[0].principal;
          if (!key || (scope === 'relationship' && events.some(e => e.principal !== key))) throw Error();
          const same = this.get("SELECT id FROM memories WHERE scope=? AND scope_key=? AND canonical_key=? AND content=? AND status IN ('candidate','active')", scope, key, canonical, content);
          const id = same?.id ?? randomUUID();
          if (!same) this.run('INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', id, scope, key, p.type, content, canonical, p.confidence, p.importance, 'candidate', 0, this.now(), this.now(), null);
          for (const e of events) this.run('INSERT OR IGNORE INTO evidence VALUES (?,?)', id, e.id);
          count++;
        } catch { rejected++; }
      }
      this.run("UPDATE jobs SET status='done',error_code=? WHERE id=?", rejected ? 'some_candidates_rejected' : '', job.id);
      this.audit('extraction_completed', job.id, `accepted=${count},rejected=${rejected}`); return count;
    });
  }
  memory(id) {
    const memory = this.get('SELECT * FROM memories WHERE id=?', id); if (!memory) throw Error('记忆不存在。');
    return { ...memory, evidence: this.all('SELECT e.id,e.actor,e.actor_ref,e.provider_id,e.content,e.at,t.room_key,t.trigger FROM evidence x JOIN events e ON e.id=x.event_id JOIN turns t ON t.id=e.turn_id WHERE x.memory_id=?', id),
      conflict: Boolean(this.get("SELECT id FROM memories WHERE scope=? AND scope_key=? AND canonical_key=? AND id<>? AND status='active'", memory.scope, memory.scope_key, memory.canonical_key, id)) };
  }
  list({ q = '', status = '', scope = '', offset = 0 } = {}) {
    const where = ['1=1'], args = [];
    for (const [column, value] of [['status', status], ['scope', scope]]) if (value) { where.push(`${column}=?`); args.push(value); }
    if (q) { where.push('instr(content,?)>0'); args.push(String(q).slice(0, 100)); }
    const sql = where.join(' AND ');
    return { total: this.get(`SELECT COUNT(*) AS n FROM memories WHERE ${sql}`, ...args).n,
      items: this.all(`SELECT * FROM memories WHERE ${sql} ORDER BY updated_at DESC,id LIMIT 100 OFFSET ?`, ...args, Math.max(0, Math.min(100000, Number(offset) || 0))) };
  }
  addManual({ scope, scopeKey = '', type = 'semantic', text, canonicalKey }) {
    if (!['persona', 'room', 'relationship', 'private_local'].includes(scope) || !['episodic', 'semantic', 'preference'].includes(type)) throw Error('记忆类型无效。');
    const content = cleanText(text), canonical = cleanText(canonicalKey, 100);
    if (sensitive(content)) throw Error('请勿在记忆中保存凭证或敏感身份号码。');
    const id = randomUUID();
    this.tx(() => {
      this.run('INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', id, scope, scopeKey, type, content, canonical, 1, 1, 'candidate', 1, this.now(), this.now(), null);
      this.audit('memory_added_by_admin', id);
    }); return this.memory(id);
  }
  updateMemory(id, patch) {
    return this.tx(() => {
    const current = this.memory(id);
    if (patch.text !== undefined) {
      const content = cleanText(patch.text); if (sensitive(content)) throw Error('请勿在记忆中保存凭证或敏感身份号码。');
      this.tx(() => { this.run("UPDATE memories SET content=?,manual=1,status='candidate',updated_at=? WHERE id=?", content, this.now(), id); this.audit('memory_corrected', id); this.bump(); });
    }
    if (patch.status !== undefined) {
      if (!['active', 'disabled', 'candidate'].includes(patch.status)) throw Error('记忆状态无效。');
      if (patch.status === 'active' && this.settings().learningDryRun) throw Error('当前是试运行，请先关闭“只收集候选”再确认使用。');
      if (patch.status === 'active' && !current.manual && !current.evidence.length) throw Error('来源证据已经不存在。');
      this.tx(() => {
        if (patch.status === 'active') this.run("UPDATE memories SET status='superseded',superseded_by=?,updated_at=? WHERE scope=? AND scope_key=? AND canonical_key=? AND id<>? AND status='active'", id, this.now(), current.scope, current.scope_key, current.canonical_key, id);
        this.run('UPDATE memories SET status=?,updated_at=? WHERE id=?', patch.status, this.now(), id); this.audit('memory_' + patch.status, id); this.bump();
      });
    }
    return this.memory(id);
    });
  }
  search({ query, existing = '', maxChars = 1200, limit = 4, includeLearned = true, references = [], allowedSource = () => true }) {
    // scope/key preserve provenance and conflict identity, not a conversation access boundary.
    const pool = [...(includeLearned ? this.all("SELECT * FROM memories WHERE status='active' AND scope<>'private_local' LIMIT 5000").filter(m => m.scope === 'persona' || allowedSource(m.scope === 'relationship' ? 'private:' + m.scope_key.slice(3) : m.scope_key)) : []), ...references];
    const ranked = pool.map(m => ({ ...m, score: relevance(query, m.content) * (.55 + .25 * (m.type === 'episodic' ? 2 ** (-(this.now() - m.created_at) / (30 * 86400000)) : 1) + .15 * m.importance + .05 * m.confidence) }))
      .filter(m => m.score > 0 && !existing.includes(m.content)).sort((a, b) => b.score - a.score || b.updated_at - a.updated_at);
    const selected = []; let size = 0;
    for (const m of ranked) { const entry = { id: m.id, scope: m.scope, source: m.scope_key || 'account', type: m.type, content: m.content }; const length = Buffer.byteLength(JSON.stringify(entry)); if (size + length > maxChars || selected.some(e => e.content === entry.content && e.source === entry.source)) continue; selected.push(entry); size += length; if (selected.length >= limit) break; }
    return selected;
  }
  erase({ memoryId = null, roomKey = null }) {
    if ((!memoryId && !roomKey) || (memoryId && roomKey)) throw Error('请指定一条记忆或一个会话。');
    return this.tx(() => {
      const target = memoryId ? this.memory(memoryId) : null;
      const initial = roomKey ? this.all('SELECT id FROM turns WHERE room_key=?', roomKey) : this.all('SELECT DISTINCT e.turn_id AS id FROM evidence x JOIN events e ON e.id=x.event_id WHERE x.memory_id=?', memoryId);
      const turnSet = new Set(initial.map(t => t.id)), rooms = new Set(roomKey ? [roomKey] : []), deleted = new Set(memoryId ? [memoryId] : []);
      if (roomKey) for (const m of this.all("SELECT id FROM memories WHERE (scope='room' AND scope_key=?) OR (scope='relationship' AND scope_key=?)", roomKey, roomKey.startsWith('private:') ? 'qq:' + roomKey.slice(8) : '__none__')) deleted.add(m.id);
      let size = -1;
      while (size !== turnSet.size + deleted.size) {
        size = turnSet.size + deleted.size;
        for (const id of deleted) {
          const m = this.get('SELECT * FROM memories WHERE id=?', id); if (!m) continue;
          for (const old of this.all('SELECT id FROM memories WHERE scope=? AND scope_key=? AND canonical_key=?', m.scope, m.scope_key, m.canonical_key)) deleted.add(old.id);
          for (const e of this.all('SELECT DISTINCT e.turn_id FROM evidence x JOIN events e ON e.id=x.event_id WHERE x.memory_id=?', id)) turnSet.add(e.turn_id);
        }
        for (const id of turnSet) for (const m of this.all('SELECT DISTINCT x.memory_id FROM evidence x JOIN events e ON e.id=x.event_id WHERE e.turn_id=?', id)) deleted.add(m.memory_id);
      }
      const turnIds = [...turnSet];
      const growthRooms = this.beforeErase?.(turnIds, roomKey) ?? { rooms: [], allRooms: false };
      for (const key of growthRooms.rooms) rooms.add(key);
      if (target?.scope === 'room') rooms.add(target.scope_key);
      if (target?.scope === 'relationship') rooms.add('private:' + target.scope_key.slice(3));
      for (const id of turnIds) {
        const turn = this.get('SELECT room_key FROM turns WHERE id=?', id); if (turn) rooms.add(turn.room_key);
        for (const event of this.all('SELECT id FROM events WHERE turn_id=?', id)) {
          this.run('INSERT OR IGNORE INTO tombstones VALUES (?)', event.id);
          for (const m of this.all('SELECT memory_id FROM evidence WHERE event_id=?', event.id)) deleted.add(m.memory_id);
        }
        this.run('INSERT OR IGNORE INTO tombstones VALUES (?)', id);
      }
      for (const id of deleted) this.run('DELETE FROM memories WHERE id=?', id);
      for (const job of this.all("SELECT id,turn_ids FROM jobs WHERE status IN ('queued','running')")) if (JSON.parse(job.turn_ids).some(id => turnIds.includes(id))) this.run("UPDATE jobs SET status='cancelled',error_code='source_deleted',turn_ids='[]' WHERE id=?", job.id);
      for (const id of turnIds) this.run('DELETE FROM turns WHERE id=?', id);
      this.audit('source_and_memory_erased', memoryId ?? '', `memories=${deleted.size},turns=${turnIds.length}`); this.bump();
      return { rooms: [...rooms], allRooms: true, deletedMemories: deleted.size, deletedTurns: turnIds.length };
    });
  }
  summary() { return { settings: this.settings(), revision: this.revision(), events: this.get('SELECT COUNT(*) AS n FROM events').n, pendingTurns: this.get('SELECT COUNT(*) AS n FROM turns WHERE processed=0').n,
    memories: this.all('SELECT status,COUNT(*) AS count FROM memories GROUP BY status'), jobs: this.all('SELECT status,COUNT(*) AS count FROM jobs GROUP BY status'), recentJobs: this.all('SELECT id,status,attempts,error_code FROM jobs ORDER BY created_at DESC,id DESC LIMIT 5'), quota: this.quota(), recentAudit: this.all('SELECT * FROM audit ORDER BY id DESC LIMIT 15') }; }
  close() { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); this.db.close(); }
}
