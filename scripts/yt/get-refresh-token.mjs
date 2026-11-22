#!/usr/bin/env node
// 로컬에서 1회 실행해 리프레시 토큰을 발급한다.
//   YT_CLIENT_ID=... YT_CLIENT_SECRET=... node scripts/yt/get-refresh-token.mjs --scope youtube
//   --scope youtube : 채널 토큰 (youtube.upload + youtube). 동의 화면에서 대상 브랜드 채널을 선택
//   --scope drive   : 드라이브 다운로드 토큰 (drive.readonly). Drive 소유 계정(A)으로 동의
//   --out <경로>    : 토큰 파일 경로 (기본 ~/.yt-tokens/<scope>-<시각>.token)
// 토큰은 화면에 출력하지 않고 소유자만 읽을 수 있는 파일(0600, 디렉터리 0700)에 쓴다.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SCOPES, exchangeToken, requireEnv } from './lib/google.mjs';
import { CHANNELS } from './lib/channels.mjs';

function parseScope(argv) {
  const i = argv.indexOf('--scope');
  const scope = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith('--scope='))?.split('=')[1];
  if (!SCOPES[scope]) {
    console.error('사용법: node scripts/yt/get-refresh-token.mjs --scope youtube|drive');
    process.exit(2);
  }
  return scope;
}

function parseOut(argv, scope) {
  const i = argv.indexOf('--out');
  const out = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith('--out='))?.split('=')[1];
  if (out) return path.resolve(out);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(os.homedir(), '.yt-tokens', `${scope}-${stamp}.token`);
}

// 소유자 전용 권한으로 새 파일에만 쓴다 (기존 파일 덮어쓰기 금지)
export function writeSecretFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, value, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(file, 0o600);
}

async function main() {
  const argv = process.argv.slice(2);
  const scope = parseScope(argv);
  const outFile = parseOut(argv, scope);
  if (fs.existsSync(outFile)) throw new Error(`이미 존재하는 파일: ${outFile}`);
  const clientId = requireEnv('YT_CLIENT_ID');
  requireEnv('YT_CLIENT_SECRET');
  const state = crypto.randomBytes(16).toString('hex');

  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const redirectUri = `http://127.0.0.1:${server.address().port}`;

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES[scope].join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  }).toString();

  console.log('브라우저에서 아래 URL을 열어 동의하세요:\n');
  console.log(authUrl.toString());
  console.log('');

  const code = await new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url, redirectUri);
      if (url.pathname !== '/') { res.writeHead(404).end(); return; }
      const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(ok ? '동의 완료. 터미널로 돌아가세요.' : '동의 실패. 터미널 메시지를 확인하세요.');
      if (ok) resolve(url.searchParams.get('code'));
      else reject(new Error(`동의 실패: ${url.searchParams.get('error') ?? 'state 불일치'}`));
    });
  }).finally(() => server.close());

  const tokens = await exchangeToken({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  if (!tokens.refresh_token) throw new Error('refresh_token이 응답에 없음. 계정 권한을 철회한 뒤 다시 시도하세요.');

  writeSecretFile(outFile, tokens.refresh_token);
  const names = scope === 'drive'
    ? ['DRIVE_REFRESH_TOKEN']
    : Object.values(CHANNELS).map((c) => `${c.tokenEnv}  # ${c.name}`);
  console.log(`리프레시 토큰을 파일에 저장함 (권한 0600, 화면 출력 없음): ${outFile}`);
  console.log('\nGitHub Actions secret으로 등록한 뒤 파일을 삭제하세요. 등록할 secret 이름:');
  for (const n of names) console.log(`  ${n}`);
  console.log(`\n예: gh secret set <SECRET_NAME> < "${outFile}" && rm "${outFile}"`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
