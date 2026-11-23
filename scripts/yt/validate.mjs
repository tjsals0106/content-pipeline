#!/usr/bin/env node
// 매니페스트 검증. 인자가 없으면 videos/ 전체, 있으면 해당 파일만 오류를 보고한다.
// 중복 검사(youtube_id, drive 파일)는 항상 videos/ 전체를 기준으로 한다.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { listManifestFiles, loadManifest, validateManifests, videosDir } from './lib/manifest.mjs';

export function runValidate(args = [], env = process.env) {
  const dir = videosDir(env);
  const files = listManifestFiles(dir);
  const targets = args.filter(Boolean).map((a) => path.resolve(a));
  for (const t of targets) if (!files.includes(t)) files.push(t);

  const manifests = files.map(loadManifest);
  const results = validateManifests(manifests);
  const report = targets.length ? manifests.filter((m) => targets.includes(m.file)) : manifests;

  let errorCount = 0;
  for (const m of report) {
    for (const e of results.get(m.name)) {
      console.error(`${path.relative(process.cwd(), m.file)}: ${e.field}: ${e.message}`);
      errorCount += 1;
    }
  }
  console.log(`매니페스트 ${report.length}개 검사, 오류 ${errorCount}개`);
  return errorCount === 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runValidate(process.argv.slice(2)) ? 0 : 1;
}
