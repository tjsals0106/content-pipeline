import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { CHANNEL_KEYS } from './channels.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function videosDir(env = process.env) {
  return env.VIDEOS_DIR ? path.resolve(env.VIDEOS_DIR) : path.join(REPO_ROOT, 'videos');
}

const FILE_NAME_RE = /^[a-z0-9][a-z0-9-]*\.yml$/;
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const WEEK_RE = /^(\d{4})-W(\d{2})$/;
const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const ALLOWED_KEYS = new Set([
  'channel', 'title', 'description', 'tags', 'category_id', 'default_language',
  'made_for_kids', 'source', 'publish_week', 'youtube_id', 'uploaded_at', 'published_at',
]);
const SOURCE_KEYS = new Set(['type', 'drive_file_id', 'drive_file_name']);

export const DEFAULTS = Object.freeze({ description: '', tags: [], category_id: '22', default_language: 'ko' });

export function isManifestFileName(name) {
  return !name.startsWith('_') && name.endsWith('.yml');
}

export function listManifestFiles(dir = videosDir()) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(isManifestFileName)
    .sort()
    .map((name) => path.join(dir, name));
}

export function loadManifest(file) {
  const text = fs.readFileSync(file, 'utf8');
  const doc = YAML.parseDocument(text);
  const errors = doc.errors.map((e) => `YAML 파싱 오류: ${e.message.split('\n')[0]}`);
  const data = errors.length ? null : doc.toJS();
  return { file, name: path.basename(file), slug: path.basename(file, '.yml'), doc, data, parseErrors: errors };
}

export function withDefaults(data) {
  return { ...DEFAULTS, ...data };
}

function isBlank(v) {
  return v === null || v === undefined;
}

function isValidIso(v) {
  return typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));
}

export function isoWeeksInYear(year) {
  const p = (y) => (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400)) % 7;
  return p(year) === 4 || p(year - 1) === 3 ? 53 : 52;
}

export function tagsLength(tags) {
  return tags.reduce((sum, t) => sum + t.length + (/\s/.test(t) ? 2 : 0), 0) + Math.max(tags.length - 1, 0);
}

