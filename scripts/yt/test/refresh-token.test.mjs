import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeSecretFile } from '../get-refresh-token.mjs';

test('토큰 파일은 0600으로 쓰고 기존 파일은 덮어쓰지 않음', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yt-tok-')), 'sub', 'a.token');
  writeSecretFile(file, 'secret');
  assert.equal(fs.readFileSync(file, 'utf8'), 'secret');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.throws(() => writeSecretFile(file, 'other'), { code: 'EEXIST' });
});
