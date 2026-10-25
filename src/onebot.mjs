import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';

const qqError = (code, message, action, retcode) => Object.assign(new Error(message), { code, action, retcode });

export class OneBotClient extends EventEmitter {
  constructor(endpoint, { WebSocketClass = WebSocket, timeout = 10000 } = {}) {
    super(); this.endpoint = endpoint; this.WebSocketClass = WebSocketClass; this.timeout = timeout;
    this.pending = new Map(); this.counter = 0; this.state = '等待 NapCat 配置'; this.connected = false; this.identity = null;
  }
  start() { this.stopped = false; this.connect(); }
  connect() {
    if (this.stopped || this.socket) return;
    let config;
    try { config = this.endpoint(); } catch { this.state = '无法读取 NapCat 配置'; this.retry(); return; }
    if (!config) { this.state = '请登录 NapCat 并开启 WebSocket 服务端'; this.retry(); return; }
    const url = new URL(config.wsUrl);
    if (config.accessToken) url.searchParams.set('access_token', config.accessToken);
    this.state = '正在连接';
    let socket;
    try { socket = new this.WebSocketClass(url.href); } catch { this.state = '连接地址无效'; this.retry(); return; }
    this.socket = socket;
    const connectTimer = setTimeout(() => { try { socket.close(); } catch {} }, this.timeout);
    socket.addEventListener('open', async () => {
      clearTimeout(connectTimer);
      try {
        const identity = await this.call('get_login_info');
        if (!identity?.user_id) throw new Error('未登录');
        if (this.socket !== socket || this.stopped) return;
        this.identity = { id: String(identity.user_id), name: String(identity.nickname ?? '') };
        this.connected = true; this.state = '已连接'; this.lastPacketAt = Date.now(); this.good = null;
        this.healthTimer = setInterval(() => {
          void this.call('get_status').then(status => {
            this.good = status.good ?? null;
            if (status.online === false || status.good === false) this.state = 'QQ 接收异常，请检查 NapCat';
            else this.state = '已连接';
          }).catch(() => { this.state = '连接无响应，正在重连'; socket.close(); });
        }, 30000);
        this.emit('ready');
      } catch { this.state = 'QQ 未登录或连接鉴权失败'; socket.close(); }
    });
    socket.addEventListener('message', event => {
      let data; try { data = JSON.parse(String(event.data)); } catch { return; }
      this.lastPacketAt = Date.now();
      if (data.echo !== undefined) {
        const pending = this.pending.get(String(data.echo)); if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(String(data.echo));
        if (data.status === 'failed' || Number(data.retcode) !== 0) pending.reject(qqError('QQ_API_REJECTED', `QQ 接口 ${pending.action} 失败（${data.retcode ?? '未知'}）。`, pending.action, Number.isFinite(Number(data.retcode)) ? Number(data.retcode) : null));
        else pending.resolve(data.data); return;
      }
      if (data.meta_event_type === 'heartbeat') {
        this.good = data.status?.good ?? null;
        if (data.status?.online === false || this.good === false) this.state = 'QQ 接收异常，请检查 NapCat';
      }
      if (this.connected && data.post_type === 'message') this.emit('message', data);
    });
    socket.addEventListener('error', () => { this.state = '连接失败，正在重试'; });
    socket.addEventListener('close', () => {
      clearTimeout(connectTimer); clearInterval(this.healthTimer);
      if (this.socket !== socket) return;
      this.socket = null; this.connected = false;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(qqError('QQ_DISCONNECTED', 'QQ 连接已断开。', p.action)); }
      this.pending.clear(); this.retry();
    });
  }
  retry() { clearTimeout(this.retryTimer); if (!this.stopped) this.retryTimer = setTimeout(() => this.connect(), 5000); }
  call(action, params = {}) {
    if (this.socket?.readyState !== 1) return Promise.reject(qqError('QQ_NOT_CONNECTED', 'NapCat 尚未连接。', action));
    const echo = String(++this.counter);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(echo); reject(qqError('QQ_TIMEOUT', `QQ 接口 ${action} 超时。`, action)); }, this.timeout);
      this.pending.set(echo, { resolve, reject, timer, action });
      try { this.socket.send(JSON.stringify({ action, params, echo })); }
      catch { clearTimeout(timer); this.pending.delete(echo); reject(new Error('发送 QQ 请求失败。')); }
    });
  }
  async send(kind, id, text, replyId, mentions = []) {
    if (!Array.isArray(mentions) || mentions.length > 3 || mentions.some(qq => typeof qq !== 'string' || !/^\d{5,20}$/.test(qq)) || (kind !== 'group' && mentions.length)) throw Error('提及对象必须为本群已确认的 QQ 号。');
    const message = [];
    if (kind === 'group' && replyId) message.push({ type: 'reply', data: { id: String(replyId) } });
    for (const qq of new Set(mentions)) message.push({ type: 'at', data: { qq } }, { type: 'text', data: { text: ' ' } });
    message.push({ type: 'text', data: { text } });
    return this.call(kind === 'group' ? 'send_group_msg' : 'send_private_msg', { [kind === 'group' ? 'group_id' : 'user_id']: id, message });
  }
  async sendImage(kind, id, path, { sticker = false } = {}) {
    // An image is always its own QQ message; captions are sent in a separate call.
    return this.call(kind === 'group' ? 'send_group_msg' : 'send_private_msg', {
      [kind === 'group' ? 'group_id' : 'user_id']: id,
      message: [{ type: 'image', data: { file: pathToFileURL(path).href, sub_type: sticker ? 1 : 0 } }]
    });
  }
  reconnect() { if (this.socket) this.socket.close(); else this.connect(); }
  close() { this.stopped = true; clearTimeout(this.retryTimer); clearInterval(this.healthTimer); this.socket?.close(); }
  status() { return { connected: this.connected, state: this.state, identity: this.identity, good: this.good, lastPacketAt: this.lastPacketAt ?? null }; }
}
