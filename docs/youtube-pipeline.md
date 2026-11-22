# 유튜브 영상 파이프라인 (GitHub Actions)

- 레포: `tjsals0106/content-pipeline` (공개 레포, 기본 브랜치 `main`)
- 기준: 설계 문서 v1(`youtube-video-pipeline-design.md`)에 v2 확정 사항(2026-11-22)을 적용한 구현 기준 문서
- 기존 Apps Script 파이프라인(`*.gs`, 학교 계정)과는 독립적으로 동작한다. 같은 레포에 있을 뿐 코드·자격증명을 공유하지 않는다.

## 1. 요약

1. 사람이 완성본 영상(세로형 1080x1920 MP4)을 드라이브 '영상' 폴더에 올리고 `videos/<slug>.yml` 매니페스트를 커밋한다.
2. 업로드 워크플로우(`yt-upload.yml`)가 드라이브에서 영상을 받아 YouTube Data API v3 `videos.insert`로 **일부 공개(unlisted)** 업로드하고, 매니페스트에 `youtube_id`, `uploaded_at`을 기록한다.
3. 공개 워크플로우(`yt-publish.yml`)가 **매주 금요일 21:17 KST**에 돌며 공개 대기 영상을 `videos.update`로 **public** 전환하고 `published_at`을 기록한다.
4. 대상 채널은 3개(Seonmin MOV, Meliv Music, Viriditas Worship). 채널별 리프레시 토큰이 등록된 채널만 동작하고, 토큰이 없는 채널은 스킵하고 로그에 남긴다.
5. 렌더링·썸네일·로그 시트 연동은 범위 밖이다. 로그는 GitHub Actions 로그와 Step Summary만 쓴다.

## 2. 아키텍처

```
[사람] 촬영·편집 → 완성본 MP4 ──▶ 드라이브 '영상' 폴더 (계정 A 소유, 계정 B 공유)
[사람] videos/<slug>.yml 커밋 (channel 필드로 채널 구분)
                 │
                 ▼
 yt-upload.yml  (workflow_dispatch → PR 5에서 push 트리거 추가)
   1. 매니페스트 검증 (validate.mjs)
   2. DRIVE_REFRESH_TOKEN으로 영상 다운로드 (러너 임시 디렉터리)
   3. 채널 토큰으로 videos.insert (resumable, privacyStatus=unlisted 명시)
   4. youtube_id, uploaded_at 기록 → github-actions[bot] 커밋
                 │
                 ▼
     YouTube 채널 (unlisted 영상)
                 ▲
 yt-publish.yml (cron '17 12 * * 5' = 금 21:17 KST, workflow_dispatch dry_run)
   1. 공개 대상 선정 (youtube_id 있음, published_at 없음, publish_week 도래)
   2. videos.list로 상태 확인 (처리 완료, unlisted, 채널 일치)
   3. videos.update → public (이미 public이면 호출하지 않고 기록만)
   4. published_at 기록 → github-actions[bot] 커밋
```

### 2.1 구성 요소

| 구성 요소 | 역할 | PR |
| --- | --- | --- |
| `docs/youtube-pipeline.md` | 이 문서 | 1 |
| `videos/<slug>.yml` | 영상 1편의 메타데이터 + 상태 | 1 (스키마·예시) |
| `scripts/yt/` (Node 20, ESM) | 검증·토큰 발급 도우미·업로드·공개 스크립트. 의존성은 `yaml` 하나, API는 Node 내장 `fetch`로 직접 호출 | 2~4 |
| `.github/workflows/yt-validate.yml` | PR·push 시 매니페스트 검증 + 단위 테스트 (secrets 불필요) | 2 |
| `.github/workflows/yt-upload.yml` | 업로드 잡 | 3 |
| `.github/workflows/yt-publish.yml` | 주간 공개 전환 잡 | 4 |

### 2.2 상태 관리

상태는 매니페스트가 원장이다(v2 확정 9). 업로드 후 `youtube_id`, `uploaded_at`, 공개 후 `published_at`을 `GITHUB_TOKEN`으로 커밋한다. 매니페스트(제목·설명·영상 ID 포함)가 공개 레포에 노출되는 것은 허용된 사항이다.

