import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VALID, tmpVideosDir } from './helpers.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '../validate.mjs');
const run = (dir, args = []) => spawnSync(process.execPath, [script, ...args], { env: { ...process.env, VIDEOS_DIR: dir }, encoding: 'utf8' });

test('정상 디렉터리는 exit 0', () => {
  const r = run(tmpVideosDir({ 'a.yml': VALID }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /매니페스트 1개 검사, 오류 0개/);
});

test('오류가 있으면 exit 1과 파일:필드 출력', () => {
  const r = run(tmpVideosDir({ 'a.yml': VALID.replace('seonmin_mov', 'nope') }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a\.yml: channel:/);
});

test('인자로 준 파일만 보고', () => {
  const dir = tmpVideosDir({ 'a.yml': VALID, 'b.yml': VALID.replace('test.mp4', 'b.mp4').replace('seonmin_mov', 'nope') });
  assert.equal(run(dir, [path.join(dir, 'a.yml')]).status, 0);
  assert.equal(run(dir, [path.join(dir, 'b.yml')]).status, 1);
});

test('빈 디렉터리는 통과', () => {
  assert.equal(run(tmpVideosDir()).status, 0);
});
