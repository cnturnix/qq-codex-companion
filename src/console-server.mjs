import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

function authorized(request, token) {
  const actual = Buffer.from(String(request.headers.authorization ?? ''));
  const expected = Buffer.from('Bearer ' + token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function readBody(request, maxBytes = 32000) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes > maxBytes) throw new Error('请求过大。'); chunks.push(chunk); }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('请求格式无效。');
  return value;
}
export function createConsole(settings, bot, qq) {
  const page = readFileSync(new URL('../ui/console.html', import.meta.url));
  return createServer(async (req, res) => {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; img-src 'self' blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" };
    const send = (status, data) => { if (!res.headersSent) { res.writeHead(status, headers); res.end(JSON.stringify(data)); } };
    try {
      const port = req.socket.localPort;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
      if (!hosts.includes(req.headers.host) || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) return send(403, { error: '只接受本机管理页面请求。' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' }); res.end(page); return; }
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, app: 'qq-companion' });
      if (!authorized(req, settings.token)) return send(401, { error: '请使用启动脚本生成的管理入口，或填写本机管理密钥。' });
      if (req.method === 'GET' && url.pathname === '/api/status') return send(200, bot.snapshot());
      if (url.pathname.startsWith('/api/companion/') && (!bot.core || bot.core.failed)) return send(503, { error: '新记忆服务不可用，原聊天功能正常。' });
      if (req.method === 'GET' && url.pathname === '/api/companion/memories') return send(200, bot.core.store.list(Object.fromEntries(url.searchParams)));
      if (req.method === 'GET' && url.pathname === '/api/companion/memory') return send(200, bot.core.store.memory(url.searchParams.get('id')));
      if (req.method === 'GET' && url.pathname === '/api/companion/persona') return send(200, bot.core.personaView(url.searchParams.get('roomKey')));
      if (req.method === 'GET' && url.pathname === '/api/companion/growth') return send(200, bot.core.growthView(url.searchParams.get('roomKey')));
      if (req.method === 'GET' && url.pathname === '/api/media' && bot.media) {
        return send(200, bot.media.list({ q: (url.searchParams.get('q') ?? '').slice(0, 100), kind: url.searchParams.get('kind') ?? '', favorite: url.searchParams.get('favorite') === '1', offset: Math.max(0, Number(url.searchParams.get('offset')) || 0) }));
      }
      if (req.method === 'GET' && url.pathname === '/api/media/file' && bot.media) {
        const item = bot.media.get(url.searchParams.get('id')); if (!item) return send(404, { error: '图片不存在。' });
        const preview = url.searchParams.get('original') !== '1';
        const bytes = readFileSync(preview ? bot.media.preview(item) : bot.media.original(item));
        res.writeHead(200, { ...headers, 'Content-Type': preview ? 'image/png' : item.mime, 'Content-Length': bytes.length }); res.end(bytes); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/groups') {
        if (!qq.connected) return send(200, { groups: [] });
        const groups = await qq.call('get_group_list');
        return send(200, { groups: (Array.isArray(groups) ? groups : []).map(g => ({ id: String(g.group_id), name: String(g.group_name ?? g.group_id) })) });
      }
      if (req.method === 'GET' && url.pathname === '/api/friends') {
        if (!qq.connected) return send(200, { friends: [] });
        const friends = await qq.call('get_friend_list');
        return send(200, { friends: (Array.isArray(friends) ? friends : []).filter(f => /^\d{5,20}$/.test(String(f.user_id))).map(f => ({ id: String(f.user_id), name: String(f.remark || f.nickname || f.user_id).slice(0, 80) })) });
      }
      if (req.method !== 'POST') return send(404, { error: '没有这个接口。' });
      const body = await readBody(req, url.pathname === '/api/media/upload' ? 17 * 1024 * 1024 : 32000);
      if (url.pathname === '/api/companion/settings') return send(200, bot.core.updateSettings(body));
      if (url.pathname === '/api/companion/extract') return send(200, bot.core.extract(body.roomKey));
      if (url.pathname === '/api/companion/add') return send(200, bot.core.addMemory(body));
      if (url.pathname === '/api/companion/update') return send(200, bot.core.store.updateMemory(body.id, body));
      if (url.pathname === '/api/companion/delete') return send(200, await bot.core.erase({ memoryId: body.id }));
      if (url.pathname === '/api/companion/habit') return send(200, body.action === 'share' ? bot.core.growth.share(body.id) : bot.core.growth.updateHabit(body.id, body.action, body.resolveConflict === true));
      if (url.pathname === '/api/companion/reflect') { if (!bot.core.active()) throw Error('请先开启原有记忆功能。'); const queued = bot.core.growth.queueReflection(true); bot.core.pump(); return send(200, { queued }); }
      if (url.pathname === '/api/companion/proposal') { if (body.action === 'cancel') { bot.core.growth.cancel(body.id); return send(200, { ok: true }); } if (body.action !== 'commit') throw Error('提案操作无效。'); return send(200, bot.core.growth.commit(body.id)); }
      if (url.pathname === '/api/companion/rollback') return send(200, bot.core.growth.rollback(bot.core.personaView(body.roomKey).scope, body.id));
      if (url.pathname === '/api/companion/resume-persona') return send(200, bot.core.growth.resumeAutomatic(bot.core.personaView(body.roomKey).scope));
      if (url.pathname === '/api/companion/mood-reset') { bot.core.growth.resetMood(bot.core.viewRoom(body.roomKey)); return send(200, { ok: true }); }
      if (url.pathname === '/api/companion/preview') return send(200, await bot.core.preview(body.roomKey, body.text));
      if (url.pathname.startsWith('/api/media/') && bot.media) {
        if (url.pathname === '/api/media/upload') {
          if (typeof body.base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.base64)) throw new Error('图片上传内容无效。');
          const item = await bot.media.import(Buffer.from(body.base64, 'base64'), { kind: body.kind ?? 'auto', tags: body.tags ?? [], name: body.name ?? '', shared: true });
          return send(200, bot.media.public(item));
        }
        if (url.pathname === '/api/media/update') return send(200, bot.media.update(body.id, body));
        if (url.pathname === '/api/media/retry') return send(200, bot.media.retry(body.id));
        if (url.pathname === '/api/media/reanalyze') return send(200, bot.media.reanalyze(body.id));
        if (url.pathname === '/api/media/use-automatic') return send(200, bot.media.useAutomatic(body.id));
        if (url.pathname === '/api/media/reference') return send(200, bot.media.addReference(body.id, body));
        if (url.pathname === '/api/media/reference/remove') { bot.media.references.remove(body.referenceId); return send(200, { ok: true }); }
        if (url.pathname === '/api/media/wd-update') { void bot.media.wd.update(true).catch(() => {}); return send(200, bot.media.wd.status()); }
        if (url.pathname === '/api/media/scan') return send(200, await bot.media.scan());
      }
      if (url.pathname === '/api/settings') {
        if (body.personaViewRevision !== undefined && (!bot.core || bot.core.failed)) throw Error('成长服务暂不可用，请载入原始人设后再保存，避免覆盖学习部分。');
        const previous = settings.value;
        const result = body.personaViewRevision !== undefined && bot.core && !bot.core.failed ? bot.core.savePersonaSettings(body) : settings.update(body);
        await bot.settingsChanged(previous);
        if (previous.wsUrl !== settings.value.wsUrl || previous.accessToken !== settings.value.accessToken) qq.reconnect();
        return send(200, result);
      }
      if (url.pathname === '/api/reconnect') { qq.reconnect(); return send(200, { ok: true }); }
      if (url.pathname === '/api/room') {
        if (!bot.state.rooms[body.key]) return send(404, { error: '会话尚未产生。' });
        if (body.action === 'stop') await bot.stop(body.key);
        else if (body.action === 'reset') await bot.reset(body.key);
        else if (body.action === 'clear') { if (bot.core && !bot.core.failed) await bot.core.erase({ roomKey: body.key }); await bot.reset(body.key, true); }
        else if (body.action === 'save') await bot.editRoom(body.key, body);
        else return send(400, { error: '操作无效。' });
        return send(200, { ok: true });
      }
      return send(404, { error: '没有这个接口。' });
    } catch (error) { return send(400, { error: error.message?.includes('QQ 接口') ? 'QQ 接口暂不可用，请检查 NapCat。' : String(error.message ?? '操作失败').slice(0, 180) }); }
  });
}
