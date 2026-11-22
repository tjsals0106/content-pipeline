import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { parseDailyLimit, runUpload } from '../upload.mjs';
import { buildInsertBody, resumableUpload } from '../lib/youtube.mjs';
import { VALID, tmpVideosDir } from './helpers.mjs';

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const quota = () => json(403, { error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] } });

function fakeGoogle({ insertResponse } = {}) {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push(`${init.method ?? 'GET'} ${u}`);
    if (u.includes('oauth2.googleapis.com/token')) return json(200, { access_token: 'at' });
    if (u.includes('/youtube/v3/channels')) return json(200, { items: [{ id: 'UC1', snippet: { title: 'Seonmin MOV' }, contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] });
    if (u.includes('/youtube/v3/playlistItems')) return json(200, { items: [] });
    if (u.includes('/drive/v3/files?')) return json(200, { files: [{ id: 'F1', name: 'test.mp4', mimeType: 'video/mp4', size: String(40 * 1024 * 1024) }] });
    if (u.includes('alt=media')) return new Response(Buffer.from('video-bytes'), { status: 200 });
    if (u.includes('uploadType=resumable')) return insertResponse ? insertResponse() : new Response(null, { status: 200, headers: { location: 'https://upload/session' } });
    if (u === 'https://upload/session') return json(201, { id: `VID${++n}` });
    throw new Error(`unexpected ${u}`);
  };
  return { fetchImpl, calls };
}

const baseEnv = (dir) => ({
  VIDEOS_DIR: dir, YT_CLIENT_ID: 'c', YT_CLIENT_SECRET: 's', DRIVE_REFRESH_TOKEN: 'd',
  DRIVE_VIDEO_FOLDER_ID: 'FOLDER', YT_SEONMINMOV_REFRESH_TOKEN: 'r',
});
const opts = (env, fetchImpl) => ({ env, fetchImpl, probe: () => null, sleep: async () => {}, tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), 'yt-up-')) });
const read = (dir, f) => YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const meliv = VALID.replace('seonmin_mov', 'meliv_music').replace('test.mp4', 'meliv.mp4');

test('insert 본문은 항상 privacyStatus=unlisted', () => {
  const body = buildInsertBody(YAML.parse(VALID));
  assert.equal(body.status.privacyStatus, 'unlisted');
  assert.equal(body.status.selfDeclaredMadeForKids, false);
});

test('업로드 후 youtube_id/uploaded_at 기록, search.list 미호출, 토큰 없는 채널은 스킵', async () => {
  const dir = tmpVideosDir({ 'a.yml': VALID, 'b.yml': meliv });
  const { fetchImpl, calls } = fakeGoogle();
  const code = await runUpload(opts(baseEnv(dir), fetchImpl));
  assert.equal(code, 0);
  assert.equal(read(dir, 'a.yml').youtube_id, 'VID1');
  assert.ok(read(dir, 'a.yml').uploaded_at);
  assert.equal(read(dir, 'b.yml').youtube_id, null);
  assert.ok(!calls.some((c) => c.includes('/search')));
  assert.ok(!calls.some((c) => c.includes('thumbnails')));
  assert.equal(calls.filter((c) => c.includes('uploadType=resumable')).length, 1);
});

test('dry_run은 네트워크 호출과 기록 없음', async () => {
  const dir = tmpVideosDir({ 'a.yml': VALID });
  const { fetchImpl, calls } = fakeGoogle();
  const code = await runUpload(opts({ ...baseEnv(dir), DRY_RUN: 'true' }, fetchImpl));
  assert.equal(code, 0);
  assert.equal(calls.length, 0);
  assert.equal(read(dir, 'a.yml').youtube_id, null);
});

