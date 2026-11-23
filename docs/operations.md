# 유튜브 영상 파이프라인 운영 매뉴얼

설계와 세부 규칙은 [`youtube-pipeline.md`](youtube-pipeline.md)에 있다. 이 문서는 운영하는 사람이 할 일만 순서대로 적는다. 시크릿 값은 어디에도 붙여넣거나 출력하지 않는다(GitHub Actions secrets에만 둔다).

## 1. 새 영상 올리기

1. **영상 파일 준비**
   - 렌더링이 끝난 완성본만 올린다. 세로형 1080x1920 MP4, 1편 30~80MB 권장(512MB 초과·0바이트는 실패, 범위 밖 크기와 비세로형은 경고만).
   - 드라이브 '영상' 폴더(Drive 소유 계정 A의 폴더, 채널 운영 계정 B에도 공유)에 올린다. 같은 파일명을 두 번 쓰지 않는다.
   - 영상 파일은 레포에 커밋하지 않는다.
2. **매니페스트 작성**: `videos/<slug>.yml`을 만든다. 파일명은 소문자·숫자·하이픈(`2026-11-27-morning-routine.yml`), `_`로 시작하면 무시된다. 필드는 [`videos/README.md`](../videos/README.md), 예시는 [`videos/_example.yml`](../videos/_example.yml).
   ```yaml
   channel: seonmin_mov            # seonmin_mov | meliv_music | viriditas_worship
   title: "영상 제목"                # 1~100자, < > 금지
   description: |
     설명
   made_for_kids: false            # 필수 boolean. false는 운영 정책(세 채널 모두 아동용 아님)
   source:
     type: drive
     drive_file_name: "2026-11-27-morning-routine.mp4"   # 또는 drive_file_id (둘 중 하나)
   publish_week: "2026-W48"        # 선택. 없으면 업로드 후 첫 금요일에 공개
   youtube_id: null
   uploaded_at: null
   published_at: null
   ```
   - `made_for_kids`: 검증기는 값이 boolean(`true`/`false`)인지만 검사한다. 세 채널은 아동용 콘텐츠가 아니므로 항상 `false`로 적는 것이 운영 정책이며, 검증기가 `false`를 강제하지는 않는다.
   - `youtube_id`, `uploaded_at`, `published_at`은 워크플로가 채운다. 직접 고치지 않는다(예외는 4장의 수동 복구).
   - 로컬 확인(선택): `npm ci --prefix scripts/yt && node scripts/yt/validate.mjs`
3. **main에 반영**: 매니페스트를 main에 push하거나 PR로 머지한다. `videos/**.yml`이 바뀐 main push가 `yt-upload`를 바로 실행한다. PR 단계에서는 `yt-validate`가 검증만 한다.
4. **업로드 확인**
   - Actions 탭 → `yt-upload` 실행의 Step Summary 표에서 해당 매니페스트가 `업로드 (unlisted)`인지 본다.
   - 잠시 뒤 main에 `github-actions[bot]`의 `videos: 업로드 결과 기록 (youtube_id, uploaded_at)` 커밋이 생기고, 매니페스트에 `youtube_id`가 채워진다.
   - 영상은 일부 공개(unlisted)로 올라간다. 공개 전환은 금요일 21:17 KST 공개 잡이 한다(3장, 5장).
5. 결과가 `이월`이면 일 상한 또는 쿼터 때문이다. 다음 날 17:23 KST 업로드 cron이 자동으로 다시 시도한다(4장).

## 2. 워크플로와 실행 시각

| 워크플로 | 언제 | 하는 일 |
| --- | --- | --- |
| `yt-upload` | main의 `videos/**.yml` push, 매일 17:23 KST(`23 8 * * *` UTC), 수동 실행 | `youtube_id` 없는 매니페스트를 unlisted 업로드하고 기록 |
| `yt-publish` | 매주 금 21:17 KST(`17 12 * * 5` UTC), 수동 실행 | 공개 주차가 된 unlisted 영상을 public 전환하고 `published_at` 기록 |
| `yt-keepalive` | 매월 1일 12:41 KST(`41 3 1 * *` UTC), 수동 실행 | 예약 워크플로의 60일 무활동 잠금 방지 |
| `yt-failure-issue` | 위 세 워크플로가 실패할 때 호출 | `[yt] <워크플로> 실패` 이슈 생성 또는 댓글 |
| `yt-validate` | `videos/`, `scripts/yt/`, 워크플로 변경 PR과 main push | 매니페스트 검증과 단위 테스트 |

