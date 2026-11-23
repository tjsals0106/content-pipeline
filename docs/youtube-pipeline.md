# 유튜브 영상 파이프라인 (GitHub Actions)

- 레포: `tjsals0106/content-pipeline` (공개 레포, 기본 브랜치 `main`)
- 기준: 설계 문서 v1(`youtube-video-pipeline-design.md`)에 v2 확정 사항(2026-11-22)을 적용한 구현 기준 문서
- 기존 Apps Script 파이프라인(`*.gs`, 학교 계정)과는 독립적으로 동작한다. 같은 레포에 있을 뿐 코드·자격증명을 공유하지 않는다.

## 1. 요약

1. 사람이 완성본 영상(세로형 1080x1920 MP4)을 드라이브 '영상' 폴더에 올리고 `videos/<slug>.yml` 매니페스트를 커밋한다.
2. 업로드 워크플로우(`yt-upload.yml`)가 main에 매니페스트가 push되면(그리고 매일 17:23 KST에 이월분 재시도로) 드라이브에서 영상을 받아 YouTube Data API v3 `videos.insert`로 **일부 공개(unlisted)** 업로드하고, 매니페스트에 `youtube_id`, `uploaded_at`을 기록한다.
3. 공개 워크플로우(`yt-publish.yml`)가 **매주 금요일 21:17 KST**에 돌며 공개 대기 영상을 `videos.update`로 **public** 전환하고 `published_at`을 기록한다.
4. 대상 채널은 3개(Seonmin MOV, Meliv Music, Viriditas Worship). 채널별 리프레시 토큰이 등록된 채널만 동작하고, 토큰이 없는 채널은 스킵하고 로그에 남긴다.
5. 업로드·공개·keepalive 잡이 실패하면 GitHub 이슈가 자동으로 열리고, 매월 keepalive가 예약 워크플로 잠김을 막는다.
6. 렌더링·썸네일은 범위 밖이다. 로그는 GitHub Actions 로그와 Step Summary가 기본이고, `LOG_SHEET_WEBHOOK_URL` 시크릿이 있으면 실행 결과 요약을 기존 로그 시트 웹앱으로도 보낸다(10장).

## 2. 아키텍처

```
[사람] 촬영·편집 → 완성본 MP4 ──▶ 드라이브 '영상' 폴더 (계정 A 소유, 계정 B 공유)
[사람] videos/<slug>.yml 커밋 (channel 필드로 채널 구분)
                 │
                 ▼
 yt-upload.yml  (main에 videos/*.yml push, 매일 cron '23 8 * * *', workflow_dispatch)
   1. 매니페스트 검증 (validate.mjs)
   2. DRIVE_REFRESH_TOKEN으로 영상 다운로드 (러너 임시 디렉터리)
   3. 채널 토큰으로 videos.insert (resumable, privacyStatus=unlisted 명시)
   4. youtube_id, uploaded_at 기록 → push-manifests.sh로 main에 커밋 (거부 시 재시도 최대 3회)
                 │
                 ▼
     YouTube 채널 (unlisted 영상)
                 ▲
 yt-publish.yml (cron '17 12 * * 5' = 금 21:17 KST, workflow_dispatch dry_run)
   1. 공개 대상 선정 (youtube_id 있음, published_at 없음, publish_week 도래)
   2. videos.list로 상태 확인 (처리 완료, unlisted, 채널 일치)
   3. videos.update → public (이미 public이면 호출하지 않고 기록만)
   4. published_at 기록 → push-manifests.sh로 main에 커밋 (거부 시 재시도 최대 3회)

 실패 시 → yt-failure-issue.yml이 '[yt] <워크플로> 실패' 이슈 생성
 매월 1일 → yt-keepalive.yml이 예약 워크플로 재활성화
 각 실행 끝 → log-sheet.mjs가 결과 요약을 LOG_SHEET_WEBHOOK_URL로 POST (시크릿 있을 때만)
```

### 2.1 구성 요소

