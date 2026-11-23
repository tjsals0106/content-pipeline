import fs from 'node:fs';

// 실행 결과 요약을 YT_RESULT_FILE(JSON)에 남긴다. 로그 시트 전송(log-sheet.mjs)이 읽는다.
// 토큰·이메일 등 개인정보는 넣지 않는다.
export function writeResult(env, { workflow, dryRun, items = [], error = null }) {
  if (!env.YT_RESULT_FILE) return;
  const counts = {};
  for (const it of items) counts[it.result] = (counts[it.result] ?? 0) + 1;
  fs.writeFileSync(env.YT_RESULT_FILE, JSON.stringify({ workflow, dry_run: dryRun, error, counts, items }));
}
