export const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const SCOPES = Object.freeze({
  youtube: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube'],
  drive: ['https://www.googleapis.com/auth/drive.readonly'],
});

export class ApiError extends Error {
  constructor(message, { status, reason } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.reason = reason;
  }
}

export class QuotaExceededError extends ApiError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'QuotaExceededError';
  }
}

const QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded']);

export function isQuotaReason(reason) {
  return QUOTA_REASONS.has(reason);
}

export async function apiErrorFromResponse(res, label) {
  let reason;
  let detail = '';
  try {
    const body = await res.json();
    const e = body.error;
    if (typeof e === 'string') {
      reason = e;
    } else if (e) {
      reason = e.errors?.[0]?.reason ?? e.status;
      // 로그 데이터 정책: 공개 Actions 로그에는 Google API error.message 앞 200자만 남긴다. 토큰·이메일 등 개인정보·요청 본문은 기록하지 않는다.
      detail = e.message ? `: ${String(e.message).slice(0, 200)}` : '';
    }
  } catch {
    // 응답 본문이 JSON이 아니면 상태 코드만 사용
  }
  const message = `${label} 실패 (HTTP ${res.status}${reason ? `, ${reason}` : ''})${detail}`;
  if (res.status === 403 && isQuotaReason(reason)) return new QuotaExceededError(message, { status: res.status, reason });
  return new ApiError(message, { status: res.status, reason });
}

export function maskSecret(value, env = process.env) {
  if (value && env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${value}`);
}

export function requireEnv(name, env = process.env) {
  const v = env[name];
  if (!v || !v.trim()) throw new Error(`환경변수 ${name}가 설정되지 않음`);
  return v.trim();
}

export async function exchangeToken(params, { fetchImpl = fetch, env = process.env } = {}) {
  const body = new URLSearchParams({
    client_id: requireEnv('YT_CLIENT_ID', env),
    client_secret: requireEnv('YT_CLIENT_SECRET', env),
    ...params,
  });
  const res = await fetchImpl(TOKEN_URL, { method: 'POST', body });
  if (!res.ok) throw await apiErrorFromResponse(res, `OAuth 토큰 발급(${params.grant_type})`);
  return res.json();
}

export async function getAccessToken(refreshToken, opts = {}) {
  const json = await exchangeToken({ grant_type: 'refresh_token', refresh_token: refreshToken }, opts);
  maskSecret(json.access_token, opts.env);
  return json.access_token;
}
