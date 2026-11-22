import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  listManifestFiles, loadManifest, validateManifestData, validateManifests, writeManifestFields, tagsLength, REPO_ROOT,
} from '../lib/manifest.mjs';
import { VALID, tmpVideosDir } from './helpers.mjs';

const base = () => YAML.parse(VALID);
const fields = (data, name = 'ok.yml') => validateManifestData(data, name).map((e) => e.field);

test('유효한 매니페스트는 오류가 없다', () => {
  assert.deepEqual(validateManifestData(base(), 'ok.yml'), []);
});

test('레포의 _example.yml은 유효하다', () => {
  const m = loadManifest(path.join(REPO_ROOT, 'videos/_example.yml'));
  assert.deepEqual(validateManifestData(m.data, 'example.yml'), []);
});

test('파일명 규칙', () => {
  assert.ok(fields(base(), 'Bad_Name.yml').includes('(파일명)'));
});

test('정의되지 않은 키는 오류', () => {
  assert.ok(fields({ ...base(), extra: 1 }).includes('extra'));
  assert.ok(fields({ ...base(), source: { type: 'drive', drive_file_name: 'a.mp4', x: 1 } }).includes('source.x'));
});

test('channel은 세 채널 중 하나', () => {
  for (const c of ['seonmin_mov', 'meliv_music', 'viriditas_worship']) assert.deepEqual(fields({ ...base(), channel: c }), []);
  assert.ok(fields({ ...base(), channel: 'other' }).includes('channel'));
  const { channel, ...rest } = base();
  assert.ok(fields(rest).includes('channel'));
});

test('title 길이와 금지 문자', () => {
  assert.ok(fields({ ...base(), title: '' }).includes('title'));
  assert.ok(fields({ ...base(), title: '가'.repeat(101) }).includes('title'));
  assert.deepEqual(fields({ ...base(), title: '가'.repeat(100) }), []);
  assert.ok(fields({ ...base(), title: 'a<b' }).includes('title'));
});

test('description 5000바이트 제한', () => {
  assert.deepEqual(fields({ ...base(), description: 'a'.repeat(5000) }), []);
  assert.ok(fields({ ...base(), description: '가'.repeat(1700) }).includes('description'));
});

test('tags 합계 500자 제한', () => {
  assert.equal(tagsLength(['ab', 'c d']), 2 + 5 + 1);
  assert.ok(fields({ ...base(), tags: ['a'.repeat(300), 'b'.repeat(250)] }).includes('tags'));
  assert.ok(fields({ ...base(), tags: 'a' }).includes('tags'));
});

test('made_for_kids 필수 boolean', () => {
  assert.ok(fields({ ...base(), made_for_kids: 'no' }).includes('made_for_kids'));
  const { made_for_kids, ...rest } = base();
  assert.ok(fields(rest).includes('made_for_kids'));
});

test('source는 drive_file_id 또는 drive_file_name 중 하나', () => {
  assert.deepEqual(fields({ ...base(), source: { type: 'drive', drive_file_id: '1AbCdEfGhIjKlMn' } }), []);
  assert.ok(fields({ ...base(), source: { type: 'drive' } }).includes('source'));
  assert.ok(fields({ ...base(), source: { type: 'drive', drive_file_id: '1AbCdEfGhIjKlMn', drive_file_name: 'a.mp4' } }).includes('source'));
  assert.ok(fields({ ...base(), source: { type: 'url', drive_file_name: 'a.mp4' } }).includes('source.type'));
  assert.ok(fields({ ...base(), source: { type: 'drive', drive_file_name: 'a.mov' } }).includes('source.drive_file_name'));
});

test('publish_week 형식', () => {
  assert.ok(fields({ ...base(), publish_week: '2026-48' }).includes('publish_week'));
  assert.ok(fields({ ...base(), publish_week: '2026-W54' }).includes('publish_week'));
  assert.deepEqual(fields({ ...base(), publish_week: '2026-W53' }), []);
  assert.ok(fields({ ...base(), publish_week: '2027-W53' }).includes('publish_week'));
  const { publish_week, ...rest } = base();
  assert.deepEqual(fields(rest), []);
});

test('기록 필드 교차 규칙', () => {
  const uploaded = { ...base(), youtube_id: 'abcdefghijk', uploaded_at: '2026-11-22T01:00:00Z' };
  assert.deepEqual(fields(uploaded), []);
  assert.deepEqual(fields({ ...uploaded, published_at: '2026-11-27T12:17:00.000Z' }), []);
  assert.ok(fields({ ...base(), youtube_id: 'abcdefghijk' }).includes('uploaded_at'));
  assert.ok(fields({ ...base(), published_at: '2026-11-27T12:17:00Z' }).includes('published_at'));
  assert.ok(fields({ ...uploaded, youtube_id: 'short' }).includes('youtube_id'));
  assert.ok(fields({ ...uploaded, uploaded_at: '어제' }).includes('uploaded_at'));
});

test('중복 youtube_id / drive 파일 검출', () => {
  const dir = tmpVideosDir({
    'a.yml': VALID,
    'b.yml': VALID,
    '_ignored.yml': 'not: [valid',
  });
  const manifests = listManifestFiles(dir).map(loadManifest);
  assert.deepEqual(manifests.map((m) => m.name), ['a.yml', 'b.yml']);
  const results = validateManifests(manifests);
  assert.deepEqual(results.get('a.yml').map((e) => e.field), ['drive_file_name']);
  assert.deepEqual(results.get('b.yml').map((e) => e.field), ['drive_file_name']);
});

test('YAML 파싱 오류 보고', () => {
  const dir = tmpVideosDir({ 'bad.yml': 'title: [unclosed' });
  const results = validateManifests(listManifestFiles(dir).map(loadManifest));
  assert.equal(results.get('bad.yml')[0].field, '(YAML)');
});

test('기록 시 주석과 키 순서 보존', () => {
  const dir = tmpVideosDir({ 'a.yml': `# 머리 주석\n${VALID.replace('made_for_kids: false', 'made_for_kids: false # 필수')}` });
  const m = loadManifest(path.join(dir, 'a.yml'));
  writeManifestFields(m, { youtube_id: 'abcdefghijk', uploaded_at: '2026-11-22T01:00:00.000Z' });
  const text = fs.readFileSync(m.file, 'utf8');
  assert.match(text, /^# 머리 주석/);
  assert.match(text, /made_for_kids: false # 필수/);
  assert.match(text, /youtube_id: abcdefghijk/);
  assert.ok(text.indexOf('youtube_id') < text.indexOf('published_at'));
  assert.deepEqual(validateManifestData(loadManifest(m.file).data, 'a.yml'), []);
});