| 구성 요소 | 역할 | PR |
| --- | --- | --- |
| `docs/youtube-pipeline.md` | 이 문서 | 1 |
| `videos/<slug>.yml` | 영상 1편의 메타데이터 + 상태 | 1 (스키마·예시) |
| `scripts/yt/` (Node 20 이상, Actions는 Node 24, ESM) | 검증·토큰 발급 도우미·업로드·공개 스크립트. 의존성은 `yaml` 하나, API는 Node 내장 `fetch`로 직접 호출 | 2~4 |
| `.github/workflows/yt-validate.yml` | PR·push 시 매니페스트 검증 + 단위 테스트 (secrets 불필요) | 2 |
| `.github/workflows/yt-upload.yml` | 업로드 잡 | 3 |
| `.github/workflows/yt-publish.yml` | 주간 공개 전환 잡 | 4 |
| `scripts/yt/push-manifests.sh` | 업로드·공개 잡 공통 매니페스트 기록 커밋·push (거부 시 `pull --rebase` 후 최대 3회 재시도, 최종 실패는 잡 실패) | 5 |
| `.github/workflows/yt-failure-issue.yml` | 업로드·공개·keepalive 실패 시 이슈 생성 (재사용 워크플로) | 5 |
| `.github/workflows/yt-keepalive.yml` | 예약 워크플로 무활동 잠금 방지 (매월) | 5 |
| `scripts/yt/log-sheet.mjs`, `scripts/yt/lib/result.mjs` | 실행 결과 요약 JSON 작성과 로그 시트 웹앱 POST (선택) | 6 |
| `docs/operations.md` | 운영 매뉴얼 | - |

### 2.2 상태 관리

상태는 매니페스트가 원장이다(v2 확정 9). 업로드 후 `youtube_id`, `uploaded_at`, 공개 후 `published_at`을 `GITHUB_TOKEN`으로 커밋한다. 매니페스트(제목·설명·영상 ID 포함)가 공개 레포에 노출되는 것은 허용된 사항이다.

멱등성:
- `youtube_id`가 있는 매니페스트는 업로드하지 않는다.
- 업로드 직전 채널의 업로드 재생목록을 `playlistItems.list`(최근 50개)로 조회해 제목이 같은 영상이 있으면 업로드를 보류하고 `확인 필요`로 실패 처리한다. 제목만으로는 같은 영상이라 보장할 수 없으므로 그 ID를 매니페스트에 자동 기록하지 않는다(무관한 영상이 연결돼 공개 전환되는 것 방지). 같은 영상이면 사람이 `youtube_id`를 직접 기록하고, 아니면 제목을 바꾼다.
- `published_at`이 있으면 공개 잡이 건드리지 않는다. 이미 public인 영상은 `videos.update` 없이 `published_at`만 기록한다.
- 기록 push가 동시 실행과 경합해 거부돼도 `push-manifests.sh`가 재시도하므로 기록이 유실되지 않는다. 끝내 실패하면 잡이 실패하고 이슈가 열리며, 그 경우 Step Summary의 `youtube_id`를 사람이 매니페스트에 기록해야 한다(중복 업로드 방지).
- `GITHUB_TOKEN` 커밋은 다른 워크플로우를 트리거하지 않으므로 업로드 → 커밋 → 재업로드 루프가 없다.

매니페스트 스키마는 [`videos/README.md`](../videos/README.md), 예시는 [`videos/_example.yml`](../videos/_example.yml).

## 3. 채널과 자격증명

### 3.1 채널

| 채널 키 (`channel`) | 채널 | 소유 Google 계정 (역할 별칭) | 리프레시 토큰 secret |
| --- | --- | --- | --- |
| `seonmin_mov` | Seonmin MOV | Drive 소유 계정 (계정 A) | `YT_SEONMINMOV_REFRESH_TOKEN` |
| `meliv_music` | Meliv Music | 채널 운영 계정 (계정 B) | `YT_MELIV_REFRESH_TOKEN` |
| `viriditas_worship` | Viriditas Worship | 채널 운영 계정 (계정 B) | `YT_VIRIDITAS_REFRESH_TOKEN` |

채널 토큰은 브랜드 계정 기반이라 YouTube 스코프(`youtube.upload`, `youtube`)만 가진다. 드라이브 접근은 `DRIVE_REFRESH_TOKEN`(Drive 소유 계정 A, `drive.readonly`)으로만 한다.

### 3.2 Actions secrets (레포 단위)

