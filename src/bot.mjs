import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export class GroupBot {
  constructor(config, qq, codex) {
    this.config = config; this.qq = qq; this.codex = codex;
    this.file = resolve(config.runtime, 'groups.json');
    this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { rooms: {}, seen: [] };
    this.running = new Map(); this.queue = []; this.workers = 0;
    for (const room of Object.values(this.state.rooms)) {
      if (room.status === '运行中' || room.status === '排队中') room.lastResult = '服务曾重启，上次未完成的任务请重新提问。';
      room.status = '空闲';
    }
    this.metrics = { verifiedCallbacks: 0, receivedMessages: 0, sentReplies: 0, lastEvent: null, lastFailure: null };
  }
  save() {
    writeFileSync(this.file + '.tmp', JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file);
  }
  room(id) {
    if (!Object.hasOwn(this.state.rooms, id)) {
      if (Object.keys(this.state.rooms).length >= 200) throw new Error('群数量已达到本地限制。');
      this.state.rooms[id] = { threadId: null, profile: '', history: [], nextSeq: 0, lastSentSeq: 0, status: '空闲' };
    }
    return this.state.rooms[id];
  }
  accept(event) {
    const type = event.t;
    if (!['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'].includes(type)) return;
    const d = event.d;
    if (!d || typeof d.group_openid !== 'string' || typeof d.id !== 'string' || typeof d.content !== 'string') return;
    const group = d.group_openid;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(group)) return;
    if (this.config.allowedGroups.size && !this.config.allowedGroups.has(group)) return;
    if (d.author?.bot) return;
    const key = type + ':' + group + ':' + d.id;
    if (this.state.seen.includes(key)) return;
    this.state.seen.push(key); this.state.seen = this.state.seen.slice(-3000);
    this.metrics.receivedMessages++; this.metrics.lastEvent = type;
    const room = this.room(group);
    const text = d.content.replace(/^\s*<@!?[^>]+>\s*/, '').trim().slice(0, 8000);
    const message = {
      group, id: d.id, text, sender: String(d.author?.member_openid ?? d.author?.id ?? 'unknown'),
      name: String(d.author?.username ?? ''), role: d.author?.member_role,
      receivedAt: Date.now(), eventAt: Date.parse(d.timestamp) || Date.now()
    };
    if (!text.startsWith('/') && !room.history.some(item => item.id === d.id)) {
      room.history.push({ id: d.id, seq: ++room.nextSeq, sender: message.name || message.sender, text });
      room.history = room.history.slice(-72);
    }
    message.seq = room.nextSeq;
    this.save();
    // Subscribe to GROUP_AT_MESSAGE_CREATE for replies; optional full events only enrich context.
    if (type !== 'GROUP_AT_MESSAGE_CREATE') return;
    if (text.startsWith('/')) { void this.command(room, message).catch(() => this.failure('命令处理失败')); return; }
    const queued = this.queue.filter(job => job.group === group).length;
    if (queued >= 5 || this.queue.length >= 100) { void this.reply(message, '排队较多，请稍后再试。'); return; }
    this.queue.push(message);
    if (!this.running.has(group)) room.status = '排队中';
    this.save(); this.drain();
  }
  failure(message) { this.metrics.lastFailure = message; console.error(new Date().toISOString(), message); }
  async reply(message, content) {
    try { await this.qq.reply(message.group, message.id, content); this.metrics.sentReplies++; }
    catch (error) { this.failure(error.message); }
  }
  async command(room, message) {
    const command = message.text.split(/\s+/, 1)[0];
    let text;
    if (['/状态', '/status'].includes(command)) {
      text = `[Codex 状态]\n会话：${room.threadId ? room.threadId.slice(0, 8) : '尚未开始'}\n任务：${room.status}\n模型：${room.model ?? this.config.model}${room.threadId ? '' : '（配置值）'}\n推理：${this.config.effort}\n引擎：${this.codex.ready ? '常驻 App Server 已连接' : '尚未连接'}\n沙箱：${room.sandbox ?? 'read-only（预设）'}\n群聊档案：${room.profile ? '已设置' : '未设置'}\n近期上下文：每群最多 12 条（增量发送）\n本群排队：${this.queue.filter(job => job.group === message.group).length}`;
    } else if (['/帮助', '/help'].includes(command)) {
      text = '直接 @我提问。\n/状态：连接和任务状态\n/结果：上次结果\n/群档案：查看背景\n/设置群档案 内容：管理员设置背景\n/新会话：管理员重开会话\n/停止：提问者或管理员停止任务';
    } else if (command === '/群档案') {
      text = room.profile || '尚未设置。管理员可发送 /设置群档案 内容';
    } else if (command === '/设置群档案') {
      if (!['owner', 'admin'].includes(message.role)) text = '这个指令需要群主或管理员身份。';
      else { room.profile = message.text.slice(command.length).trim().slice(0, 3000); text = room.profile ? '群档案已更新。' : '群档案已清空。'; }
    } else if (command === '/新会话') {
      if (!['owner', 'admin'].includes(message.role)) text = '这个指令需要群主或管理员身份。';
      else if (this.running.has(message.group)) text = '请先用 /停止 结束当前任务，再新建会话。';
      else { this.queue = this.queue.filter(job => job.group !== message.group); room.threadId = null; room.history = []; room.lastSentSeq = room.nextSeq; room.lastResult = ''; room.status = '空闲'; text = '已开始新会话，群档案保留。'; }
    } else if (command === '/停止') {
      const running = this.running.get(message.group);
      if (!['owner', 'admin'].includes(message.role) && running?.sender !== message.sender) text = '只有当前提问者、群主或管理员可以停止任务。';
      else {
        if (running) running.cancelled = true;
        this.queue = this.queue.filter(job => job.group !== message.group);
        if (room.threadId) await this.codex.interrupt(room.threadId);
        if (!running) room.status = '空闲';
        text = '已请求停止，并清空本群待处理问题。';
      }
    } else if (command === '/结果') text = room.lastResult || '还没有可查看的结果。';
    else text = '未知指令，发送 /帮助 查看支持的指令。';
    this.save(); await this.reply(message, text);
  }
  drain() {
    while (this.workers < 2) {
      const index = this.queue.findIndex(job => !this.running.has(job.group));
      if (index < 0) break;
      const [job] = this.queue.splice(index, 1);
      this.workers++; this.running.set(job.group, job);
      void this.run(job).finally(() => { this.workers--; this.running.delete(job.group); this.drain(); });
    }
  }
  async run(job) {
    const room = this.room(job.group); room.status = '运行中'; this.save();
    try {
      let remaining = 270_000 - (Date.now() - job.eventAt);
      if (remaining < 20_000) throw new Error('排队时间过长，请重新 @我发送问题。');
      await this.codex.prepare(room); this.save();
      if (job.cancelled) throw new Error('任务已停止。');
      remaining = 270_000 - (Date.now() - job.eventAt);
      if (remaining < 20_000) throw new Error('处理时间过长，请重新 @我发送问题。');
      const recent = room.history.filter(item => item.seq > room.lastSentSeq && item.seq <= job.seq).slice(-12);
      const prompt = JSON.stringify({ groupProfile: room.profile, recentMessages: recent.map(({ sender, text }) => ({ sender, text })), currentQuestion: { sender: job.name || job.sender, text: job.text } });
      const result = await this.codex.ask(room, prompt, Math.min(220_000, remaining));
      room.lastSentSeq = job.seq; room.lastResult = result;
      this.save(); await this.reply(job, result);
    } catch (error) {
      room.lastResult = error.message;
      this.failure('本群任务未完成：' + error.message);
      await this.reply(job, error.message);
    } finally { room.status = this.queue.some(pending => pending.group === job.group) ? '排队中' : '空闲'; this.save(); }
  }
}
