#!/usr/bin/env node
// 워크플로 실행 결과(YT_RESULT_FILE)를 로그 시트 웹앱(LOG_SHEET_WEBHOOK_URL)으로 POST한다.
// 시크릿이 없으면 조용히 건너뛰고, 전송 실패도 워크플로를 실패시키지 않는다(경고만).
// URL은 로그에 출력하지 않는다.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function buildPayload(env, result) {
  const base = {
    source: 'content-pipeline-yt',
    workflow: env.GITHUB_WORKFLOW ?? '',
    run_id: env.GITHUB_RUN_ID ?? '',
    run_url: env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : '',
    event: env.GITHUB_EVENT_NAME ?? '',
    outcome: env.STEP_OUTCOME ?? '',
    sent_at: new Date().toISOString(),
  };
  if (!result) return { ...base, dry_run: null, error: '실행 결과 파일 없음 (스크립트가 결과를 남기기 전에 종료)', counts: {}, items: [] };
  return { ...base, ...result, workflow: result.workflow || base.workflow };
}

export async function sendLogSheet({ env = process.env, fetchImpl = fetch } = {}) {
  const url = env.LOG_SHEET_WEBHOOK_URL;
  if (!url) {
    console.log('LOG_SHEET_WEBHOOK_URL 없음: 로그 시트 전송 건너뜀');
    return 'skipped';
  }
  let result = null;
  try {
    if (env.YT_RESULT_FILE && fs.existsSync(env.YT_RESULT_FILE)) result = JSON.parse(fs.readFileSync(env.YT_RESULT_FILE, 'utf8'));
  } catch {
    result = null;
  }
  const payload = buildPayload(env, result);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.warn(`::warning::로그 시트 전송 실패 (HTTP ${res.status})`);
      return 'failed';
    }
    console.log(`로그 시트 전송 완료 (항목 ${payload.items.length}건)`);
    return 'sent';
  } catch (e) {
    console.warn(`::warning::로그 시트 전송 실패 (${e.name})`);
    return 'failed';
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await sendLogSheet();
}
