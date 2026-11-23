import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendLogSheet } from '../log-sheet.mjs';
import { writeResult } from '../lib/result.mjs';

const resultFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yt-res-')), 'r.json');

test('LOG_SHEET_WEBHOOK_URL이 없으면 전송하지 않고 건너뜀', async () => {
  let called = 0;
  assert.equal(await sendLogSheet({ env: {}, fetchImpl: async () => { called += 1; } }), 'skipped');
  assert.equal(called, 0);
});

test('결과 요약을 JSON으로 POST', async () => {
  const file = resultFile();
  writeResult({ YT_RESULT_FILE: file }, {
    workflow: 'yt-upload', dryRun: false,
    items: [{ channel: 'Seonmin MOV', manifest: 'a.yml', result: '업로드 (unlisted)', youtube_id: 'ID1', note: '' },
      { channel: 'Meliv Music', manifest: 'b.yml', result: '스킵', youtube_id: '', note: '토큰 없음' }],
  });
  const sent = [];
  const env = { LOG_SHEET_WEBHOOK_URL: 'https://example.invalid/exec?key=k', YT_RESULT_FILE: file,
    GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '42', GITHUB_EVENT_NAME: 'push', STEP_OUTCOME: 'success' };
  const status = await sendLogSheet({ env, fetchImpl: async (url, init) => { sent.push({ url, init }); return { ok: true, status: 200, text: async () => 'ok' }; } });
  assert.equal(status, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].init.method, 'POST');
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.workflow, 'yt-upload');
  assert.equal(body.run_url, 'https://github.com/o/r/actions/runs/42');
  assert.equal(body.dry_run, false);
  assert.deepEqual(body.counts, { '업로드 (unlisted)': 1, 스킵: 1 });
  assert.equal(body.items.length, 2);
  assert.doesNotMatch(sent[0].init.body, /@/);
});

test('결과 파일이 없어도 실행 정보만 전송', async () => {
  let body;
  const env = { LOG_SHEET_WEBHOOK_URL: 'https://example.invalid/exec', YT_RESULT_FILE: '/nonexistent/x.json', STEP_OUTCOME: 'failure' };
  await sendLogSheet({ env, fetchImpl: async (_u, init) => { body = JSON.parse(init.body); return { ok: true, status: 200, text: async () => 'ok' }; } });
  assert.equal(body.outcome, 'failure');
  assert.match(body.error, /결과 파일 없음/);
});

test('전송 실패는 예외 없이 failed 반환', async () => {
  const env = { LOG_SHEET_WEBHOOK_URL: 'https://example.invalid/exec' };
  assert.equal(await sendLogSheet({ env, fetchImpl: async () => ({ ok: false, status: 500 }) }), 'failed');
  assert.equal(await sendLogSheet({ env, fetchImpl: async () => { throw new TypeError('network'); } }), 'failed');
  assert.equal(await sendLogSheet({ env, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>로그인</html>' }) }), 'failed');
});

test('결과 파일 쓰기 실패는 예외 없이 경고만', () => {
  assert.doesNotThrow(() => writeResult({ YT_RESULT_FILE: '/nonexistent-dir/yt/r.json' }, { workflow: 'yt-upload', dryRun: false }));
});
