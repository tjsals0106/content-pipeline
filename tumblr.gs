/**
 * tumblr.gs v1 - Tumblr 자동 발행 (OAuth 2.0 + NPF)
 * 콘텐츠 파이프라인 v0.4의 code.gs, publish.gs와 함께 동작한다.
 *
 * 구조: publish_(channel, title, body)이 tumblr 채널을 만나면
 *       Tumblr API v2로 글을 올린다. 기본 상태는 draft(초안).
 *
 * 필수 스크립트 속성(프로젝트 설정 -> 스크립트 속성):
 *   TUMBLR_CLIENT_ID      - tumblr.com/oauth/apps 의 OAuth Consumer Key
 *   TUMBLR_CLIENT_SECRET  - 위와 같음 (Secret)
 * 자동 저장되는 속성:
 *   TUMBLR_ACCESS_TOKEN, TUMBLR_REFRESH_TOKEN, TUMBLR_TOKEN_EXPIRES_AT
 *   (코드/깃허브에 올리지 않는다)
 */

const TUMBLR_CONFIG = {
  BLOG: 'seonminlaura.tumblr.com',  // 404가 나면 'seonminlaura'로 바꿔본다
  STATUS: 'published',                  // 품질 검수 전까지 draft. 검수 후 'published'
  CHANNELS: ['tumblr'],             // 자동 발행 대상 채널
  TAGS: [],                         // 모든 글에 기본으로 붙일 태그. 예: ['seonmin laura']
};

const TUMBLR_AUTH_URL = 'https://www.tumblr.com/oauth2/authorize';
const TUMBLR_TOKEN_URL = 'https://api.tumblr.com/v2/oauth2/token';
const TUMBLR_API_BASE = 'https://api.tumblr.com/v2/blog/' + TUMBLR_CONFIG.BLOG;

// ---------- 인증 (최초 1회) ----------

// 실행하면 로그에 인증 URL이 찍힌다. tumblr.com에 로그인된 브라우저에서 열고 승인하면
// usercallback으로 리다이렉트하고, doGet이 토큰을 받아 저장한다.
function tumblrAuthorize() {
  const clientId = PropertiesService.getScriptProperties().getProperty('TUMBLR_CLIENT_ID');
  if (!clientId) throw new Error('스크립트 속성에 TUMBLR_CLIENT_ID가 없음');
  const url = TUMBLR_AUTH_URL
    + '?client_id=' + encodeURIComponent(clientId)
    + '&redirect_uri=' + encodeURIComponent(tumblrRedirectUri_())
    + '&response_type=code'
    + '&scope=' + encodeURIComponent('basic write offline_access')
    + '&state=tumblr';
  Logger.log('아래 URL을 브라우저에서 열어 승인하세요 (tumblr.com 로그인 상태여야 함):\n\n' + url);
  return url;
}

function tumblrRedirectUri_() {
  // /usercallback은 구글 예약 경로라 커스텀 OAuth 콜백을 못 받는다. /exec를 쓴다.
  // WordPress와 같은 주소를 쓰므로, 속성 TUMBLR_REDIRECT_URI가 있으면 그걸 우선한다.
  const custom = PropertiesService.getScriptProperties().getProperty('TUMBLR_REDIRECT_URI');
  if (custom) return custom;
  return 'https://script.google.com/macros/d/' + ScriptApp.getScriptId() + '/exec';
}


// ---------- 공통 콜백 ----------
// publish.gs에 있던 기존 doGet은 삭제한다(충돌 방지).
// Tumblr 인증 요청에는 state=tumblr을 붙였고, Tumblr가 이를 그대로 돌려주므로
// 그 값으로 WordPress 콜백과 Tumblr 콜백을 구분한다.
function doGet(e) {
  const params = (e && e.parameter) || {};
  if (params.state === 'tumblr') return tumblrCallback_(params.code);
  return wpCallback_(params.code);
}

// WordPress 콜백 (기존 publish.gs의 doGet과 내용 동일)
function wpCallback_(code) {
  if (!code) {
    return HtmlService.createHtmlOutput(
      '잘못된 접근입니다. wpAuthorize_를 실행하고 로그에 찍힌 URL을 여세요.');
  }
  const props = PropertiesService.getScriptProperties();
  const res = UrlFetchApp.fetch(WP_TOKEN_URL, {
    method: 'post',
    payload: {
      client_id: props.getProperty('WP_CLIENT_ID'),
      client_secret: props.getProperty('WP_CLIENT_SECRET'),
      redirect_uri: wpRedirectUri_(),
      code: code,
      grant_type: 'authorization_code',
    },
    muteHttpExceptions: true,
  });
  let data = {};
  try { data = JSON.parse(res.getContentText()); } catch (err) {}
  if (res.getResponseCode() !== 200 || !data.access_token) {
    log_('ERROR', '-', 'wordpress', 'WordPress 인증 실패: ' + res.getContentText().slice(0, 300));
    return HtmlService.createHtmlOutput(
      '인증 실패: ' + (data.error_description || data.error || res.getContentText().slice(0, 300)));
  }
  props.setProperty('WP_ACCESS_TOKEN', data.access_token);
  log_('INFO', '-', 'wordpress', 'WordPress 인증 완료. WP_ACCESS_TOKEN 저장됨 (scope: ' + (data.scope || '-') + ')');
  return HtmlService.createHtmlOutput(
    '인증 완료! 이 창은 닫아도 됩니다. 앱스 스크립트로 돌아가 wpTestDraft를 실행하세요.');
}

