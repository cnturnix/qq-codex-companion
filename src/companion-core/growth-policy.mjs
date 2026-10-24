export const traits = ['curiosity', 'playfulness', 'directness', 'expressiveness', 'topic_followthrough', 'initiative_style'];
export const neutralTraits = () => Object.fromEntries(traits.map(k => [k, .5]));
export const contexts = { general: '日常交流', technical: '技术问题', casual: '轻松闲聊', game: '游戏讨论' };
export const styleCatalog = {
  answer_first: { label: '先说结论', trait: 'directness', target: .8, rule: '先给直接结论，必要时再说明依据。', positive: /(?:先|直接).{0,5}(?:说|给|讲)?(?:结论|答案|重点)/, negative: /(?:不要|别|停止).{0,6}(?:只|总|一上来)?.{0,3}(?:结论|答案|重点)/ },
  gentle: { label: '语气柔和', trait: 'directness', target: .2, rule: '用柔和的语气表达，保留清楚的结论。', positive: /(?:温柔|柔和|委婉|别太直接|不要太直接)/, negative: /(?:不要|别|停止).{0,6}(?:委婉|温柔|柔和|拐弯)/ },
  concise: { label: '简洁表达', trait: 'expressiveness', target: .2, rule: '简洁回答，减少长篇铺陈。', positive: /(?:简短|简洁|精简|短点|短一点|少说|别.{0,3}啰嗦|不要.{0,3}长篇)/, negative: /(?:不要|别|停止).{0,5}(?:太|这么|那么)?(?:简短|简洁|精简|简略)/ },
  detailed: { label: '适当展开', trait: 'expressiveness', target: .8, rule: '需要解释时展开关键细节和例子。', positive: /(?:详细|展开|多解释|多举.{0,2}例)/, negative: /(?:不要|别|停止).{0,5}(?:长篇|详细|展开|啰嗦)/ },
  playful: { label: '轻松幽默', trait: 'playfulness', target: .8, rule: '轻松场合可用少量幽默，尊重对方反应。', positive: /(?:幽默|搞笑|开玩笑|玩梗|有趣一点)/, negative: /(?:不要|别|停止).{0,6}(?:开玩笑|玩梗|搞笑|调侃|抖机灵)/ },
  serious: { label: '认真平和', trait: 'playfulness', target: .2, rule: '认真平和地回应，减少调侃。', positive: /(?:认真点|认真一点|严肃|别.{0,3}开玩笑|不要.{0,3}玩梗)/, negative: /(?:不要|别|停止).{0,5}(?:太|这么|那么)?(?:严肃|一本正经)/ },
  curious: { label: '适度追问', trait: 'curiosity', target: .8, rule: '对方愿意展开时，可以问一个相关问题。', positive: /(?:多问|可以.{0,4}问|适当.{0,3}追问|问问我)/, negative: /(?:不要|别|停止).{0,5}(?:追问|反问|问我|提问)/ },
  listen: { label: '少追问', trait: 'curiosity', target: .2, rule: '优先回应已说的内容，不额外追问。', positive: /(?:少问|不要.{0,4}追问|别.{0,4}反问|别.{0,3}问我)/, negative: /(?:不要|别|停止).{0,5}(?:只听|光听|不问|沉默)/ },
  follow_topic: { label: '延续话题', trait: 'topic_followthrough', target: .8, rule: '沿着当前共同话题继续，不突然转题。', positive: /(?:继续聊|接着聊|别.{0,3}转移话题|不要.{0,3}换话题)/, negative: /(?:不要|别|停止).{0,5}(?:继续聊|再聊|这个话题|这件事)/ },
  flexible: { label: '适时收束', trait: 'topic_followthrough', target: .2, rule: '话题已经结束时自然收束，不反复拉回。', positive: /(?:换个话题|不聊这个|别.{0,3}再聊|适可而止)/, negative: /(?:不要|别|停止).{0,5}(?:换话题|转移话题|打断)/ },
  offer_angles: { label: '提供相关角度', trait: 'initiative_style', target: .8, rule: '已经获准回复时，可提供一个相关的新角度。', positive: /(?:多提.{0,3}建议|新角度|给点.{0,3}思路|可以.{0,3}建议)/, negative: /(?:不要|别|停止).{0,5}(?:建议|出主意|新话题|说教)/ },
  stay_focused: { label: '紧扣当前内容', trait: 'initiative_style', target: .2, rule: '紧扣对方当前的话，不额外扩展建议。', positive: /(?:就说这个|只回答|别.{0,3}建议|不要.{0,3}说教|别跑题)/, negative: /(?:不要|别|停止).{0,5}(?:只回答|只说这个|局限)/ }
};
export const growthDefaults = { habitLearningEnabled: false, habitAutoActivateEnabled: false, personalityEnabled: false, personalityAutoCommitEnabled: false,
  reflectionEnabled: false, moodSimulationEnabled: false, habitMinPositive: 6, habitMinDays: 3, habitMinSupport: .8, reflectionHours: 24,
  traitDailyLimit: .02, moodHalfLifeHours: 12, moodEmotionHalfLifeMinutes: 90 };
