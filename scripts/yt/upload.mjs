#!/usr/bin/env node
// 매니페스트에 등록된 영상을 드라이브에서 받아 채널별 토큰으로 unlisted 업로드하고 youtube_id를 기록한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHANNELS, CHANNEL_KEYS, channelRefreshToken, expectedChannelId } from './lib/channels.mjs';
import { QuotaExceededError, getAccessToken, requireEnv } from './lib/google.mjs';
import { listManifestFiles, loadManifest, validateManifests, videosDir, writeManifestFields } from './lib/manifest.mjs';
import { resolveDriveFile, downloadDriveFile } from './lib/drive.mjs';
import { buildInsertBody, getMyChannel, listRecentUploads, resumableUpload } from './lib/youtube.mjs';
import { classifyVideo, probeVideo } from './lib/probe.mjs';
import { ptDate } from './lib/time.mjs';
import { markdownTable, writeSummary } from './lib/summary.mjs';

const MB = 1024 * 1024;
export const MAX_BYTES = 512 * MB;
export const EXPECTED_MIN_BYTES = 30 * MB;
export const EXPECTED_MAX_BYTES = 80 * MB;

function checkDriveFile(file) {
  const warnings = [];
  const size = Number(file.size);
  if (!(/\.(mp4|mov)$/i.test(file.name ?? '') || ['video/mp4', 'video/quicktime'].includes(file.mimeType))) throw new Error(`MP4 또는 MOV가 아님 (${file.name}, ${file.mimeType})`);
  if (!size) throw new Error('파일 크기 0 또는 알 수 없음');
  if (size > MAX_BYTES) throw new Error(`파일이 너무 큼 (${(size / MB).toFixed(1)}MB > 512MB)`);
  if (size < EXPECTED_MIN_BYTES || size > EXPECTED_MAX_BYTES) warnings.push(`크기 ${(size / MB).toFixed(1)}MB (예상 30~80MB)`);
  return warnings;
}

export const MAX_DAILY_UPLOADS = 10;

// 비우면 10. 0 이상 정수만 허용하고 10을 넘으면 10으로 제한한다. 그 외 값은 오류.
export function parseDailyLimit(value) {
  if (value === undefined || value === null || String(value).trim() === '') return MAX_DAILY_UPLOADS;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new Error(`DAILY_UPLOAD_LIMIT 값(${text})이 올바르지 않음 (0~${MAX_DAILY_UPLOADS} 정수)`);
  const n = Number(text);
  if (n > MAX_DAILY_UPLOADS) {
    console.warn(`DAILY_UPLOAD_LIMIT ${n}은 상한 ${MAX_DAILY_UPLOADS}을 넘어 ${MAX_DAILY_UPLOADS}으로 제한`);
    return MAX_DAILY_UPLOADS;
  }
  return n;
}

