import fs from 'node:fs';

// 실행 결과 요약을 YT_RESULT_FILE(JSON)에 남긴다. 로그 시트 전송(log-sheet.mjs)이 읽는다.
// 토큰·이메일 등 개인정보는 넣지 않는다.
export function writeResult(env, { workflow, dryRun, items = [], error = null }) {
  if (!env.YT_RESULT_FILE) return;
  const counts = {};
  for (const it of items) counts[it.result] = (counts[it.result] ?? 0) + 1;
  // 결과 파일은 로그 시트 전송용 부가 산출물이다. 쓰기 실패(경로·권한·디스크)는 경고만 남기고 본 작업 결과를 바꾸지 않는다.
  try {
    fs.writeFileSync(env.YT_RESULT_FILE, JSON.stringify({ workflow, dry_run: dryRun, error, counts, items }));
  } catch (e) {
    console.warn(`::warning::실행 결과 파일 쓰기 실패 (${e.code ?? e.name}). 로그 시트 전송은 결과 없이 진행`);
  }
}
