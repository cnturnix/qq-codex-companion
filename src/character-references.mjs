import { existsSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicJson } from './companion-settings.mjs';

export class CharacterReferences {
  constructor(paths) {
    this.paths = paths; this.file = join(paths.text, 'character-references.json');
    this.entries = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : [];
  }
  all() {
    const builtin = existsSync(join(this.paths.images, 'references', 'gpt.png')) ? [{ id: 'gpt-builtin', character: 'GPT龙娘', work: 'ChatGPT拟人', kind: 'positive', file: 'gpt.png', builtin: true }] : [];
    return [...builtin, ...this.entries];
  }
  catalog() { return [...new Set(this.all().map(r => r.character))].slice(0, 30); }
  path(ref) { return join(this.paths.images, 'references', ref.file); }
  select(analysis) {
    const names = new Set(analysis.characters.map(c => c.name.replace(/\s/g, '').toLowerCase()));
    if (analysis.dragonCandidate) names.add('gpt龙娘');
    const selected = this.all().filter(r => names.has(r.character.replace(/\s/g, '').toLowerCase()));
    return [...new Set(selected.map(r => r.character))].slice(0, 2).flatMap(name => ['positive', 'negative'].flatMap(kind => selected.filter(r => r.character === name && r.kind === kind).slice(-2)));
  }
  add(item, preview, patch) {
    const character = String(patch.character ?? '').trim(), work = String(patch.work ?? '').trim(), kind = patch.referenceKind;
    if (!character || character.length > 50 || work.length > 80 || !['positive', 'negative'].includes(kind)) throw Error('请填写角色名，并选择正例或反例。');
    const id = createHash('sha256').update(item.id + '\0' + character + '\0' + kind).digest('hex');
    const entry = { id, character, work, kind, file: id + '.png', mediaId: item.id, addedAt: Date.now() };
    if (!this.entries.some(r => r.id === id) && this.entries.length >= 120) throw Error('角色参考最多 120 张，请先移除不用的参考。');
    copyFileSync(preview, this.path(entry)); this.entries = [...this.entries.filter(r => r.id !== id), entry]; atomicJson(this.file, this.entries);
    return entry;
  }
  remove(id) { this.entries = this.entries.filter(r => r.id !== id); atomicJson(this.file, this.entries); }
}