멱등성:
- `youtube_id`가 있는 매니페스트는 업로드하지 않는다.
- 업로드 직전 채널의 업로드 재생목록을 `playlistItems.list`(최근 50개)로 조회해 제목이 같은 영상이 있으면 업로드하지 않고 그 ID를 기록한다(이전 실행이 업로드 후 커밋 전에 실패한 경우 대비).
- `published_at`이 있으면 공개 잡이 건드리지 않는다. 이미 public인 영상은 `videos.update` 없이 `published_at`만 기록한다.
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

채널 토큰이 비어 있으면 그 채널은 실패가 아니라 **스킵**하고 로그·Step Summary에 "토큰 없음"으로 남긴다. 토큰을 등록하면 다음 실행부터 자동으로 그 채널이 켜진다.

### 3.3 Repository variables (선택)

| 이름 | 기본 | 내용 |
| --- | --- | --- |
| `DRIVE_VIDEO_FOLDER_ID` | 없음 | '영상' 폴더 ID. 매니페스트에 `drive_file_name`을 쓰면 필수 |
| `YT_CHANNEL_ID_SEONMIN_MOV` | 없음 | 설정 시 토큰의 채널 ID(`channels.list mine=true`)와 다르면 그 채널 실패 (안전장치) |
| `YT_CHANNEL_ID_MELIV_MUSIC` | 없음 | 위와 같음 |
| `YT_CHANNEL_ID_VIRIDITAS_WORSHIP` | 없음 | 위와 같음 |
| `DAILY_UPLOAD_LIMIT` | `10` | 하루(PT 기준) 업로드 방어 상한, 세 채널 합산 |
| `PUBLISH_BATCH_SIZE` | `10` | 공개 잡 1회 채널당 최대 공개 편수 |
| `YT_PUBLISH_ENABLED` | 없음 | `true`일 때만 cron 실행이 실제 공개. 그 외에는 cron도 dry_run (PR 5에서 `true`로 전환) |

- 액세스 토큰은 저장하지 않는다. 실행마다 리프레시 토큰으로 발급하고 즉시 `::add-mask::`로 마스킹한다. API 응답 원문은 로그에 남기지 않는다(공개 레포는 Actions 로그도 공개).
- secrets는 포크 PR 워크플로우에 전달되지 않는다. 업로드·공개 잡은 `workflow_dispatch`·`schedule`(·PR 5 이후 `push`)에서만 돈다.
- 선택: secrets를 `youtube` Environment로 옮기고 main 브랜치 제한을 걸 수 있다(현재는 레포 secrets 사용).

### 3.4 토큰 발급 절차

1. Google Cloud 프로젝트에서 YouTube Data API v3, Google Drive API 사용 설정.
2. OAuth 동의 화면 게시 상태를 **프로덕션**으로 둔다("테스트"면 리프레시 토큰이 7일 후 만료).
3. OAuth 클라이언트(데스크톱 앱) 1개를 공용으로 쓴다 → `YT_CLIENT_ID`, `YT_CLIENT_SECRET`.
4. 로컬에서 토큰 발급 도우미(`scripts/yt/get-refresh-token.mjs`, PR 2)로 발급:
   - 채널 토큰: `--scope youtube`, 동의 화면에서 해당 **브랜드 채널**을 선택 → `YT_*_REFRESH_TOKEN`
   - 드라이브 토큰: `--scope drive`, Drive 소유 계정(A) → `DRIVE_REFRESH_TOKEN`
5. GitHub → Settings → Secrets and variables → Actions에 등록.

토큰 무효화(6개월 미사용, 비밀번호 변경, 권한 철회) 시 `invalid_grant`로 실패하므로 같은 절차로 재발급한다. 주간 공개 잡이 매주 토큰을 쓰므로 미사용 만료는 방지된다.

## 4. 영상 소스

- 드라이브 '영상' 폴더 하나(Drive 소유 계정 A의 드라이브, 채널 운영 계정 B에 공유되어 어느 계정에서든 업로드 가능). 모든 채널의 영상이 여기 있고 매니페스트 `channel`로 구분한다.
- 세로형 1080x1920 MP4, 1편당 30~80MB, 렌더링 없이 완성본만.
- 매니페스트 `source`에 `drive_file_name`(폴더 안 파일명) 또는 `drive_file_id`를 적는다.
- 영상 파일은 레포에 커밋하지 않는다(`.gitignore`에 영상 확장자 등록).