export function validateGrowth(cfg) {
  for (const key of ['habitLearningEnabled', 'habitAutoActivateEnabled', 'personalityEnabled', 'personalityAutoCommitEnabled', 'reflectionEnabled', 'moodSimulationEnabled']) if (typeof cfg[key] !== 'boolean') throw Error('成长开关格式无效。');
  for (const [key, min, max, integer] of [['habitMinPositive', 6, 30, true], ['habitMinDays', 1, 14, true], ['habitMinSupport', .8, .99], ['reflectionHours', 12, 168, true], ['traitDailyLimit', .001, .02], ['moodHalfLifeHours', 1, 72], ['moodEmotionHalfLifeMinutes', 15, 720, true]]) {
    if (!Number.isFinite(cfg[key]) || cfg[key] < min || cfg[key] > max || (integer && !Number.isInteger(cfg[key]))) throw Error(`${key} 超出允许范围。`);
  }
}
export const localDay = time => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
export const explicitPraise = text => /(?:这样|这种|刚才|刚刚|这个|你的).{0,12}(?:回答|说法|解释|语气|风格)?.{0,6}(?:很好|不错|很棒|喜欢|合适|舒服|好懂|有用)/.test(text) && !/(?:不喜欢|不好|别|不要|假如|如果)/.test(text);
export const feedbackText = text => String(text ?? '').replace(/```[\s\S]*?```/g, '').replace(/^[>＞].*$/gm, '').replace(/[“「『][^”」』]*[”」』]/g, '').trim();
export const styleRejected = (key, text) => styleCatalog[key]?.negative.test(feedbackText(text)) ?? false;
export const styleRequested = (key, text) => styleCatalog[key]?.positive.test(feedbackText(text)) && !styleRejected(key, text);
export const growthSchema = { type: 'object', additionalProperties: false, properties: {
  habits: { type: 'array', maxItems: 12, items: { type: 'object', additionalProperties: false, properties: {
    style: { type: 'string', enum: Object.keys(styleCatalog) }, context: { type: 'string', enum: Object.keys(contexts) },
    kind: { type: 'string', enum: ['request', 'praise', 'rejection'] }, human_event_id: { type: 'string' }, assistant_event_id: { type: 'string' }
  }, required: ['style', 'context', 'kind', 'human_event_id', 'assistant_event_id'] } },
  moods: { type: 'array', maxItems: 5, items: { type: 'object', additionalProperties: false, properties: {
    event_id: { type: 'string' }, emotion: { type: 'string', enum: ['开心', '踏实', '甜蜜', '心疼', '担心', '难过', '吃醋'] },
    delta: { type: 'number', minimum: -5, maximum: 5 }, strength: { type: 'number', minimum: 0, maximum: 10 }, confidence: { type: 'number', minimum: 0, maximum: 1 }
  }, required: ['event_id', 'emotion', 'delta', 'strength', 'confidence'] } }
}, required: ['habits', 'moods'] };
export function traitDescription(values) {
  const words = { curiosity: ['减少追问', '适度好奇'], playfulness: ['认真平和', '轻松幽默'], directness: ['语气柔和', '直接表达'], expressiveness: ['简洁表达', '适当展开'], topic_followthrough: ['适时收束', '延续话题'], initiative_style: ['紧扣当前内容', '提供相关角度'] };
  return traits.filter(k => Math.abs(values[k] - .5) > .00001).map(k => `${words[k][values[k] >= .5 ? 1 : 0]}（${Math.round(values[k] * 1000) / 10}/100）`).join('；');
}
