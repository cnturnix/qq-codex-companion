import test from 'node:test';
import assert from 'node:assert/strict';
import { isStickerSource, requestsImage, selectImageRefs } from '../src/media-policy.mjs';

test('only explicit QQ sticker markers qualify for automatic reading', () => {
  for (const data of [{ sub_type: 1 }, { sub_type: '1' }, { emoji_id: 'abc' }]) assert.equal(isStickerSource(data), true);
  for (const data of [{}, { sub_type: 0 }, { emoji_id: '0' }, { file: 'funny.gif' }]) assert.equal(isStickerSource(data), false);
});
test('image requests require a request or a contextual question, with explicit opt-outs respected', () => {
  for (const text of ['看看这张图', '识图', '这张图是谁', '截图写的什么', '帮我翻译图片里的字']) assert.equal(requestsImage(text), true, text);
  for (const text of ['你好', '这个截图很好看', '这个表情笑死我了', '不要看这张图', '不用识别图片', '[图片/表情，内容见 images 识图字段]']) assert.equal(requestsImage(text), false, text);
  assert.equal(requestsImage('这是谁', true), true); assert.equal(requestsImage('这是谁', false), false);
});
test('adjacent questions target the sender’s preceding picture and never future or bot pictures', () => {
  const photo = { id: '1', seq: 1, time: 1, sender: 'a', imageRefs: ['first'] };
  const request = { id: '2', seq: 2, time: 2, sender: 'a', userText: '这是谁' };
  const future = { id: '3', seq: 3, time: 3, sender: 'a', imageRefs: ['future'] };
  const bot = { id: '4', seq: 4, time: 1, sender: 'bot', bot: true, imageRefs: ['bot'] };
  const plan = selectImageRefs([request], [photo, request, future, bot], () => false);
  assert.deepEqual([...plan.explicit], ['first']);
  assert.deepEqual(selectImageRefs([{ ...request, sender: 'b' }], [photo], () => false).ordered, []);
});