export async function runUpload({
  args = [], env = process.env, fetchImpl = fetch, now = () => new Date(), sleep, probe = probeVideo, tmpDir,
} = {}) {
  const dryRun = env.DRY_RUN === 'true';
  const all = listManifestFiles(videosDir(env)).map(loadManifest);
  const targetsArg = args.filter(Boolean).map((a) => path.resolve(a));
  for (const t of targetsArg) if (!all.some((m) => m.file === t)) all.push(loadManifest(t));

  const results = validateManifests(all);
  const invalid = all.filter((m) => results.get(m.name).length);
  if (invalid.length) {
    for (const m of invalid) for (const e of results.get(m.name)) console.error(`${m.name}: ${e.field}: ${e.message}`);
    writeSummary(`## yt-upload\n\n매니페스트 검증 실패 ${invalid.length}건. 업로드하지 않음.`, env);
    return 1;
  }

  const selected = (targetsArg.length ? all.filter((m) => targetsArg.includes(m.file)) : all)
    .filter((m) => !m.data.youtube_id);

  let limit;
  try {
    limit = parseDailyLimit(env.DAILY_UPLOAD_LIMIT);
  } catch (e) {
    console.error(e.message);
    writeSummary(`## yt-upload\n\n${e.message}. 업로드하지 않음.`, env);
    return 1;
  }
  const today = ptDate(now());
  const usedToday = all.filter((m) => m.data.uploaded_at && ptDate(new Date(m.data.uploaded_at)) === today).length;
  let capacity = Math.max(limit - usedToday, 0);

  const rows = new Map(); // name -> row
  const setRow = (m, result, extra = {}) => rows.set(m.name, {
    channel: CHANNELS[m.data.channel].name, name: m.name, youtubeId: '', kind: '', note: '', ...rows.get(m.name), ...extra, result,
  });

  const plan = new Map(); // channelKey -> manifests to upload
  for (const key of CHANNEL_KEYS) {
    const list = selected.filter((m) => m.data.channel === key);
    if (!list.length) continue;
    if (!channelRefreshToken(key, env)) {
      console.log(`[${CHANNELS[key].name}] ${CHANNELS[key].tokenEnv} 없음: ${list.length}편 스킵`);
      for (const m of list) setRow(m, '스킵', { note: `토큰 없음 (${CHANNELS[key].tokenEnv})` });
      continue;
    }
    plan.set(key, list);
    for (const m of list) {
      if (!dryRun) setRow(m, '대기');
      else if (capacity > 0) { capacity -= 1; setRow(m, '업로드 예정 (dry_run)'); }
      else setRow(m, '이월', { note: `일 상한 ${limit}편 도달 (PT ${today})` });
    }
  }
  const capacityNote = `일 상한 ${limit}편 도달 (PT ${today})`;

  let units = 0;
  let failures = 0;
  let quotaError = null;

  if (!dryRun && plan.size) {
    const workDir = tmpDir ?? env.RUNNER_TEMP ?? os.tmpdir();
    let driveToken = null;
    const getDriveToken = async () => (driveToken ??= await getAccessToken(requireEnv('DRIVE_REFRESH_TOKEN', env), { fetchImpl, env }));

    try {
      for (const [key, list] of plan) {
        const ch = CHANNELS[key];
        if (capacity <= 0) {
          for (const m of list) setRow(m, '이월', { note: capacityNote });
          continue;
        }
        let token;
        let channel;
        try {
          token = await getAccessToken(channelRefreshToken(key, env), { fetchImpl, env });
          channel = await getMyChannel(token, { fetchImpl });
          units += 1;
          const expected = expectedChannelId(key, env);
          if (expected && expected !== channel.id) throw new Error(`토큰 채널(${channel.id})이 ${ch.channelIdEnv}(${expected})와 다름`);
          console.log(`[${ch.name}] 채널 확인: ${channel.title} (${channel.id})`);
        } catch (e) {
          if (e instanceof QuotaExceededError) throw e;
          console.error(`[${ch.name}] 채널 준비 실패: ${e.message}`);
          for (const m of list) setRow(m, '실패', { note: `채널 준비 실패: ${e.message}` });
          failures += list.length;
          continue;
        }

        let recent = null;
        for (const m of list) {
          let localFile = null;
          try {
            if (recent === null) {
              recent = channel.uploadsPlaylistId ? await listRecentUploads(token, channel.uploadsPlaylistId, { fetchImpl }) : [];
              units += 1;
            }
            const dup = recent.find((v) => v.title === m.data.title);
            // 제목 일치만으로는 같은 영상이라 보장할 수 없으므로 ID를 기록하지 않는다 (오연결 → 오공개 방지).
            // 업로드도 하지 않고 사람 확인을 요구한다. 같은 영상이면 매니페스트에 youtube_id를 직접 기록하면 된다.
            if (dup) {
              setRow(m, '확인 필요', { note: `채널에 같은 제목 영상(${dup.videoId})이 있어 업로드 보류. 같은 영상이면 youtube_id를 직접 기록, 아니면 제목 변경` });
              failures += 1;
              continue;
            }
            if (capacity <= 0) {
              setRow(m, '이월', { note: capacityNote });
              continue;
            }
            const dToken = await getDriveToken();
            const file = await resolveDriveFile(dToken, m.data.source, { folderId: env.DRIVE_VIDEO_FOLDER_ID, fetchImpl });
            const warnings = checkDriveFile(file);
            localFile = path.join(workDir, `${m.slug}${/\.mov$/i.test(file.name ?? '') ? '.mov' : '.mp4'}`);
            await downloadDriveFile(dToken, file.id, localFile, { fetchImpl });
            const { kind, warnings: probeWarnings } = classifyVideo(probe(localFile));
            warnings.push(...probeWarnings);

            capacity -= 1;
            console.log(`[${ch.name}] ${m.name} 업로드 시작 (${kind})`);
            const videoId = await resumableUpload(token, { body: buildInsertBody(m.data), filePath: localFile }, {
              fetchImpl, sleep, log: (msg) => console.log(`[${ch.name}] ${m.name} ${msg}`),
            });
            units += 1;
            writeManifestFields(m, { youtube_id: videoId, uploaded_at: now().toISOString() });
            console.log(`[${ch.name}] ${m.name} 업로드 완료: ${videoId}`);
            setRow(m, '업로드 (unlisted)', { youtubeId: videoId, kind, note: warnings.join('; ') });
          } catch (e) {
            if (e instanceof QuotaExceededError) throw e;
            console.error(`[${ch.name}] ${m.name} 실패: ${e.message}`);
            setRow(m, '실패', { note: e.message });
            failures += 1;
          } finally {
            if (localFile) fs.rmSync(localFile, { force: true });
          }
        }
      }
    } catch (e) {
      if (!(e instanceof QuotaExceededError)) throw e;
      quotaError = e;
      console.error(`쿼터 초과: ${e.message}. 재시도하지 않고 남은 영상은 다음 실행으로 이월.`);
      for (const list of plan.values()) {
        for (const m of list) if (rows.get(m.name).result === '대기') setRow(m, '이월', { note: '쿼터 초과 (다음 실행)' });
      }
    }
  }

  const lines = [
    `## yt-upload${dryRun ? ' (dry_run)' : ''}`,
    '',
    `- 일 상한: PT ${today} 기준 ${usedToday}/${limit}편 사용, 이번 실행 업로드 가능 ${Math.max(limit - usedToday, 0)}편`,
    `- 추정 쿼터 사용: ${units} units (insert 1, channels.list 1, playlistItems.list 1)`,
  ];
  if (quotaError) lines.push(`- **쿼터 초과로 중단**: ${quotaError.message}`);
  lines.push('');
  lines.push(rows.size
    ? markdownTable(['채널', '매니페스트', '결과', 'youtube_id', '분류', '비고'],
      [...rows.values()].map((r) => [r.channel, r.name, r.result, r.youtubeId, r.kind, r.note]))
    : '업로드 대상 없음 (youtube_id 없는 매니페스트 없음)');
  writeSummary(lines.join('\n'), env);

  return failures > 0 || quotaError ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runUpload({ args: process.argv.slice(2) }).then((code) => { process.exitCode = code; }, (e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