export function validateManifestData(data, name = '') {
  const errors = [];
  const err = (field, msg) => errors.push({ field, message: msg });

  if (name && !FILE_NAME_RE.test(name)) err('(파일명)', '소문자·숫자·하이픈으로 된 <slug>.yml 이어야 함');
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    err('(문서)', 'YAML 매핑(키: 값)이어야 함');
    return errors;
  }

  for (const key of Object.keys(data)) {
    if (!ALLOWED_KEYS.has(key)) err(key, '정의되지 않은 키');
  }

  if (!CHANNEL_KEYS.includes(data.channel)) err('channel', `필수, ${CHANNEL_KEYS.join(' | ')} 중 하나`);

  if (typeof data.title !== 'string' || data.title.trim().length === 0) err('title', '필수 문자열');
  else {
    if ([...data.title].length > 100) err('title', '100자 이하');
    if (/[<>]/.test(data.title)) err('title', '< > 사용 불가');
  }

  if (!isBlank(data.description)) {
    if (typeof data.description !== 'string') err('description', '문자열이어야 함');
    else {
      if (Buffer.byteLength(data.description, 'utf8') > 5000) err('description', 'UTF-8 5000바이트 이하');
      if (/[<>]/.test(data.description)) err('description', '< > 사용 불가');
    }
  }

  if (!isBlank(data.tags)) {
    if (!Array.isArray(data.tags) || data.tags.some((t) => typeof t !== 'string' || t.trim() === '')) {
      err('tags', '빈 값 없는 문자열 배열이어야 함');
    } else {
      if (data.tags.some((t) => /[<>]/.test(t))) err('tags', '< > 사용 불가');
      if (tagsLength(data.tags) > 500) err('tags', '합계 500자 이하');
    }
  }

  if (!isBlank(data.category_id) && !(typeof data.category_id === 'string' && /^\d+$/.test(data.category_id))) {
    err('category_id', '숫자 문자열이어야 함 (예: "22")');
  }

  if (!isBlank(data.default_language) && !(typeof data.default_language === 'string' && LANG_RE.test(data.default_language))) {
    err('default_language', 'BCP-47 언어 코드여야 함 (예: ko)');
  }

  if (typeof data.made_for_kids !== 'boolean') err('made_for_kids', '필수 boolean');

  const src = data.source;
  if (src === null || typeof src !== 'object' || Array.isArray(src)) err('source', '필수 매핑');
  else {
    for (const key of Object.keys(src)) if (!SOURCE_KEYS.has(key)) err(`source.${key}`, '정의되지 않은 키');
    if (src.type !== 'drive') err('source.type', 'drive 여야 함');
    const hasId = !isBlank(src.drive_file_id);
    const hasName = !isBlank(src.drive_file_name);
    if (hasId === hasName) err('source', 'drive_file_id 또는 drive_file_name 중 정확히 하나');
    if (hasId && !(typeof src.drive_file_id === 'string' && /^[A-Za-z0-9_-]{10,}$/.test(src.drive_file_id))) {
      err('source.drive_file_id', '드라이브 파일 ID 형식이 아님');
    }
    if (hasName && !(typeof src.drive_file_name === 'string' && /\.mp4$/i.test(src.drive_file_name) && !/[\\/]/.test(src.drive_file_name))) {
      err('source.drive_file_name', '경로 없는 .mp4 파일명이어야 함');
    }
  }

  if (!isBlank(data.publish_week)) {
    const m = typeof data.publish_week === 'string' && WEEK_RE.exec(data.publish_week);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > isoWeeksInYear(Number(m[1]))) err('publish_week', 'YYYY-Www 형식이어야 함 (예: 2026-W48)');
  }

  if (!isBlank(data.youtube_id) && !(typeof data.youtube_id === 'string' && YOUTUBE_ID_RE.test(data.youtube_id))) {
    err('youtube_id', 'null 또는 11자 영상 ID');
  }
  for (const f of ['uploaded_at', 'published_at']) {
    if (!isBlank(data[f]) && !isValidIso(data[f])) err(f, 'null 또는 ISO 8601 문자열 (따옴표로 감쌀 것)');
  }
  if (isBlank(data.youtube_id) !== isBlank(data.uploaded_at)) err('uploaded_at', 'youtube_id와 함께 있거나 함께 없어야 함');
  if (!isBlank(data.published_at) && isBlank(data.youtube_id)) err('published_at', 'youtube_id 없이 기록될 수 없음');

  return errors;
}

export function validateManifests(manifests) {
  const result = new Map();
  const seen = { youtube_id: new Map(), drive_file_id: new Map(), drive_file_name: new Map() };

  for (const m of manifests) {
    const errors = m.parseErrors.length
      ? m.parseErrors.map((message) => ({ field: '(YAML)', message }))
      : validateManifestData(m.data, m.name);
    result.set(m.name, errors);
    if (!m.data || typeof m.data !== 'object') continue;
    const keys = {
      youtube_id: m.data.youtube_id,
      drive_file_id: m.data.source?.drive_file_id,
      drive_file_name: m.data.source?.drive_file_name,
    };
    for (const [field, value] of Object.entries(keys)) {
      if (isBlank(value)) continue;
      const other = seen[field].get(value);
      if (other) {
        errors.push({ field, message: `${other}와 중복` });
        result.get(other).push({ field, message: `${m.name}와 중복` });
      } else seen[field].set(value, m.name);
    }
  }
  return result;
}

export function writeManifestFields(manifest, fields) {
  for (const [key, value] of Object.entries(fields)) manifest.doc.set(key, value);
  fs.writeFileSync(manifest.file, manifest.doc.toString({ lineWidth: 0 }));
  manifest.data = manifest.doc.toJS();
}
