import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { runPublish } from '../publish.mjs';
import { buildPublicStatus } from '../lib/youtube.mjs';
import { kstIsoWeek } from '../lib/time.mjs';
import { VALID, tmpVideosDir } from './helpers.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const NOW = new Date('2026-11-27T12:17:00Z'); // 금 21:17 KST, 2026-W48

const uploaded = (id, extra = {}) => {
  let t = VALID.replace('test.mp4', `${id}.mp4`).replace('youtube_id: null', `youtube_id: "${id}"`)
    .replace('uploaded_at: null', `uploaded_at: "${extra.uploadedAt ?? '2026-11-20T00:00:00.000Z'}"`);
  if (extra.week) t = t.replace('publish_week: "2026-W48"', `publish_week: "${extra.week}"`);
  if (extra.channel) t = t.replace('seonmin_mov', extra.channel);
  return t;
};

function fake(statuses, { updateResponse } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ method: init.method ?? 'GET', url: u, body: init.body });
    if (u.includes('oauth2.googleapis.com/token')) return json(200, { access_token: 'at' });
    if (u.includes('/channels')) return json(200, { items: [{ id: 'UC1', snippet: { title: 'S' }, contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] });
    if (u.includes('/videos?part=status&id=')) {
      const ids = new URL(u).searchParams.get('id').split(',');
      return json(200, { items: ids.filter((id) => statuses[id]).map((id) => ({ id, status: statuses[id] })) });
    }
    if (init.method === 'PUT' && u.includes('/videos?part=status')) return updateResponse ? updateResponse() : json(200, {});
    throw new Error(`unexpected ${u}`);
  };
  return { fetchImpl, calls };
}

const env = (dir, extra = {}) => ({ VIDEOS_DIR: dir, YT_CLIENT_ID: 'c', YT_CLIENT_SECRET: 's', YT_SEONMINMOV_REFRESH_TOKEN: 'r', DRY_RUN: 'false', ...extra });
const read = (dir, f) => YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const unlisted = { privacyStatus: 'unlisted', uploadStatus: 'processed', embeddable: true, license: 'youtube', publicStatsViewable: true, selfDeclaredMadeForKids: false };
const updates = (calls) => calls.filter((c) => c.method === 'PUT');

test('KST ISO 주차', () => {
  assert.equal(kstIsoWeek(NOW), '2026-W48');
  assert.equal(kstIsoWeek(new Date('2026-11-29T15:30:00Z')), '2026-W49'); // 월 00:30 KST
});

test('public 전환 시 privacyStatus만 바꾸고 다른 status 값 유지', () => {
  assert.deepEqual(buildPublicStatus({ ...unlisted, uploadStatus: 'processed', madeForKids: false }), {
    privacyStatus: 'public', embeddable: true, license: 'youtube', publicStatsViewable: true, selfDeclaredMadeForKids: false,
  });
});

test('공개 주차 도래한 unlisted 영상을 public 전환하고 published_at 기록, 미래 주차는 제외', async () => {
  const dir = tmpVideosDir({ 'a.yml': uploaded('AAAAAAAAAAA'), 'f.yml': uploaded('FFFFFFFFFFF', { week: '2026-W50' }) });
  const { fetchImpl, calls } = fake({ AAAAAAAAAAA: unlisted, FFFFFFFFFFF: unlisted });
  assert.equal(await runPublish({ env: env(dir), fetchImpl, now: () => NOW }), 0);
  assert.ok(read(dir, 'a.yml').published_at);
  assert.equal(read(dir, 'f.yml').published_at, null);
  assert.equal(updates(calls).length, 1);
  assert.equal(JSON.parse(updates(calls)[0].body).status.privacyStatus, 'public');
});

test('이미 public이면 videos.update 없이 기록만', async () => {
  const dir = tmpVideosDir({ 'a.yml': uploaded('AAAAAAAAAAA') });
  const { fetchImpl, calls } = fake({ AAAAAAAAAAA: { ...unlisted, privacyStatus: 'public' } });
  assert.equal(await runPublish({ env: env(dir), fetchImpl, now: () => NOW }), 0);
  assert.equal(updates(calls).length, 0);
  assert.ok(read(dir, 'a.yml').published_at);
});

test('private·처리 중 영상은 전환하지 않음', async () => {
  const dir = tmpVideosDir({ 'p.yml': uploaded('PPPPPPPPPPP'), 'q.yml': uploaded('QQQQQQQQQQQ') });
  const { fetchImpl, calls } = fake({ PPPPPPPPPPP: { ...unlisted, privacyStatus: 'private' }, QQQQQQQQQQQ: { ...unlisted, uploadStatus: 'uploaded' } });
  assert.equal(await runPublish({ env: env(dir), fetchImpl, now: () => NOW }), 0);
  assert.equal(updates(calls).length, 0);
  assert.equal(read(dir, 'p.yml').published_at, null);
  assert.equal(read(dir, 'q.yml').published_at, null);
});

