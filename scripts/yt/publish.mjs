#!/usr/bin/env node
// 업로드된(unlisted) 영상 중 공개 주차가 된 것을 public으로 전환하고 published_at을 기록한다.
import { pathToFileURL } from 'node:url';
import { CHANNELS, CHANNEL_KEYS, channelRefreshToken, expectedChannelId } from './lib/channels.mjs';
import { QuotaExceededError, getAccessToken } from './lib/google.mjs';
import { listManifestFiles, loadManifest, validateManifests, videosDir, writeManifestFields } from './lib/manifest.mjs';
import { getMyChannel, listVideoStatuses, setPublic } from './lib/youtube.mjs';
import { kstIsoWeek } from './lib/time.mjs';
import { markdownTable, writeSummary } from './lib/summary.mjs';

export function selectDue(manifests, currentWeek) {
  return manifests
    .filter((m) => m.data.youtube_id && !m.data.published_at && (!m.data.publish_week || m.data.publish_week <= currentWeek))
    .sort((a, b) => String(a.data.uploaded_at).localeCompare(String(b.data.uploaded_at)) || a.name.localeCompare(b.name));
}

export async function runPublish({ env = process.env, fetchImpl = fetch, now = () => new Date() } = {}) {
  const dryRun = env.DRY_RUN !== 'false';
  const parsedBatch = Number.parseInt(env.PUBLISH_BATCH_SIZE || '10', 10);
  const batch = Number.isInteger(parsedBatch) && parsedBatch > 0 ? parsedBatch : 10;
  if (batch !== parsedBatch) console.warn(`PUBLISH_BATCH_SIZE 값(${env.PUBLISH_BATCH_SIZE})이 올바르지 않아 10으로 처리`);
  const all = listManifestFiles(videosDir(env)).map(loadManifest);
  const results = validateManifests(all);
  const invalid = all.filter((m) => results.get(m.name).length);
  if (invalid.length) {
    for (const m of invalid) for (const e of results.get(m.name)) console.error(`${m.name}: ${e.field}: ${e.message}`);
    writeSummary(`## yt-publish\n\n매니페스트 검증 실패 ${invalid.length}건. 공개 전환하지 않음.`, env);
    return 1;
  }

  const week = kstIsoWeek(now());
  const due = selectDue(all, week);
  const rows = [];
  const row = (m, result, note = '') => rows.push([CHANNELS[m.data.channel].name, m.name, m.data.youtube_id, m.data.publish_week ?? '', result, note]);
  let units = 0;
  let failures = 0;
  let quotaError = null;

  try {
    for (const key of CHANNEL_KEYS) {
      const ch = CHANNELS[key];
      const list = due.filter((m) => m.data.channel === key);
      if (!list.length) continue;
      if (!channelRefreshToken(key, env)) {
        console.log(`[${ch.name}] ${ch.tokenEnv} 없음: ${list.length}편 스킵`);
        for (const m of list) row(m, '스킵', `토큰 없음 (${ch.tokenEnv})`);
        continue;
      }
      // 배치 상한은 videos.update 시도에만 적용한다. 보류·스킵·이미 public은 상한을 차지하지 않아 뒤 영상을 막지 않는다.
      const picked = list;
      let attempts = 0;

      let token;
      let statuses;
      try {
        token = await getAccessToken(channelRefreshToken(key, env), { fetchImpl, env });
        const channel = await getMyChannel(token, { fetchImpl });
        units += 1;
        const expected = expectedChannelId(key, env);
        if (expected && expected !== channel.id) throw new Error(`토큰 채널(${channel.id})이 ${ch.channelIdEnv}(${expected})와 다름`);
        statuses = await listVideoStatuses(token, picked.map((m) => m.data.youtube_id), { fetchImpl });
        units += Math.ceil(picked.length / 50);
      } catch (e) {
        if (e instanceof QuotaExceededError) throw e;
        console.error(`[${ch.name}] 채널 준비 실패: ${e.message}`);
        for (const m of picked) row(m, '실패', `채널 준비 실패: ${e.message}`);
        failures += picked.length;
        continue;
      }

      for (let i = 0; i < picked.length; i++) {
        const m = picked[i];
        const status = statuses.get(m.data.youtube_id);
        if (!status) { row(m, '실패', '채널에서 영상을 찾을 수 없음'); failures += 1; continue; }
        if (status.privacyStatus === 'public') {
          if (!dryRun) writeManifestFields(m, { published_at: now().toISOString() });
          row(m, dryRun ? '이미 public (기록 예정)' : '이미 public (기록만)');
          continue;
        }
        if (status.uploadStatus !== 'processed') { row(m, '보류', `처리 중 (uploadStatus=${status.uploadStatus})`); continue; }
        if (status.privacyStatus !== 'unlisted') {
          console.warn(`[${ch.name}] ${m.name}: privacyStatus=${status.privacyStatus}, 수동 확인 필요`);
          row(m, '스킵', `privacyStatus=${status.privacyStatus} (unlisted만 전환)`);
          continue;
        }
        if (attempts >= batch) { row(m, '이월', `채널당 1회 ${batch}편 상한`); continue; }
        attempts += 1;
        if (dryRun) { row(m, '공개 예정 (dry_run)'); continue; }
        try {
          await setPublic(token, m.data.youtube_id, status, { fetchImpl });
          units += 50;
          writeManifestFields(m, { published_at: now().toISOString() });
          console.log(`[${ch.name}] ${m.name} public 전환: ${m.data.youtube_id}`);
          row(m, 'public 전환');
        } catch (e) {
          if (e instanceof QuotaExceededError) throw e;
          console.error(`[${ch.name}] ${m.name} 실패: ${e.message}`);
          row(m, '실패', e.message);
          failures += 1;
        }
      }
    }
  } catch (e) {
    if (!(e instanceof QuotaExceededError)) throw e;
    quotaError = e;
    console.error(`쿼터 초과: ${e.message}. 재시도하지 않고 다음 실행으로 이월.`);
    const done = new Set(rows.map((r) => r[1]));
    for (const m of due) if (!done.has(m.name)) row(m, '이월', '쿼터 초과 (다음 실행)');
  }

  const lines = [
    `## yt-publish${dryRun ? ' (dry_run)' : ''}`,
    '',
    `- 기준 주차(KST): ${week}, 공개 대상 ${due.length}편`,
    `- 추정 쿼터 사용: ${units} units (videos.update 50, channels.list·videos.list 1)`,
  ];
  if (quotaError) lines.push(`- **쿼터 초과로 중단**: ${quotaError.message}`);
  lines.push('', rows.length ? markdownTable(['채널', '매니페스트', 'youtube_id', '공개 주차', '결과', '비고'], rows) : '공개 대상 없음');
  writeSummary(lines.join('\n'), env);
  return failures > 0 || quotaError ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPublish().then((code) => { process.exitCode = code; }, (e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