## 3. 실패·경고 확인

1. **자동 실패 이슈**: 업로드·공개·keepalive 잡이 실패하면 Issues에 `[yt] yt-upload 실패`처럼 열린다. 같은 이슈가 열려 있으면 새 실행 링크가 댓글로 붙는다. 본문의 실행 링크로 들어가 원인을 확인하고, 해결한 뒤 이슈를 닫는다.
2. **Actions 실행 로그와 Step Summary**: 실행 화면 아래 Step Summary 표에서 매니페스트별 결과를 본다.

   | 결과 | 뜻 | 할 일 |
   | --- | --- | --- |
   | `업로드 (unlisted)` / `public 전환` / `이미 public (기록만)` | 정상 | 없음 |
   | `업로드 예정 (dry_run)` / `공개 예정 (dry_run)` | dry_run 실행이라 실제 호출 없음 | 실제 실행이 필요하면 5장 |
   | `보류` | 공개 잡이 공개하지 않고 넘김(사유는 비고 열) | 비고 확인 |
   | `스킵` | 채널 토큰 secret 없음 등 | 의도한 것이 아니면 토큰 등록 |
   | `이월` | 일 10편 상한·쿼터 초과·배치 상한 | 대기(다음 실행이 처리) |
   | `확인 필요` | 채널에 같은 제목 영상이 이미 있어 업로드 보류 | 같은 영상이면 그 `youtube_id`·`uploaded_at`을 직접 기록, 아니면 제목 변경 |
   | `실패` | 다운로드·API·검증 오류 | 로그의 오류 메시지 확인 후 수정, 재실행 |

   로그의 `::warning::`은 잡을 실패시키지 않는 경고다(파일 크기, 해상도, 결과 파일 쓰기 실패, 로그 시트 전송 실패 등).
3. **매니페스트 기록 실패**: 기록 단계(`push-manifests.sh`)는 기본 총 3회 push를 시도하고(최초 시도 포함, `PUSH_ATTEMPTS`), 매 시도 전에 `pull --rebase`로 main을 다시 받는다. 모든 시도가 거부되거나 rebase가 충돌하면 `::error::매니페스트 기록 …`과 Step Summary의 **매니페스트 기록 실패**가 남고 잡이 실패한다(실패 이슈 생성). 이때 YouTube 작업은 끝났는데 매니페스트 기록만 누락된 상태이므로, 다음 실행 전에 작업별로 수동 복구한다.

   | 실패한 잡 | 수동 기록할 필드 | 값 | 그대로 두면 |
   | --- | --- | --- | --- |
   | `yt-upload` (업로드 성공 후 기록 실패) | `youtube_id`, `uploaded_at` | `youtube_id`는 Step Summary 표, `uploaded_at`은 그 실행 시각 | 다음 실행에서 같은 영상이 중복 업로드됨 |
   | `yt-publish` (공개 성공 후 기록 실패) | `published_at` | 그 실행 시각 | 다음 공개 잡이 다시 대상으로 잡음(이미 public이면 `published_at`만 기록) |

   - 결과가 `업로드 (unlisted)`·`public 전환`·`이미 public (기록만)`인 행만 복구 대상이다.
   - 시각은 Actions 실행 화면의 실행 시각을 ISO 8601 UTC로 적는다(예: `uploaded_at: 2026-11-27T08:23:00.000Z`). `uploaded_at`은 일 상한 계산(PT 날짜)에 쓰이므로 날짜를 틀리지 않는다.
   - main에 반영(push 또는 PR 머지)한 뒤 실패 이슈를 닫는다. 매니페스트 push는 `yt-upload`를 실행시키지만 `youtube_id`가 채워져 있으므로 다시 업로드하지 않는다.