| 이름 | 필수 | 내용 |
| --- | --- | --- |
| `YT_CLIENT_ID` | 필수 | 공용 OAuth 클라이언트 ID (데스크톱 앱) |
| `YT_CLIENT_SECRET` | 필수 | 위 클라이언트 secret |
| `DRIVE_REFRESH_TOKEN` | 필수 | Drive 소유 계정(A) 토큰, 드라이브 다운로드 전용 |
| `YT_SEONMINMOV_REFRESH_TOKEN` | 채널별 | Seonmin MOV 채널 토큰 |
| `YT_MELIV_REFRESH_TOKEN` | 채널별 | Meliv Music 채널 토큰 |
| `YT_VIRIDITAS_REFRESH_TOKEN` | 채널별 | Viriditas Worship 채널 토큰 |
| `LOG_SHEET_WEBHOOK_URL` | 선택 | 로그 시트 웹앱(Apps Script) 엔드포인트 URL. 없으면 전송 단계를 건너뛴다 (10장) |

채널 토큰이 비어 있으면 그 채널은 실패가 아니라 **스킵**하고 로그·Step Summary에 "토큰 없음"으로 남긴다. 토큰을 등록하면 다음 실행부터 자동으로 그 채널이 켜진다.

### 3.3 Repository variables (선택)

| 이름 | 기본 | 내용 |
| --- | --- | --- |
| `DRIVE_VIDEO_FOLDER_ID` | 없음 | '영상' 폴더 ID. 매니페스트에 `drive_file_name`을 쓰면 필수 |
| `YT_CHANNEL_ID_SEONMIN_MOV` | 없음 | 설정 시 토큰의 채널 ID(`channels.list mine=true`)와 다르면 그 채널 실패 (안전장치) |
| `YT_CHANNEL_ID_MELIV_MUSIC` | 없음 | 위와 같음 |
| `YT_CHANNEL_ID_VIRIDITAS_WORSHIP` | 없음 | 위와 같음 |
| `DAILY_UPLOAD_LIMIT` | `10` | 하루(PT 기준) 업로드 방어 상한, 세 채널 합산. 0~10 정수만 허용(11 이상은 10으로 제한, 그 외 값은 오류) |
| `PUBLISH_BATCH_SIZE` | `10` | 공개 잡 1회 채널당 최대 공개 편수 |
| `YT_PUBLISH_ENABLED` | 없음 | `true`일 때만 cron 실행이 실제 공개. 미설정이거나 `true`가 아니면 cron(schedule) 실행은 dry_run으로만 동작. 업로드 테스트를 마친 뒤 사용자가 설정 |

- 액세스 토큰은 저장하지 않는다. 실행마다 리프레시 토큰으로 발급하고 즉시 `::add-mask::`로 마스킹한다. API 응답 원문은 로그에 남기지 않는다(공개 레포는 Actions 로그도 공개). API 오류는 Google `error.message` 앞 200자만 남기며, 토큰·이메일 등 개인정보와 요청 본문은 기록하지 않는다.
- secrets는 포크 PR 워크플로우에 전달되지 않는다. 업로드·공개 잡은 `workflow_dispatch`·`schedule`·main `push`에서만 돈다.
- 선택: secrets를 `youtube` Environment로 옮기고 main 브랜치 제한을 걸 수 있다(현재는 레포 secrets 사용).

### 3.4 토큰 발급 절차

1. Google Cloud 프로젝트에서 YouTube Data API v3, Google Drive API 사용 설정.
2. OAuth 동의 화면 게시 상태를 **프로덕션**으로 둔다("테스트"면 리프레시 토큰이 7일 후 만료).
3. OAuth 클라이언트(데스크톱 앱) 1개를 공용으로 쓴다 → `YT_CLIENT_ID`, `YT_CLIENT_SECRET`.
4. 로컬에서 토큰 발급 도우미(`scripts/yt/get-refresh-token.mjs`, 9장)로 발급:
   - 채널 토큰: `--scope youtube`, 동의 화면에서 해당 **브랜드 채널**을 선택 → `YT_*_REFRESH_TOKEN`
   - 드라이브 토큰: `--scope drive`, Drive 소유 계정(A) → `DRIVE_REFRESH_TOKEN`