test('PT 날짜 기준 일 상한을 넘으면 이월', async () => {
  const now = new Date('2026-11-22T12:00:00Z');
  const files = {};
  for (let i = 0; i < 10; i++) {
    files[`u${i}.yml`] = VALID.replace('test.mp4', `u${i}.mp4`)
      .replace('youtube_id: null', `youtube_id: "AAAAAAAAAA${i}"`).replace('uploaded_at: null', `uploaded_at: "${now.toISOString()}"`);
  }
  files['new.yml'] = VALID;
  const dir = tmpVideosDir(files);
  const { fetchImpl, calls } = fakeGoogle();
  const code = await runUpload({ ...opts(baseEnv(dir), fetchImpl), now: () => now });
  assert.equal(code, 0);
  assert.equal(calls.length, 0);
  assert.equal(read(dir, 'new.yml').youtube_id, null);
});

test('quotaExceeded는 재시도 없이 중단하고 실패 코드', async () => {
  const dir = tmpVideosDir({ 'a.yml': VALID, 'c.yml': VALID.replace('test.mp4', 'c.mp4') });
  let inserts = 0;
  const { fetchImpl } = fakeGoogle({ insertResponse: () => { inserts += 1; return quota(); } });
  const code = await runUpload(opts(baseEnv(dir), fetchImpl));
  assert.equal(code, 1);
  assert.equal(inserts, 1);
  assert.equal(read(dir, 'a.yml').youtube_id, null);
});

test('토큰이 만료된 채널은 일 상한을 소모하지 않음', async () => {
  const files = { 'v.yml': VALID.replace('seonmin_mov', 'viriditas_worship').replace('test.mp4', 'v.mp4') };
  for (let i = 0; i < 10; i++) files[`s${i}.yml`] = VALID.replace('test.mp4', `s${i}.mp4`).replace('테스트 영상', `영상 ${i}`);
  const dir = tmpVideosDir(files);
  const { fetchImpl: base } = fakeGoogle();
  const fetchImpl = async (url, init) => {
    if (String(url).includes('oauth2') && init.body.get?.('refresh_token') === 'r') return json(400, { error: 'invalid_grant' });
    return base(url, init);
  };
  const code = await runUpload(opts({ ...baseEnv(dir), YT_VIRIDITAS_REFRESH_TOKEN: 'v' }, fetchImpl));
  assert.equal(code, 1);
  assert.equal(read(dir, 'v.yml').youtube_id, 'VID1');
});

test('같은 제목 영상이 채널에 있으면 ID를 연결하지도 업로드하지도 않음', async () => {
  const dir = tmpVideosDir({ 'new.yml': VALID });
  const { fetchImpl: base, calls } = fakeGoogle();
  const fetchImpl = async (url, init) => (String(url).includes('/playlistItems')
    ? json(200, { items: [{ snippet: { title: '테스트 영상' }, contentDetails: { videoId: 'OTHEROTHER1' } }] })
    : base(url, init));
  assert.equal(await runUpload(opts(baseEnv(dir), fetchImpl)), 1);
  assert.equal(read(dir, 'new.yml').youtube_id, null);
  assert.equal(read(dir, 'new.yml').uploaded_at, null);
  assert.equal(calls.filter((c) => c.includes('uploadType=resumable')).length, 0);
});

test('DAILY_UPLOAD_LIMIT 경계값: 비움=10, 0~10 허용, 11 이상은 10으로 제한', () => {
  assert.equal(parseDailyLimit(undefined), 10);
  assert.equal(parseDailyLimit(''), 10);
  assert.equal(parseDailyLimit('0'), 0);
  assert.equal(parseDailyLimit('1'), 1);
  assert.equal(parseDailyLimit('10'), 10);
  assert.equal(parseDailyLimit('11'), 10);
  assert.equal(parseDailyLimit('100'), 10);
});

test('DAILY_UPLOAD_LIMIT 잘못된 값은 오류', () => {
  for (const v of ['abc', '-1', '1.5', '5x', ' 3 4']) assert.throws(() => parseDailyLimit(v), /DAILY_UPLOAD_LIMIT/, v);
});