test('dry_run(기본값)은 update·기록 없음', async () => {
  const dir = tmpVideosDir({ 'a.yml': uploaded('AAAAAAAAAAA') });
  const { fetchImpl, calls } = fake({ AAAAAAAAAAA: unlisted });
  const e = env(dir);
  delete e.DRY_RUN;
  assert.equal(await runPublish({ env: e, fetchImpl, now: () => NOW }), 0);
  assert.equal(updates(calls).length, 0);
  assert.equal(read(dir, 'a.yml').published_at, null);
});

test('토큰 없는 채널은 스킵', async () => {
  const dir = tmpVideosDir({ 'm.yml': uploaded('MMMMMMMMMMM', { channel: 'meliv_music' }) });
  const { fetchImpl, calls } = fake({});
  assert.equal(await runPublish({ env: env(dir), fetchImpl, now: () => NOW }), 0);
  assert.equal(calls.length, 0);
});

test('채널당 배치 상한, 오래된 업로드부터', async () => {
  const dir = tmpVideosDir({
    'a.yml': uploaded('AAAAAAAAAAA', { uploadedAt: '2026-11-21T00:00:00.000Z' }),
    'b.yml': uploaded('BBBBBBBBBBB', { uploadedAt: '2026-11-19T00:00:00.000Z' }),
  });
  const { fetchImpl } = fake({ AAAAAAAAAAA: unlisted, BBBBBBBBBBB: unlisted });
  assert.equal(await runPublish({ env: env(dir, { PUBLISH_BATCH_SIZE: '1' }), fetchImpl, now: () => NOW }), 0);
  assert.ok(read(dir, 'b.yml').published_at);
  assert.equal(read(dir, 'a.yml').published_at, null);
});

test('private 영상은 배치 상한을 차지하지 않음', async () => {
  const dir = tmpVideosDir({
    'p.yml': uploaded('PPPPPPPPPPP', { uploadedAt: '2026-11-18T00:00:00.000Z' }),
    'a.yml': uploaded('AAAAAAAAAAA', { uploadedAt: '2026-11-21T00:00:00.000Z' }),
  });
  const { fetchImpl } = fake({ PPPPPPPPPPP: { ...unlisted, privacyStatus: 'private' }, AAAAAAAAAAA: unlisted });
  assert.equal(await runPublish({ env: env(dir, { PUBLISH_BATCH_SIZE: '1' }), fetchImpl, now: () => NOW }), 0);
  assert.ok(read(dir, 'a.yml').published_at);
});

test('PUBLISH_BATCH_SIZE가 숫자가 아니면 10으로 처리', async () => {
  const dir = tmpVideosDir({ 'a.yml': uploaded('AAAAAAAAAAA') });
  const { fetchImpl } = fake({ AAAAAAAAAAA: unlisted });
  assert.equal(await runPublish({ env: env(dir, { PUBLISH_BATCH_SIZE: 'abc' }), fetchImpl, now: () => NOW }), 0);
  assert.ok(read(dir, 'a.yml').published_at);
});

test('quotaExceeded는 재시도 없이 중단', async () => {
  const dir = tmpVideosDir({ 'a.yml': uploaded('AAAAAAAAAAA'), 'b.yml': uploaded('BBBBBBBBBBB') });
  const quota = () => json(403, { error: { code: 403, message: 'q', errors: [{ reason: 'quotaExceeded' }] } });
  const { fetchImpl, calls } = fake({ AAAAAAAAAAA: unlisted, BBBBBBBBBBB: unlisted }, { updateResponse: quota });
  assert.equal(await runPublish({ env: env(dir), fetchImpl, now: () => NOW }), 1);
  assert.equal(updates(calls).length, 1);
  assert.equal(read(dir, 'a.yml').published_at, null);
  assert.equal(read(dir, 'b.yml').published_at, null);
});

test('결과 파일을 쓸 수 없어도 공개 성공 상태(0) 유지', async () => {
  const dir = tmpVideosDir({ 'a.yml': uploaded('AAAAAAAAAAA') });
  const { fetchImpl } = fake({ AAAAAAAAAAA: unlisted });
  assert.equal(await runPublish({ env: env(dir, { YT_RESULT_FILE: '/nonexistent-dir/yt/r.json' }), fetchImpl, now: () => NOW }), 0);
  assert.ok(read(dir, 'a.yml').published_at);
});