5. 도우미는 토큰을 화면에 출력하지 않고 권한 0600 파일에만 쓴다. 그 파일로 GitHub Actions secret에 등록(`gh secret set <이름> < 파일` 또는 Settings → Secrets and variables → Actions)한 뒤 파일을 삭제한다.

토큰 무효화(6개월 미사용, 비밀번호 변경, 권한 철회) 시 `invalid_grant`로 실패하므로 같은 절차로 재발급한다. 주간 공개 잡이 매주 토큰을 쓰므로 미사용 만료는 방지된다.

## 4. 영상 소스

- 드라이브 '영상' 폴더 하나(Drive 소유 계정 A의 드라이브, 채널 운영 계정 B에 공유되어 어느 계정에서든 업로드 가능). 모든 채널의 영상이 여기 있고 매니페스트 `channel`로 구분한다.
- 세로형 1080x1920 MP4, 1편당 30~80MB, 렌더링 없이 완성본만.
- 매니페스트 `source`에 `drive_file_name`(폴더 안 파일명) 또는 `drive_file_id`를 적는다.
- 영상 파일은 레포에 커밋하지 않는다(`.gitignore`에 영상 확장자 등록).

업로드 스크립트 검사:
- `.mp4`·`.mov`(또는 `video/mp4`·`video/quicktime`)가 아니면 실패, 0바이트·512MB 초과면 실패, 30~80MB 범위 밖이면 경고.
- `ffprobe`가 있으면(GitHub ubuntu 러너 기본 포함) 해상도·길이를 측정해 **세로형 + 3분 이하 = 쇼츠**, 그 외 = 일반으로 Step Summary에 분류한다. 차단 조건은 아니다. 1080x1920이 아니면 경고.
- 음악이 들어가는 쇼츠의 55~58초 원칙은 편집 규칙이며 코드로 강제하지 않는다.

## 5. YouTube API 할당량

합산 풀 **10,000 units/일**, 프로젝트 단위로 세 채널이 공유, 태평양 시간(PT) 자정 초기화(KST 16~17시).

| 호출 | 단가 | 용도 |
| --- | --- | --- |
| `videos.insert` | 1 | 업로드 |
| `channels.list` | 1 | 토큰 채널 확인, 업로드 재생목록 ID |
| `playlistItems.list` | 1 | 업로드 재생목록 조회(멱등성 검사) |
| `videos.list` | 1 | 공개 전 상태 확인 |
| `videos.update` | 50 | public 전환 |
| `search.list` | 1 | **호출 금지** (목록 조회는 `playlistItems.list`) |
| `thumbnails.set` | 50 | **사용 안 함** (자동 생성 썸네일) |

규칙:
- 스크립트 방어 상한: **하루 10편**(`DAILY_UPLOAD_LIMIT`, 세 채널 합산, PT 날짜 기준 `uploaded_at` 집계). 초과분은 다음 실행으로 이월.
- `quotaExceeded`(403)는 재시도하지 않고 즉시 실행 전체를 중단(풀을 세 채널이 공유하므로 나머지 채널도 중단), 남은 영상은 다음 실행으로 이월.
- 업로드 재시도는 resumable 업로드의 **청크 단위 재개**만. `videos.insert`를 새로 다시 호출하지 않는다(중복 영상 방지).
- 공개 잡은 편당 약 51 units(`videos.list` 일괄 1 + `videos.update` 50)이다.

## 6. 운영