test('DAILY_UPLOAD_LIMIT 오류 시 업로드 없이 실패', async () => {
  const dir = tmpVideosDir({ 'a.yml': VALID });
  const { fetchImpl, calls } = fakeGoogle();
  assert.equal(await runUpload(opts({ ...baseEnv(dir), DAILY_UPLOAD_LIMIT: 'abc' }, fetchImpl)), 1);
  assert.equal(calls.length, 0);
});

test('DAILY_UPLOAD_LIMIT=100이어도 하루 10편까지만', async () => {
  const files = {};
  for (let i = 0; i < 11; i++) files[`s${i}.yml`] = VALID.replace('test.mp4', `s${i}.mp4`).replace('테스트 영상', `영상 ${i}`);
  const dir = tmpVideosDir(files);
  const { fetchImpl, calls } = fakeGoogle();
  assert.equal(await runUpload(opts({ ...baseEnv(dir), DAILY_UPLOAD_LIMIT: '100' }, fetchImpl)), 0);
  assert.equal(calls.filter((c) => c.includes('uploadType=resumable')).length, 10);
});

test('검증 실패 시 업로드하지 않음', async () => {
  const dir = tmpVideosDir({ 'a.yml': VALID.replace('seonmin_mov', 'nope') });
  const { fetchImpl, calls } = fakeGoogle();
  assert.equal(await runUpload(opts(baseEnv(dir), fetchImpl)), 1);
  assert.equal(calls.length, 0);
});

test('resumable 업로드는 5xx 후 같은 세션에서 받은 위치부터 재개', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yt-r-')), 'v.mp4');
  fs.writeFileSync(file, Buffer.alloc(10, 1));
  const log = [];
  let chunkCalls = 0;
  const fetchImpl = async (url, init) => {
    const range = init.headers['Content-Range'];
    log.push(`${String(url).includes('uploadType') ? 'init' : 'put'} ${range ?? ''}`);
    if (String(url).includes('uploadType')) return new Response(null, { status: 200, headers: { location: 'https://s' } });
    if (range === 'bytes */10') return new Response(null, { status: 308, headers: { range: 'bytes=0-3' } });
    chunkCalls += 1;
    if (chunkCalls === 1) return new Response(null, { status: 308, headers: { range: 'bytes=0-3' } });
    if (chunkCalls === 2) return new Response('', { status: 503 });
    return json(200, { id: 'X' });
  };
  const id = await resumableUpload('t', { body: {}, filePath: file }, { fetchImpl, sleep: async () => {}, chunkSize: 4 });
  assert.equal(id, 'X');
  assert.equal(log.filter((l) => l.startsWith('init')).length, 1);
  assert.deepEqual(log.slice(1), ['put bytes 0-3/10', 'put bytes 4-7/10', 'put bytes */10', 'put bytes 4-7/10']);
});

test('청크 재개 중 상태 조회가 quotaExceeded면 즉시 중단', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yt-r-')), 'v.mp4');
  fs.writeFileSync(file, Buffer.alloc(10, 1));
  let puts = 0;
  const fetchImpl = async (url, init) => {
    if (String(url).includes('uploadType')) return new Response(null, { status: 200, headers: { location: 'https://s' } });
    puts += 1;
    if (init.headers['Content-Range'] === 'bytes */10') return quota();
    return new Response('', { status: 503 });
  };
  await assert.rejects(resumableUpload('t', { body: {}, filePath: file }, { fetchImpl, sleep: async () => {} }), { name: 'QuotaExceededError' });
  assert.equal(puts, 2);
});

test('resumable 업로드도 quotaExceeded는 재시도 없음', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yt-r-')), 'v.mp4');
  fs.writeFileSync(file, Buffer.alloc(10, 1));
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return quota(); };
  await assert.rejects(resumableUpload('t', { body: {}, filePath: file }, { fetchImpl, sleep: async () => {} }), { name: 'QuotaExceededError' });
  assert.equal(calls, 1);
});
