import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiErrorFromResponse, QuotaExceededError, ApiError, getAccessToken } from '../lib/google.mjs';
import { channelRefreshToken, expectedChannelId } from '../lib/channels.mjs';

const jsonRes = (status, body) => new Response(JSON.stringify(body), { status });

test('quotaExceeded 403은 QuotaExceededError', async () => {
  const e = await apiErrorFromResponse(jsonRes(403, { error: { errors: [{ reason: 'quotaExceeded' }], message: 'x' } }), 'videos.insert');
  assert.ok(e instanceof QuotaExceededError);
  assert.equal(e.reason, 'quotaExceeded');
});

test('다른 403은 일반 ApiError', async () => {
  const e = await apiErrorFromResponse(jsonRes(403, { error: { errors: [{ reason: 'forbidden' }] } }), 'videos.update');
  assert.ok(e instanceof ApiError);
  assert.ok(!(e instanceof QuotaExceededError));
});

test('OAuth invalid_grant 식별', async () => {
  const e = await apiErrorFromResponse(jsonRes(400, { error: 'invalid_grant' }), 'OAuth');
  assert.equal(e.reason, 'invalid_grant');
});

test('getAccessToken은 리프레시 토큰으로 발급하고 Actions에서 마스킹', async () => {
  const logs = [];
  const orig = console.log;
  console.log = (m) => logs.push(m);
  try {
    const token = await getAccessToken('rt', {
      env: { YT_CLIENT_ID: 'id', YT_CLIENT_SECRET: 'secret', GITHUB_ACTIONS: 'true' },
      fetchImpl: async (url, init) => {
        assert.equal(init.body.get('grant_type'), 'refresh_token');
        assert.equal(init.body.get('refresh_token'), 'rt');
        return jsonRes(200, { access_token: 'at' });
      },
    });
    assert.equal(token, 'at');
  } finally {
    console.log = orig;
  }
  assert.deepEqual(logs, ['::add-mask::at']);
});

test('채널 토큰이 비어 있으면 null', () => {
  assert.equal(channelRefreshToken('meliv_music', { YT_MELIV_REFRESH_TOKEN: '  ' }), null);
  assert.equal(channelRefreshToken('seonmin_mov', { YT_SEONMINMOV_REFRESH_TOKEN: 'x' }), 'x');
  assert.equal(expectedChannelId('viriditas_worship', {}), null);
});
