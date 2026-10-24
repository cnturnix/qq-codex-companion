import { stableId, eventId, sensitive } from './policy.mjs';

export function completedTurn({ room, job, messages, outputs, now }) {
  if (!outputs.length || outputs.some(o => o.id === undefined || o.id === null)) return null;
  const principal = room.kind === 'private' ? 'qq:' + room.id : null;
  const seen = new Set();
  const humans = messages.filter(m => !m.bot && /^\d{5,20}$/.test(String(m.sender)) && m.id !== undefined && !seen.has(String(m.id)) && seen.add(String(m.id)))
    .map(m => ({ id: eventId(room.key, m.id), providerId: String(m.id), actor: 'human', actorRef: 'qq:' + m.sender, replyTo: m.replyTo ? String(m.replyTo) : '', content: String(m.userText ?? m.text ?? '').replace(/\[(?:图片[^\]]*|表情包|提及[^\]]*)\]/g, '').trim().slice(0, 1500), at: m.time || now }))
    .filter(e => e.content && !sensitive(e.content));
  if (!humans.length) return null;
  const trigger = room.kind === 'private' ? 'private_message' : job.direct ? job.last?.triggerKind ?? 'direct_at' : job.reason === 'checkin' ? 'scheduled_appearance' : 'active_followup';
  return { id: stableId('turn', room.key, humans.map(e => e.id).sort()), roomKey: room.key, principal, trigger, at: now,
    events: [...humans, ...outputs.map(o => ({ id: eventId(room.key, o.id, 'assistant'), providerId: String(o.id), actor: 'assistant', content: String(o.text ?? '[已发送表情]').slice(0, 1500), at: now }))] };
}
