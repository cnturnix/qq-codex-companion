export const mentionSchema = {
  type: 'object', additionalProperties: false,
  properties: { mode: { type: 'string', enum: ['none', 'random', 'selected'] }, targets: { type: 'array', maxItems: 3, items: { type: 'string', maxLength: 80 } } },
  required: ['mode', 'targets']
};
export function parseMention(value) {
  if (value === undefined) return { mode: 'none', targets: [] };
  if (!value || !['none', 'random', 'selected'].includes(value.mode) || !Array.isArray(value.targets) || value.targets.length > 3 || value.targets.some(t => typeof t !== 'string' || t.length > 80)) throw Error('回复提及格式无效。');
  return { mode: value.mode, targets: [...new Set(value.targets.map(t => t.trim().replace(/^@/, '')).filter(Boolean))] };
}
export async function resolveMention(qq, room, mention, random = Math.random) {
  const empty = error => ({ ids: [], error });
  if (mention.mode === 'none') return empty('');
  if (room.kind !== 'group') return empty('这里是私聊，不能在这里提醒群成员。');
  if (mention.mode === 'selected' && (!mention.targets.length || mention.targets.some(t => /^(all|全体成员|所有人|大家)$/i.test(t)))) return empty('请指定要提醒的群友，我不会用这条请求 @ 全体成员。');
  let response;
  try { response = await qq.call('get_group_member_list', { group_id: room.id }); }
  catch { return empty('暂时没读到本群成员列表，这次没能发出 @，稍后再试一下。'); }
  if (!Array.isArray(response)) return empty('暂时没读到本群成员列表，这次没能发出 @。');
  const members = [...new Map(response.filter(m => m && /^\d{5,20}$/.test(String(m.user_id)) && String(m.user_id) !== String(qq.identity?.id) && (m.group_id === undefined || String(m.group_id) === room.id))
    .map(m => [String(m.user_id), { id: String(m.user_id), card: String(m.card ?? '').trim(), name: String(m.nickname ?? '').trim() }])).values()];
  if (!members.length) return empty('暂时没有找到可以提醒的本群成员。');
  if (mention.mode === 'random') return { ids: [members[Math.min(members.length - 1, Math.max(0, Math.floor(random() * members.length)))].id], error: '' };
  const ids = [];
  for (const target of mention.targets) {
    const matches = /^\d{5,20}$/.test(target) ? members.filter(m => m.id === target) : members.filter(m => m.card === target || m.name === target);
    if (matches.length !== 1) return empty(matches.length ? '群里有重名的成员，请直接 @ 那位群友或给我他的 QQ 号。' : '没找到你指定的本群成员，请直接 @ 那位群友或给我他的 QQ 号。');
    if (!ids.includes(matches[0].id)) ids.push(matches[0].id);
  }
  return { ids, error: '' };
}