| 항목 | 내용 |
| --- | --- |
| 업로드 | 자동, 항상 `privacyStatus=unlisted` 명시(생략 시 public이 되므로). 트리거는 main에 `videos/*.yml` push(`_` 접두사 예시 제외), 매일 cron `23 8 * * *`(08:23 UTC = **매일 17:23 KST** = PST 00:23, 쿼터 초기화 직후 이월분 재시도), `workflow_dispatch`. 봇의 기록 커밋은 `GITHUB_TOKEN` 커밋이라 push 트리거를 다시 일으키지 않는다 |
| 공개 전환 | 주 1회 자동. cron `17 12 * * 5` = 금 12:17 UTC = **금 21:17 KST**, 세 채널 동일. 정시를 피해 17분 |
| 공개 대상 | `youtube_id` 있음 + `published_at` 없음 + (`publish_week` 없음 또는 현재 ISO 주차(KST) 이상), 처리 완료(`processed`)이며 현재 `unlisted`인 영상 |
| 이미 public | `videos.update` 호출 금지, `published_at`만 기록 |
| private 영상 | 사람이 의도적으로 바꾼 것으로 보고 스킵 + 경고 |
| 로그 | Actions 로그 + Step Summary 표. `LOG_SHEET_WEBHOOK_URL`이 있으면 로그 시트로 요약 POST (10장) |
| 실패 알림 | 업로드·공개·keepalive 잡이 실패하면 `yt-failure-issue.yml`이 `[yt] <워크플로> 실패` 이슈를 연다. 같은 제목의 열린 이슈가 있으면 댓글로 실행 링크만 추가. 본문은 실행 링크·이벤트·커밋만 |
| keepalive | `yt-keepalive.yml`이 매월 1일 03:41 UTC에 예약 워크플로(`yt-upload`, `yt-publish`, `yt-keepalive`) 중 활성(`active`)이거나 무활동으로 잠긴(`disabled_inactivity`) 것에 Actions API(`PUT .../workflows/<파일>/enable`)를 호출해 무활동 타이머를 갱신·재활성화. 사람이 수동으로 끈 워크플로는 건드리지 않는다. 커밋을 만들지 않는다 |
| 운영 시작 | 업로드 테스트를 마치면 저장소 변수 `YT_PUBLISH_ENABLED=true`로 설정해 금요일 cron 실공개를 켠다 |
| 기록 커밋 | `github-actions[bot]`이 main에 `videos/` 변경만 커밋. 업로드·공개 잡은 `github.ref == 'refs/heads/main'`일 때만 실행되고 `ref: main`으로 체크아웃해 `git push origin HEAD:main`으로만 기록한다. 업로드·공개는 concurrency 그룹이 달라 동시에 기록할 수 있으므로 `scripts/yt/push-manifests.sh`가 push 거부 시 `pull --rebase` 후 최대 3회 재시도하고, 끝내 실패하거나 rebase가 충돌하면 `::error::`와 Step Summary에 남기고 잡을 실패시킨다(실패 이슈 생성). main 브랜치 보호 규칙이 bot push를 막으면 기록 단계가 실패하므로 보호 규칙 설정 시 예외가 필요 |

## 7. 리스크와 대응

| # | 리스크 | 대응 |
| --- | --- | --- |
| R2 | 동의 화면 "테스트" 상태면 리프레시 토큰 7일 만료 | 동의 화면 프로덕션 전환 |
| R3 | 리프레시 토큰 무효화 | `invalid_grant` 시 잡 실패 → 실패 이슈 생성, README의 재발급 절차(3.4)로 재발급 |
| R4 | 영상 파일 git 커밋 (100MB 제한, 유출) | 드라이브 보관, `.gitignore` |
| R6 | 공개 레포 60일 무활동 시 예약 워크플로우 비활성화 | `yt-keepalive.yml`이 매월 예약 워크플로를 재활성화. 그래도 비활성화되면 Actions 탭에서 수동 활성화 |
| R7 | cron 지연·누락 | 정시 회피(:17). 공개 시각 오차 수십 분은 허용 |
| R8 | cron은 UTC | `17 12 * * 5` = 금 21:17 KST 명시 |
| R9 | 중복 업로드 | 워크플로별 `concurrency`(`yt-upload`, `yt-publish`; 대기, 취소 없음), `youtube_id` 검사, 재생목록 제목 검사(일치 시 보류·사람 확인), 청크 재개만 |
| R11 | 처리 실패·거부 영상 공개 | `status.uploadStatus == processed`일 때만 공개 |
| R12 | 아동용 미선언, 메타데이터 한도 위반 | `made_for_kids` 필수(이 채널들은 `false`로 선언), 제목 100자·설명 5,000바이트·태그 500자 검증 |
| R13 | 로그에 토큰 노출 | 액세스 토큰 `::add-mask::`, 응답 원문 덤프 금지 |
| R15 | 쿼터 공유로 한 채널이 풀 소진 | 일 10편 방어 상한, `quotaExceeded` 시 전체 중단·이월(잡 실패 → 이슈 생성, 이미 업로드된 영상의 기록은 커밋) |
| R16 | 업로드·공개 기록 push 경합으로 기록 유실 | `push-manifests.sh` 재시도 최대 3회, 최종 실패·rebase 충돌은 `::error::` + Step Summary + 잡 실패 |
| R17 | 결과 파일·로그 시트 전송 실패가 본 작업을 실패로 표시 | 결과 파일 쓰기 실패와 웹훅 전송 실패는 경고만 남기고 업로드·공개 결과(종료 코드)를 바꾸지 않음 |