4. **로그 시트**(선택): `LOG_SHEET_WEBHOOK_URL` secret이 있으면 실행마다 결과 요약이 로그 시트 웹앱으로 전송된다(웹앱이 구현되면 `YT` 탭에 기록). secret이 없으면 로그에 `LOG_SHEET_WEBHOOK_URL 없음: 로그 시트 전송 건너뜀`만 남는다. 전송 실패는 경고뿐이므로 로그 시트에 행이 없어도 원본 판단은 Actions 실행과 이슈로 한다. 웹앱 쪽 설계는 설계 문서 10장.

## 4. quotaExceeded 대처

- 쿼터는 프로젝트 하나에 하루 10,000 units를 세 채널이 공유하고, 태평양 시간 자정(KST 16~17시)에 초기화된다.
- `quotaExceeded`(403)가 나면 재시도하지 않고 그 실행 전체를 멈춘다. 이미 업로드·공개한 영상의 기록은 커밋되고, 남은 영상은 `이월`로 표시된다. 잡은 실패로 끝나므로 실패 이슈가 열린다.
- 이월된 업로드는 매일 17:23 KST cron(쿼터 초기화 직후)이 자동으로 다시 시도한다. 이월된 공개는 다음 금요일 공개 잡이 처리하며, 급하면 쿼터 초기화 뒤 `yt-publish`를 수동 실행한다.
- 할 일: 같은 날 수동 재실행을 반복하지 않는다(쿼터만 더 쓴다). 다음 cron 성공을 확인한 뒤 이슈를 닫는다. 자주 반복되면 하루 업로드 편수를 줄이거나 `DAILY_UPLOAD_LIMIT`(0~10)를 낮춘다.

## 5. dry_run과 실제 실행, YT_PUBLISH_ENABLED

| 실행 | 동작 |
| --- | --- |
| `yt-upload` push·cron | 실제 업로드 |
| `yt-upload` 수동 실행 | `dry_run` 기본 false. 체크하면 업로드 계획만 출력(API 호출·기록 없음). `manifest`로 한 편만 지정 가능 |
| `yt-publish` 수동 실행 | `dry_run` 기본 true(공개 대상만 출력, `videos.update`·기록 없음). 체크를 끄면 실제 공개 |
| `yt-publish` cron(금 21:17 KST) | 저장소 변수 `YT_PUBLISH_ENABLED`가 `true`일 때만 실제 공개. 미설정이거나 다른 값이면 dry_run으로만 동작 |

- `YT_PUBLISH_ENABLED`는 Settings → Secrets and variables → Actions → **Variables**에 둔다(secret 아님). 업로드 테스트와 공개 dry_run 결과를 확인한 뒤 `true`로 설정해 주간 자동 공개를 켠다. 끄려면 변수를 지우거나 `false`로 바꾼다.
- 공개 수동 실행은 항상 dry_run으로 대상을 먼저 확인한 뒤 실제 실행한다.

## 6. OAuth 토큰 재발급 (요약)

자세한 절차는 [README](../README.md#리프레시-토큰-재발급)와 설계 문서 3.4.

1. `invalid_grant` 실패(실패 이슈가 열림)에서 어떤 secret인지 확인한다: `YT_SEONMINMOV_REFRESH_TOKEN`, `YT_MELIV_REFRESH_TOKEN`, `YT_VIRIDITAS_REFRESH_TOKEN`, `DRIVE_REFRESH_TOKEN`.
2. 로컬에서 `npm ci --prefix scripts/yt` 후, `YT_CLIENT_ID`·`YT_CLIENT_SECRET`을 셸 환경변수로만 넘겨 도우미를 실행한다.
   - 채널 토큰: `node scripts/yt/get-refresh-token.mjs --scope youtube` → 동의 화면에서 대상 브랜드 채널 선택
   - 드라이브 토큰: `node scripts/yt/get-refresh-token.mjs --scope drive` → Drive 소유 계정(A)으로 동의
3. 도우미는 토큰을 화면에 출력하지 않고 권한 0600 파일(기본 `~/.yt-tokens/`)에 쓴 뒤 경로만 알려준다. 그 파일로 secret을 갱신하고 파일을 지운다: `gh secret set <secret 이름> < <파일> && rm <파일>`
4. 실패한 워크플로를 다시 실행(공개는 dry_run 먼저)하고, 성공하면 실패 이슈를 닫는다.
5. OAuth 동의 화면이 "테스트" 상태면 토큰이 7일 만에 만료되므로 프로덕션 상태를 유지한다.