업로드 스크립트 검사:
- `.mp4`(또는 `video/mp4`) 아니면 실패, 0바이트·512MB 초과면 실패, 30~80MB 범위 밖이면 경고.
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
| 업로드 | 자동, 항상 `privacyStatus=unlisted` 명시(생략 시 public이 되므로). PR 3은 `workflow_dispatch`로 시작, PR 5에서 `videos/**` push 트리거 추가 |
| 공개 전환 | 주 1회 자동. cron `17 12 * * 5` = 금 12:17 UTC = **금 21:17 KST**, 세 채널 동일. 정시를 피해 17분 |
| 공개 대상 | `youtube_id` 있음 + `published_at` 없음 + (`publish_week` 없음 또는 현재 ISO 주차(KST) 이상), 처리 완료(`processed`)이며 현재 `unlisted`인 영상 |
| 이미 public | `videos.update` 호출 금지, `published_at`만 기록 |
| private 영상 | 사람이 의도적으로 바꾼 것으로 보고 스킵 + 경고 |
| 로그 | Actions 로그 + Step Summary 표만 |
| 기록 커밋 | `github-actions[bot]`이 main에 `videos/` 변경만 커밋(`git pull --rebase` 후 push). main 브랜치 보호 규칙이 bot push를 막으면 기록 단계가 실패하므로 보호 규칙 설정 시 예외가 필요 |

## 7. 리스크와 대응

| # | 리스크 | 대응 |
| --- | --- | --- |
| R2 | 동의 화면 "테스트" 상태면 리프레시 토큰 7일 만료 | 동의 화면 프로덕션 전환 |
| R3 | 리프레시 토큰 무효화 | `invalid_grant` 시 잡 실패, 3.4 절차로 재발급 |
| R4 | 영상 파일 git 커밋 (100MB 제한, 유출) | 드라이브 보관, `.gitignore` |
| R6 | 공개 레포 60일 무활동 시 예약 워크플로우 비활성화 | 업로드 기록 커밋이 활동으로 잡힘. 공백기에는 Actions 탭에서 재활성화 (PR 5에서 keepalive 검토) |
| R7 | cron 지연·누락 | 정시 회피(:17). 공개 시각 오차 수십 분은 허용 |
| R8 | cron은 UTC | `17 12 * * 5` = 금 21:17 KST 명시 |
| R9 | 중복 업로드 | `concurrency`(대기, 취소 없음), `youtube_id` 검사, 재생목록 제목 검사, 청크 재개만 |
| R11 | 처리 실패·거부 영상 공개 | `status.uploadStatus == processed`일 때만 공개 |
| R12 | 아동용 미선언, 메타데이터 한도 위반 | `made_for_kids` 필수, 제목 100자·설명 5,000바이트·태그 500자 검증 |
| R13 | 로그에 토큰 노출 | 액세스 토큰 `::add-mask::`, 응답 원문 덤프 금지 |
| R15 | 쿼터 공유로 한 채널이 풀 소진 | 일 10편 방어 상한, `quotaExceeded` 시 전체 중단·이월 |

(v1의 R1 "미감사 프로젝트 비공개 잠금"은 2026-11-02 정책 철회로 삭제. 감사 절차 불필요.)

## 8. PR 계획

| PR | 범위 | 완료 기준 |
| --- | --- | --- |
| 1 | 이 문서, `videos/` 스키마·예시, `.gitignore` 영상 확장자 | 리뷰 승인 |
| 2 | `scripts/yt/` 골격, OAuth 토큰 발급 도우미, `validate.mjs` + 단위 테스트, 검증 전용 CI(`yt-validate.yml`) | PR에서 검증 CI 통과 |
| 3 | `upload.mjs` + `yt-upload.yml` (`workflow_dispatch`, unlisted, 드라이브 다운로드, 채널별 토큰) | 테스트 영상 1편 unlisted 업로드, `youtube_id` 커밋 확인 |
| 4 | `publish.mjs` + `yt-publish.yml` (dispatch 기본 dry_run, cron `17 12 * * 5`, public 전환) | dry_run 대상 선정 확인 후 실제 공개 1편 성공 |
| 5 (이번 범위 밖) | 운영 전환: 업로드 push 트리거, `YT_PUBLISH_ENABLED=true`, keepalive 검토 | 실제 주간 사이클 1회 완주 |
| 6 (이번 범위 밖) | 기존 로그 시트 연동 | |

렌더링(v1 PR 7)과 썸네일 API는 범위에서 제외한다.
