export function visionValue(patch = {}) {
  const { tags = ['开心', '赞同'], dragon = 'no', ...rest } = patch;
  return { description: '一张开心的表情', ocr: '好呀', kind: 'sticker', contentType: 'anime_art',
    facts: tags.map(text => ({ text, confidence: 'high', evidence: '测试画面明确可见' })), emotions: [], usage: [], characters: [], uncertain: [], dragonCandidate: dragon !== 'no', ...rest };
}
export const vision = patch => JSON.stringify(visionValue(patch));