(v1의 R1 "미감사 프로젝트 비공개 잠금"은 2026-11-02 정책 철회로 삭제. 감사 절차 불필요.)

## 8. PR 계획

| PR | 범위 | 완료 기준 |
| --- | --- | --- |
| 1 | 이 문서, `videos/` 스키마·예시, `.gitignore` 영상 확장자 | 리뷰 승인 |
| 2 | `scripts/yt/` 골격, OAuth 토큰 발급 도우미, `validate.mjs` + 단위 테스트, 검증 전용 CI(`yt-validate.yml`) | PR에서 검증 CI 통과 |
| 3 | `upload.mjs` + `yt-upload.yml` (`workflow_dispatch`, unlisted, 드라이브 다운로드, 채널별 토큰) | 테스트 영상 1편 unlisted 업로드, `youtube_id` 커밋 확인 |
| 4 | `publish.mjs` + `yt-publish.yml` (dispatch 기본 dry_run, cron `17 12 * * 5`, public 전환) | dry_run 대상 선정 확인 후 실제 공개 1편 성공 |
| 5 | 운영 전환: 업로드 push·cron 트리거, 실패 시 이슈 자동 생성, keepalive, 토큰 재발급 절차(README), 기록 push 재시도(`push-manifests.sh`). `YT_PUBLISH_ENABLED=true`는 업로드 테스트 후 사용자가 설정 | 실제 주간 사이클 1회 완주 |
| 6 | 로그 시트 연동(선택): 업로드·공개 결과 요약을 `LOG_SHEET_WEBHOOK_URL`로 POST. Actions 쪽만 구현, 웹앱은 10장 설계만 | 시크릿 없이 건너뜀 확인, 웹앱 배포 후 1행 기록 확인 |

PR 1~6은 모두 main에 머지되었다. 렌더링(v1 PR 7)과 썸네일 API는 범위에서 제외한다.

## 9. 스크립트 사용법

`scripts/yt/` (Node 20 이상). 처음 한 번 `npm ci --prefix scripts/yt`.

| 명령 | 용도 |
| --- | --- |
| `node scripts/yt/validate.mjs [파일...]` | 매니페스트 검증. 인자 없으면 `videos/` 전체. 오류는 `파일: 필드: 메시지`로 출력하고 exit 1. 중복 검사는 항상 전체 기준 |
| `bash scripts/yt/push-manifests.sh '<커밋 메시지>'` | 워크플로 기록 단계 전용. `videos/` 변경을 커밋하고 main에 push(거부 시 `pull --rebase` 후 재시도, `PUSH_ATTEMPTS` 기본 3). 로컬에서 직접 쓰지 않는다 |
| `npm test --prefix scripts/yt` | 단위 테스트 (`node:test`) |
| `YT_CLIENT_ID=… YT_CLIENT_SECRET=… node scripts/yt/get-refresh-token.mjs --scope youtube\|drive` | 리프레시 토큰 발급 (3.4). 로컬 루프백(127.0.0.1)으로 동의 결과를 받아 토큰을 권한 0600 파일(기본 `~/.yt-tokens/`, `--out`으로 변경)에 쓰고 파일 경로와 등록할 secret 이름만 출력. 토큰 평문은 화면에 출력하지 않음 |

CI `yt-validate.yml`은 `videos/**`, `scripts/yt/**`, `yt-*.yml`이 바뀐 PR과 main push에서 단위 테스트와 검증을 돌린다. secrets를 쓰지 않는다.

## 10. 로그 시트 연동 (PR 6)

기존 콘텐츠 파이프라인(Apps Script, 학교 계정)의 로그 시트에 이 파이프라인의 실행 결과를 한 줄씩 남긴다. 이 레포는 **GitHub Actions 쪽 전송만** 구현한다. 학교 계정 저장소와 Apps Script 코드는 이 레포에서 건드리지 않는다.

### 10.1 Actions 쪽 (구현됨)

