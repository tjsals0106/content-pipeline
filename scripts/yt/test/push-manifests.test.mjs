import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'push-manifests.sh');
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null', PUSH_RETRY_DELAY: '0',
};
delete ENV.GITHUB_STEP_SUMMARY;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' });

// origin(bare) + 기록하는 쪽(work) + 동시에 기록하는 다른 워크플로(other)
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-push-'));
  const origin = path.join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = path.join(root, 'seed');
  git(root, 'clone', '-q', origin, seed);
  fs.mkdirSync(path.join(seed, 'videos'));
  fs.writeFileSync(path.join(seed, 'videos', 'a.yml'), 'youtube_id: null\n');
  fs.writeFileSync(path.join(seed, 'videos', 'b.yml'), 'youtube_id: B\npublished_at: null\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  const work = path.join(root, 'work');
  const other = path.join(root, 'other');
  git(root, 'clone', '-q', origin, work);
  git(root, 'clone', '-q', origin, other);
  fs.writeFileSync(path.join(work, 'videos', 'a.yml'), 'youtube_id: A\n');
  return { root, origin, work, other };
}

const run = (cwd, extraEnv = {}) => spawnSync('bash', [SCRIPT, 'videos: 업로드 결과 기록'], { cwd, env: { ...ENV, ...extraEnv }, encoding: 'utf8' });
const originFile = (origin, f) => git(origin, 'show', `main:videos/${f}`);

test('변경이 없으면 커밋·push하지 않음', () => {
  const { other } = setup();
  const r = run(other);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /매니페스트 변경 없음/);
});

test('push 직전에 다른 워크플로가 먼저 push해 거부되면 pull --rebase 후 재시도해 두 기록 모두 보존', () => {
  const { root, origin, work, other } = setup();
  // 첫 push 시도 직전에 다른 워크플로(공개)가 b.yml 기록을 먼저 push한다 → work의 push는 거부된다.
  const marker = path.join(root, 'raced');
  fs.writeFileSync(path.join(work, '.git', 'hooks', 'pre-push'), `#!/bin/sh
if [ ! -f '${marker}' ]; then
  touch '${marker}'
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
  cd '${other}' && printf 'youtube_id: B\\npublished_at: now\\n' > videos/b.yml && git commit -q -am 'videos: 공개 전환 기록' && git push -q origin HEAD:main
fi
exit 0
`, { mode: 0o755 });
  const r = run(work);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /push 거부 \(시도 1\/3\)/);
  assert.match(r.stdout, /push 완료 \(시도 2\/3\)/);
  assert.equal(originFile(origin, 'a.yml'), 'youtube_id: A\n');
  assert.equal(originFile(origin, 'b.yml'), 'youtube_id: B\npublished_at: now\n');
});

test('push가 끝내 거부되면 3회 시도 후 ::error::와 함께 exit 1, Step Summary에도 기록', () => {
  const { root, origin, work } = setup();
  fs.writeFileSync(path.join(origin, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const summary = path.join(root, 'summary.md');
  const r = run(work, { GITHUB_STEP_SUMMARY: summary });
  assert.equal(r.status, 1);
  assert.equal((r.stdout.match(/push 거부/g) ?? []).length, 3);
  assert.match(r.stdout, /::error::매니페스트 기록 push 3회 실패/);
  assert.match(fs.readFileSync(summary, 'utf8'), /매니페스트 기록 실패/);
  assert.equal(originFile(origin, 'a.yml'), 'youtube_id: null\n');
});

test('같은 매니페스트를 동시에 고쳐 rebase가 충돌하면 rebase를 중단하고 exit 1', () => {
  const { origin, work, other } = setup();
  fs.writeFileSync(path.join(other, 'videos', 'a.yml'), 'youtube_id: X\n');
  git(other, 'commit', '-q', '-am', 'conflict');
  git(other, 'push', '-q', 'origin', 'HEAD:main');
  const r = run(work);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error::pull --rebase 충돌/);
  assert.equal(fs.existsSync(path.join(work, '.git', 'rebase-merge')), false);
  assert.equal(originFile(origin, 'a.yml'), 'youtube_id: X\n');
});
