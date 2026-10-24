import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

export function signingKeys(secret) {
  let seed = Buffer.from(secret, 'utf8');
  if (!seed.length) throw new Error('QQ secret is empty');
  while (seed.length < 32) seed = Buffer.concat([seed, seed]);
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed.subarray(0, 32)]),
    format: 'der', type: 'pkcs8'
  });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

export function verifyCallback(keys, headers, rawBody, now = Date.now()) {
  const signature = headers['x-signature-ed25519'];
  const timestamp = headers['x-signature-timestamp'];
  if (typeof signature !== 'string' || !/^[0-9a-f]{128}$/i.test(signature)) return false;
  if (typeof timestamp !== 'string' || !/^\d{10,13}$/.test(timestamp)) return false;
  const ms = timestamp.length === 13 ? Number(timestamp) : Number(timestamp) * 1000;
  if (Math.abs(now - ms) > 5 * 60_000) return false;
  return verify(null, Buffer.concat([Buffer.from(timestamp), rawBody]), keys.publicKey, Buffer.from(signature, 'hex'));
}

export function challengeResponse(keys, data) {
  if (typeof data?.plain_token !== 'string' || typeof data?.event_ts !== 'string') throw new Error('Invalid challenge');
  return { plain_token: data.plain_token, signature: sign(null, Buffer.from(data.event_ts + data.plain_token), keys.privateKey).toString('hex') };
}

export class QQClient {
  constructor(config, fetcher = fetch) { this.config = config; this.fetcher = fetcher; this.expiresAt = 0; }
  async token() {
    if (this.accessToken && Date.now() < this.expiresAt - 55_000) return this.accessToken;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshToken();
    try { return await this.refreshing; } finally { this.refreshing = null; }
  }
  async refreshToken() {
    const response = await this.fetcher(this.config.tokenUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: this.config.appId, clientSecret: this.config.secret }),
      signal: AbortSignal.timeout(20_000)
    });
    const data = await response.json();
    if (!response.ok || !data.access_token) throw new Error(`QQ 凭证验证失败（HTTP ${response.status}，代码 ${Number(data.code) || 0}）。`);
    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + Number(data.expires_in) * 1000;
    return this.accessToken;
  }
  async reply(groupId, messageId, text) {
    const content = Array.from(String(text)).slice(0, 1800).join('');
    const response = await this.fetcher(`${this.config.apiBase}/v2/groups/${encodeURIComponent(groupId)}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: `QQBot ${await this.token()}` },
      body: JSON.stringify({ content, msg_type: 0, msg_id: messageId, msg_seq: 1 }),
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      // Never put API response bodies or credentials into logs / QQ replies.
      throw new Error(`QQ 发送失败（HTTP ${response.status}，代码 ${Number(data.code) || 0}）。`);
    }
  }
}
