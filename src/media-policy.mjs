// Decide what may be read using message metadata and the user's text only.
// Unknown image types are deliberately treated as ordinary images.
export const isStickerSource = data => Number(data?.sub_type) === 1 || Boolean(data?.emoji_id && String(data.emoji_id) !== '0');

export function requestsImage(text, hasTarget = false) {
  const value = String(text ?? '').replace(/\[[^\]\n]*\]/g, '').trim();
  if (/(?:别|不要|不用|无需|不必|禁止).{0,8}(?:看|读|识别|分析|处理|识图)/u.test(value)) return false;
  const image = /图(?:片|像|中|里|上|内|片中)?|截图|照片|表情(?:包)?|画面|相片/u;
  const request = /(?:看(?:看|下|一下|一眼|图|这)|(?:帮我|请|能不能|可以|给我|你|麻烦).{0,6}看|读图|识图|识别|分析|解读|解释|描述|评价|点评|翻译|辨认|提取|认出|写.{0,3}(?:什么|啥)|是什么|是谁|什么(?:意思|角色|人物)|哪(?:个|位)|什么颜色|啥|好看吗)/u;
  if (image.test(value) && request.test(value)) return true;
  return hasTarget && /(?:看(?:看|下|一下|一眼)|识别|分析|解读|翻译|这(?:个|是).{0,8}(?:谁|什么|啥)|是谁|什么角色|什么意思|什么颜色|写的什么)/u.test(value);
}

export function selectImageRefs(messages, context, stickerRef) {
  const newest = [...messages].filter(m => !m.bot).sort((a, b) => b.time - a.time || b.seq - a.seq);
  const allowed = new Set(), explicit = new Set(), ordered = [];
  const add = (ref, requested) => { if (requested) explicit.add(ref); if (!allowed.has(ref)) { allowed.add(ref); ordered.push(ref); } };
  for (const message of newest) {
    const own = message.imageRefs ?? [];
    const quoted = message.quotedImageRefs?.length ? message.quotedImageRefs : context.find(m => m.id === message.replyTo)?.imageRefs ?? [];
    const text = message.userText ?? message.text;
    const previous = [...context].filter(m => !m.bot && m.id !== message.id && m.time <= message.time &&
      (m.time < message.time || m.seq < message.seq) && m.imageRefs?.length).sort((a, b) => b.time - a.time || b.seq - a.seq)[0];
    const adjacent = previous && previous.sender === message.sender && message.time - previous.time <= 120000;
    if (requestsImage(text, Boolean(own.length || quoted.length || adjacent))) {
      // A request applies only to its own pictures, its quote, or the nearest preceding picture message.
      const targets = own.length ? own : quoted.length ? quoted : previous?.imageRefs ?? [];
      for (const ref of [...targets].reverse()) add(ref, true);
    }
    for (const ref of [...own].reverse()) if (stickerRef(ref)) add(ref, false);
  }
  return { ordered, allowed, explicit };
}
