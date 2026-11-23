import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { apiErrorFromResponse } from './google.mjs';

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const FIELDS = 'id,name,size,mimeType';

function escapeQuery(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export async function resolveDriveFile(accessToken, source, { folderId, fetchImpl = fetch } = {}) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  if (source.drive_file_id) {
    const url = `${DRIVE_API}/${encodeURIComponent(source.drive_file_id)}?fields=${FIELDS}&supportsAllDrives=true`;
    const res = await fetchImpl(url, { headers });
    if (!res.ok) throw await apiErrorFromResponse(res, '드라이브 files.get');
    return res.json();
  }
  if (!folderId) throw new Error('drive_file_name을 쓰려면 DRIVE_VIDEO_FOLDER_ID 변수가 필요함');
  const q = `'${escapeQuery(folderId)}' in parents and name = '${escapeQuery(source.drive_file_name)}' and trashed = false`;
  const params = new URLSearchParams({
    q, fields: `files(${FIELDS})`, supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', pageSize: '10',
  });
  const res = await fetchImpl(`${DRIVE_API}?${params}`, { headers });
  if (!res.ok) throw await apiErrorFromResponse(res, '드라이브 files.list');
  const { files = [] } = await res.json();
  if (files.length !== 1) {
    throw new Error(`'영상' 폴더에서 ${source.drive_file_name} 파일을 ${files.length === 0 ? '찾지 못함' : `${files.length}개 찾음 (중복)`}`);
  }
  return files[0];
}

export async function downloadDriveFile(accessToken, fileId, destPath, { fetchImpl = fetch } = {}) {
  const url = `${DRIVE_API}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw await apiErrorFromResponse(res, '드라이브 다운로드');
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
  return fs.statSync(destPath).size;
}