// Tumblr 콜백
function tumblrCallback_(code) {
  if (!code) {
    return HtmlService.createHtmlOutput(
      '잘못된 접근입니다. tumblrAuthorize를 실행하고 로그에 찍힌 URL을 여세요.');
  }
  const props = PropertiesService.getScriptProperties();
  const res = UrlFetchApp.fetch(TUMBLR_TOKEN_URL, {
    method: 'post',
    payload: {
      client_id: props.getProperty('TUMBLR_CLIENT_ID'),
      client_secret: props.getProperty('TUMBLR_CLIENT_SECRET'),
      redirect_uri: tumblrRedirectUri_(),
      code: code,
      grant_type: 'authorization_code',
    },
    muteHttpExceptions: true,
  });
  let data = {};
  try { data = JSON.parse(res.getContentText()); } catch (err) {}
  if (res.getResponseCode() !== 200 || !data.access_token) {
    log_('ERROR', '-', 'tumblr', 'Tumblr 인증 실패: ' + res.getContentText().slice(0, 300));
    return HtmlService.createHtmlOutput(
      '인증 실패: ' + (data.error_description || data.error || res.getContentText().slice(0, 300)));
  }
  tumblrSaveTokens_(data);
  log_('INFO', '-', 'tumblr', 'Tumblr 인증 완료. 토큰 저장됨 (scope: ' + (data.scope || '-') + ')');
  return HtmlService.createHtmlOutput(
    '인증 완료! 이 창은 닫아도 됩니다. 앱스 스크립트로 돌아가 tumblrTestDraft를 실행하세요.');
}

function tumblrSaveTokens_(data) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('TUMBLR_ACCESS_TOKEN', data.access_token);
  if (data.refresh_token) props.setProperty('TUMBLR_REFRESH_TOKEN', data.refresh_token);
  if (data.expires_in) {
    // 만료 5분 전부터 갱신하도록 여유를 둔다
    props.setProperty('TUMBLR_TOKEN_EXPIRES_AT',
      String(Date.now() + (Number(data.expires_in) - 300) * 1000));
  }
}

// 리프레시 토큰으로 액세스 토큰을 갱신한다.
function tumblrRefresh_() {
  const props = PropertiesService.getScriptProperties();
  const refresh = props.getProperty('TUMBLR_REFRESH_TOKEN');
  if (!refresh) throw new Error('TUMBLR_REFRESH_TOKEN 없음. tumblrAuthorize를 다시 실행하세요.');
  const res = UrlFetchApp.fetch(TUMBLR_TOKEN_URL, {
    method: 'post',
    payload: {
      client_id: props.getProperty('TUMBLR_CLIENT_ID'),
      client_secret: props.getProperty('TUMBLR_CLIENT_SECRET'),
      refresh_token: refresh,
      grant_type: 'refresh_token',
    },
    muteHttpExceptions: true,
  });
  let data = {};
  try { data = JSON.parse(res.getContentText()); } catch (err) {}
  if (res.getResponseCode() !== 200 || !data.access_token) {
    throw new Error('Tumblr 토큰 갱신 실패: ' + res.getContentText().slice(0, 200));
  }
  tumblrSaveTokens_(data);
  return data.access_token;
}

// 유효한 액세스 토큰을 반환한다. 만료 임박이면 미리 갱신한다.
function tumblrGetToken_() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('TUMBLR_ACCESS_TOKEN');
  if (!token) throw new Error('TUMBLR_ACCESS_TOKEN 없음. tumblrAuthorize를 실행해 인증하세요.');
  const expiresAt = Number(props.getProperty('TUMBLR_TOKEN_EXPIRES_AT') || 0);
  if (expiresAt && Date.now() > expiresAt) return tumblrRefresh_();
  return token;
}

// ---------- 발행 ----------

// publish_에서 tumblr 채널일 때 호출된다.
function tumblrPublish_(title, body) {
  let token = tumblrGetToken_();
  let res = tumblrPost_(token, title, body);
  if (res.getResponseCode() === 401) {
    // 토큰이 만료돼 있었으면 갱신 후 1회 재시도
    token = tumblrRefresh_();
    res = tumblrPost_(token, title, body);
  }
  let data = {};
  try { data = JSON.parse(res.getContentText()); } catch (err) {}
  if (res.getResponseCode() >= 400) {
    throw new Error('Tumblr API ' + res.getResponseCode() + ': '
      + ((data.meta && data.meta.msg) || res.getContentText().slice(0, 200)));
  }
  return (data && data.response) || data; // response.id, response.state 등
}