- `upload.mjs`·`publish.mjs`가 Step Summary와 같은 내용을 `YT_RESULT_FILE`(`$RUNNER_TEMP/yt-result.json`)에 JSON으로 남긴다. 파일 쓰기가 실패(경로·권한·디스크)해도 경고만 남기고 업로드·공개 성공 상태를 유지한다(그 경우 전송 페이로드의 `error`는 `실행 결과 파일 없음`).
- 두 워크플로의 마지막 단계 `로그 시트 전송`(`if: always()`)이 `scripts/yt/log-sheet.mjs`를 실행해 결과를 `LOG_SHEET_WEBHOOK_URL`로 `POST`(JSON)한다.
- 시크릿이 없으면 `LOG_SHEET_WEBHOOK_URL 없음: 로그 시트 전송 건너뜀`만 로그에 남기고 성공으로 끝난다.
- 전송이 실패해도(HTTP 오류, 네트워크, 15초 시간 초과, 응답 본문이 `ok`가 아님) 경고만 남기고 워크플로를 실패시키지 않는다. 재시도하지 않는다.
- URL은 로그에 출력하지 않는다(시크릿이라 Actions가 마스킹도 한다). dry_run 실행도 `dry_run: true`로 보낸다.

페이로드 예시:

```json
{
  "source": "content-pipeline-yt",
  "workflow": "yt-upload",
  "run_id": "123",
  "run_url": "https://github.com/tjsals0106/content-pipeline/actions/runs/123",
  "event": "push",
  "outcome": "success",
  "sent_at": "2026-11-27T08:23:40.000Z",
  "dry_run": false,
  "error": null,
  "counts": { "업로드 (unlisted)": 1, "스킵": 1 },
  "items": [
    { "channel": "Seonmin MOV", "manifest": "2026-11-27-sample.yml", "result": "업로드 (unlisted)", "youtube_id": "abc123", "note": "" }
  ]
}
```

- `outcome`: 업로드·공개 단계의 결과(`success`/`failure`/`skipped`).
- `error`: 검증 실패, 상한 설정 오류, 쿼터 초과처럼 실행 전체에 걸친 오류. 스크립트가 결과를 남기기 전에 죽으면 `결과 파일 없음`.
- `items[].result`: Step Summary의 결과 열과 같은 값(업로드·이월·스킵·실패·확인 필요·공개 전환·기록만 등).
- 토큰·이메일 같은 개인정보는 넣지 않는다. 매니페스트 이름·채널 표시 이름·youtube_id는 공개 레포에 이미 있는 값이다.

### 10.2 Apps Script 웹앱 쪽 (설계만, 이 레포 범위 밖)

학교 계정의 기존 프로젝트에서 따로 구현한다.

1. `doPost(e)`에서 `JSON.parse(e.postData.contents)`로 페이로드를 읽는다. `source !== 'content-pipeline-yt'`이면 무시한다.
2. 로그 시트에 `YT` 탭을 하나 두고 `items` 한 건당 한 행을 추가한다: `sent_at`, `workflow`, `dry_run`, `channel`, `manifest`, `result`, `youtube_id`, `note`, `run_url`. `items`가 비어 있으면 `error`/`outcome`을 담은 요약 한 행만 추가한다.
3. 같은 `run_id`가 다시 오면 중복으로 보고 건너뛴다(재실행 대비, `run_id` 열로 검사).
4. 배포: 웹앱, 실행 사용자 "나", 접근 "모든 사용자". URL을 아는 사람은 누구나 POST할 수 있으므로 쿼리에 임의의 긴 키(`?key=…`)를 붙여 `e.parameter.key`를 스크립트 속성 값과 비교하고, 키를 포함한 전체 URL을 `LOG_SHEET_WEBHOOK_URL` 시크릿에 등록한다.
5. 응답은 `ContentService.createTextOutput('ok')`. Apps Script는 302 리다이렉트로 응답하므로 전송 쪽은 리다이렉트를 따라간다(`fetch` 기본 동작).

## 11. 운영 매뉴얼

새 영상 올리기, 실패 확인, 쿼터 초과 대처, dry_run과 `YT_PUBLISH_ENABLED`, 토큰 재발급은 [`docs/operations.md`](operations.md)를 본다.
