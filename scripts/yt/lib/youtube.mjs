import fs from 'node:fs';
import { ApiError, apiErrorFromResponse } from './google.mjs';

const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/youtube/v3/videos';
export const CHUNK_SIZE = 8 * 1024 * 1024; // 256KiB의 배수
export const MAX_RETRIES = 5;

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getMyChannel(token, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${API}/channels?part=id,snippet,contentDetails&mine=true`, { headers: auth(token) });
  if (!res.ok) throw await apiErrorFromResponse(res, 'channels.list');
  const item = (await res.json()).items?.[0];
  if (!item) throw new ApiError('토큰에 연결된 YouTube 채널이 없음');
  return { id: item.id, title: item.snippet?.title, uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads };
}

// 업로드 재생목록의 최근 영상(최대 50개). search.list는 쓰지 않는다.
export async function listRecentUploads(token, playlistId, { fetchImpl = fetch } = {}) {
  const params = new URLSearchParams({ part: 'snippet,contentDetails', playlistId, maxResults: '50' });
  const res = await fetchImpl(`${API}/playlistItems?${params}`, { headers: auth(token) });
  if (!res.ok) throw await apiErrorFromResponse(res, 'playlistItems.list');
  return ((await res.json()).items ?? []).map((i) => ({
    videoId: i.contentDetails?.videoId ?? i.snippet?.resourceId?.videoId,
    title: i.snippet?.title,
  }));
}

export function buildInsertBody(data) {
  return {
    snippet: {
      title: data.title,
      description: data.description ?? '',
      tags: data.tags ?? [],
      categoryId: data.category_id ?? '22',
      defaultLanguage: data.default_language ?? 'ko',
      defaultAudioLanguage: data.default_language ?? 'ko',
    },
    status: {
      privacyStatus: 'unlisted', // 생략하면 public이 되므로 항상 명시
      selfDeclaredMadeForKids: data.made_for_kids,
      embeddable: true,
      license: 'youtube',
    },
  };
}

function nextOffsetFromRange(res) {
  const range = res.headers.get('range');
  const m = range && /bytes=0-(\d+)/.exec(range);
  return m ? Number(m[1]) + 1 : 0;
}

function readChunk(fd, offset, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, offset);
  return buf.subarray(0, n);
}

const isRetryableStatus = (s) => s >= 500 && s < 600;

// videos.insert resumable 업로드. 실패 시 같은 세션에서 청크 단위로만 재개하고, insert를 새로 호출하지 않는다.
export async function resumableUpload(token, { body, filePath }, { fetchImpl = fetch, sleep = defaultSleep, chunkSize = CHUNK_SIZE, log = () => {} } = {}) {
  const total = fs.statSync(filePath).size;
  const init = await fetchImpl(`${UPLOAD_API}?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: {
      ...auth(token),
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(total),
      'X-Upload-Content-Type': 'video/mp4',
    },
    body: JSON.stringify(body),
  });
  if (!init.ok) throw await apiErrorFromResponse(init, 'videos.insert');
  const sessionUrl = init.headers.get('location');
  if (!sessionUrl) throw new ApiError('videos.insert 업로드 세션 URL이 없음');

  const fd = fs.openSync(filePath, 'r');
  try {
    let offset = 0;
    let retries = 0;
    for (;;) {
      let res;
      try {
        if (offset >= total && total > 0) {
          res = await fetchImpl(sessionUrl, { method: 'PUT', headers: { ...auth(token), 'Content-Range': `bytes */${total}` } });
        } else {
          const chunk = readChunk(fd, offset, Math.min(chunkSize, total - offset));
          res = await fetchImpl(sessionUrl, {
            method: 'PUT',
            headers: { ...auth(token), 'Content-Length': String(chunk.length), 'Content-Range': `bytes ${offset}-${offset + chunk.length - 1}/${total}` },
            body: chunk,
          });
        }
      } catch (e) {
        res = { networkError: e };
      }

      if (res.status === 200 || res.status === 201) {
        const json = await res.json();
        if (!json.id) throw new ApiError('videos.insert 응답에 영상 ID가 없음');
        return json.id;
      }
      if (res.status === 308) {
        offset = nextOffsetFromRange(res);
        retries = 0;
        continue;
      }
      if (res.status === 404 || res.status === 410) throw new ApiError(`업로드 세션 만료 (HTTP ${res.status})`, { status: res.status });
      if (!res.networkError && !isRetryableStatus(res.status)) throw await apiErrorFromResponse(res, 'videos.insert 청크');

      // 5xx 또는 네트워크 오류: 백오프 후 서버가 받은 위치를 조회해 그 지점부터 재개
      retries += 1;
      if (retries > MAX_RETRIES) throw new ApiError(`청크 재개 ${MAX_RETRIES}회 초과 (${res.networkError ? res.networkError.message : `HTTP ${res.status}`})`);
      const wait = 1000 * 2 ** (retries - 1);
      log(`청크 업로드 오류(${res.networkError ? '네트워크' : `HTTP ${res.status}`}), ${wait / 1000}초 후 재개 (${retries}/${MAX_RETRIES})`);
      await sleep(wait);
      let status;
      try {
        status = await fetchImpl(sessionUrl, { method: 'PUT', headers: { ...auth(token), 'Content-Range': `bytes */${total}` } });
      } catch {
        continue;
      }
      if (status.status === 200 || status.status === 201) {
        const json = await status.json();
        return json.id;
      }
      if (status.status === 308) offset = nextOffsetFromRange(status);
      else if (status.status === 404 || status.status === 410) throw new ApiError(`업로드 세션 만료 (HTTP ${status.status})`, { status: status.status });
      else if (!isRetryableStatus(status.status)) throw await apiErrorFromResponse(status, 'videos.insert 상태 조회');
    }
  } finally {
    fs.closeSync(fd);
  }
}

// videos.list (1 unit/호출, 최대 50개 ID)
export async function listVideoStatuses(token, ids, { fetchImpl = fetch } = {}) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const params = new URLSearchParams({ part: 'status', id: ids.slice(i, i + 50).join(','), maxResults: '50' });
    const res = await fetchImpl(`${API}/videos?${params}`, { headers: auth(token) });
    if (!res.ok) throw await apiErrorFromResponse(res, 'videos.list');
    const json = await res.json();
    for (const item of json.items ?? []) out.set(item.id, item.status ?? {});
  }
  return out;
}

const WRITABLE_STATUS = ['embeddable', 'license', 'publicStatsViewable', 'selfDeclaredMadeForKids', 'containsSyntheticMedia'];

// part=status 업데이트는 보내지 않은 쓰기 가능 필드를 기본값으로 되돌리므로 현재 값을 그대로 실어 privacyStatus만 바꾼다.
export function buildPublicStatus(current) {
  const status = { privacyStatus: 'public' };
  for (const k of WRITABLE_STATUS) if (current[k] !== undefined) status[k] = current[k];
  return status;
}

// videos.update (50 units)
export async function setPublic(token, videoId, currentStatus, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${API}/videos?part=status`, {
    method: 'PUT',
    headers: { ...auth(token), 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ id: videoId, status: buildPublicStatus(currentStatus) }),
  });
  if (!res.ok) throw await apiErrorFromResponse(res, 'videos.update');
  return res.json();
}