function tumblrPost_(token, title, body) {
  const payload = {
    content: toNpfContent_(title, body),
    state: TUMBLR_CONFIG.STATUS,
  };
  if (TUMBLR_CONFIG.TAGS.length) payload.tags = TUMBLR_CONFIG.TAGS;
  return UrlFetchApp.fetch(TUMBLR_API_BASE + '/posts', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
}

// 제목 + 본문 텍스트를 NPF 콘텐츠 블록 배열로 바꾼다.
// 첫 블록은 heading1(제목), 이후는 빈 줄 기준으로 문단별 text 블록.
function toNpfContent_(title, body) {
  const content = [];
  if (title) content.push({ type: 'text', text: String(title), subtype: 'heading1' });
  String(body).split(/\n\s*\n/).forEach(function (p) {
    const t = p.trim();
    if (t) content.push({ type: 'text', text: t });
  });
  if (!content.length) content.push({ type: 'text', text: '(빈 글)' });
  return content;
}

// ---------- 테스트 / 보조 ----------

// 발행 동작 점검용: 테스트 글 하나를 Tumblr에 초안으로 올린다.
function tumblrTestDraft() {
  const r = tumblrPublish_(
    '파이프라인 발행 테스트',
    '이 글은 Tumblr 자동 발행 테스트입니다.\n\n이 문단이 Tumblr에서 문단으로 나뉘어 보이면 NPF 변환도 정상이에요.\n\n이 글은 초안 상태라 독자에게는 보이지 않습니다.');
  Logger.log('업로드 성공: id ' + (r.id || '-') + ', 상태: ' + (r.state || '-'));
  log_('SUCCESS', 'tumblrTestDraft', 'tumblr', 'Tumblr 초안 업로드 성공: id ' + (r.id || '-'), '파이프라인 발행 테스트');
}

// Tumblr 초안을 발행(published)으로 전환한다. postId는 tumblrTestDraft 로그의 id 또는
// Tumblr 대시보드의 게시물 관리에서 확인할 수 있다.
function tumblrPublishById(postId) {
  let token = tumblrGetToken_();

  // 1단계: 기존 글의 NPF 내용을 가져온다
  let getRes = tumblrFetchPost_(token, postId);
  if (getRes.getResponseCode() === 401) {
    token = tumblrRefresh_();
    getRes = tumblrFetchPost_(token, postId);
  }
  if (getRes.getResponseCode() >= 400) {
    log_('ERROR', 'tumblrPublishById', 'tumblr',
      '공개 전환 실패(내용 조회 단계): Tumblr API ' + getRes.getResponseCode() + ' ' + getRes.getContentText().slice(0, 200));
    throw new Error('Tumblr API ' + getRes.getResponseCode() + ' (조회): ' + getRes.getContentText().slice(0, 200));
  }
  const post = ((JSON.parse(getRes.getContentText()) || {}).response) || {};
  if (!post.content) {
    throw new Error('글 내용(content)을 가져오지 못했다: ' + JSON.stringify(post).slice(0, 200));
  }

  // 2단계: 내용은 그대로 실고 state만 published로 바꿔 수정한다
  const payload = { content: post.content, state: 'published' };
  if (post.layout && post.layout.length) payload.layout = post.layout;
  if (post.tags && post.tags.length) payload.tags = post.tags.join(',');

  let res = tumblrEdit_(token, postId, payload);
  if (res.getResponseCode() === 401) {
    token = tumblrRefresh_();
    res = tumblrEdit_(token, postId, payload);
  }
  let data = {};
  try { data = JSON.parse(res.getContentText()); } catch (err) {}
  if (res.getResponseCode() >= 400) {
    log_('ERROR', 'tumblrPublishById', 'tumblr',
      '공개 전환 실패(수정 단계): Tumblr API ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
    throw new Error('Tumblr API ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  }
  const r = (data && data.response) || data;
  log_('SUCCESS', 'tumblrPublishById', 'tumblr',
    '공개 전환 완료: id ' + (r.id || postId) + ', 상태: ' + (r.state || 'published'));
  Logger.log('발행 완료');
  return r;
}

// NPF 수정은 content를 다시 보내야 하므로 먼저 현재 내용을 조회한다.
function tumblrFetchPost_(token, postId) {
  return UrlFetchApp.fetch(TUMBLR_API_BASE + '/posts/' + postId + '?post_format=npf', {
    method: 'get',
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true,
  });
}

// NPF 게시물 수정: PUT + 글 전체 content 재전송. (state만 보내면 400이 난다)
function tumblrEdit_(token, postId, payload) {
  return UrlFetchApp.fetch(TUMBLR_API_BASE + '/posts/' + postId, {
    method: 'put',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
}

// 테스트용: 테스트 초안(id 833850061230424064)을 공개로 전환한다.
// 그 초안을 이미 지웠다면 먼저 tumblrTestDraft를 실행하고, 로그에 찍힌 새 id를 아래에 넣어 다시 실행한다.
function tumblrTestPublish() {
  tumblrPublishById('833850061230424064');
}
