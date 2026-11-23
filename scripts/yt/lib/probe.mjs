import { spawnSync } from 'node:child_process';

// ffprobe가 없으면 null. GitHub ubuntu 러너에는 기본 설치되어 있다.
export function probeVideo(file) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file,
  ], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  try {
    const json = JSON.parse(r.stdout);
    const stream = json.streams?.[0] ?? {};
    return { width: Number(stream.width), height: Number(stream.height), duration: Number(json.format?.duration) };
  } catch {
    return null;
  }
}

export const SHORTS_MAX_SECONDS = 180;

export function classifyVideo(info) {
  if (!info || !info.width || !info.height || !Number.isFinite(info.duration)) return { kind: '미측정', warnings: [] };
  const warnings = [];
  if (info.width !== 1080 || info.height !== 1920) warnings.push(`해상도 ${info.width}x${info.height} (권장 1080x1920)`);
  const isShorts = info.height > info.width && info.duration <= SHORTS_MAX_SECONDS;
  return { kind: `${isShorts ? '쇼츠' : '일반'} (${Math.round(info.duration)}초)`, warnings };
}
