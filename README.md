# content-pipeline

짧은 메모 한 줄이 채널별 콘텐츠 초안이 되는, Google Apps Script 기반 콘텐츠 파이프라인.

## 개요

혼자 여러 채널을 운영할 때 매일 반복되는 건 "무엇을 쓸지 정하는 것"과 "그 채널의 톤에 맞게 다시 쓰는 것"이다. 이 파이프라인은 그 앞단을 자동화한다. 드라이브 인박스 폴더에 일상 메모를 하나 던져 넣으면, 그날 담당 채널의 템플릿과 합쳐진 초안 문서가 자동으로 만들어진다.

## 작동 흐름

1. runDaily()가 매일 정해진 시간에 실행된다 (트리거는 installTrigger()로 등록)
2. 인박스 폴더에서 그날의 메모 파일을 찾는다
3. 요일별 채널 매핑에 따라 담당 채널을 정한다 (예: 금요일은 seonmin_mov)
4. 채널 템플릿과 메모 본문을 합성해 초안 폴더에 문서를 생성한다
5. 처리된 메모는 processed 폴더로 이동하고, 로그 시트에 결과가 기록된다

## 입력 형식

인박스에는 구글 문서나 텍스트 파일(.txt)을 넣는다. 그 외 형식(이미지, PDF 등)은 읽지 않고 건너뛴다. 파일명 규칙은 없다.

메모는 두 방식 중 아무거나 쓸 수 있다. 첫 줄부터 "필드: 값" 형식의 줄이 이어지면 스키마 메모로 인식되고, 스키마 줄이 끝난 뒤 나머지는 전부 본문이 된다. 첫 줄이 필드 형식이 아니면 스키마 없는 일반 메모로 판정해 전체가 본문이 되고, 제목은 본문 첫 줄에서 가져온다(# 접두사 제거, 최대 50자). 필드 값은 한 줄 안에 끝나야 하고, 본문이 빈 메모는 처리되지 않는다.

스키마 필드는 전부 선택이며 다음 일곱 개다. 필드명 대소문자는 무시한다.

- title: 제목. 생략하면 본문 첫 줄을 제목으로 쓴다
- core_message: 본문. 지정하면 메모의 나머지 부분 대신 이 값이 본문이 된다
- target_channels: 발행할 채널. 쉼표로 여러 개를 쓸 수 있고, 지정하면 요일 매핑 대신 이 채널로 발행한다. 채널 ID는 templates 폴더의 템플릿 이름과 같다(naver_blog, insta_on 등). 미리 특정 채널용으로 써둔 글은 요일 매핑을 타지 않도록 target_channels을 지정한다
- target_languages: 언어 태그. 템플릿의 언어 자리에 전달된다
- reference_url: 참고 링크
- keywords: 키워드
- source: 출처

스키마 메모 예시:

```text
title: 아침 루틴을 바꾼 한 달 기록
target_channels: naver_blog, insta_on
keywords: 루틴, 아침, 기록
source: 개인 경험

폰을 열기 전에 물부터 마시는 걸 한 달 했다.
처음 일주일은 자꾸 깜빡했는데, 물병을 침대 머리맡에 두고 나서는 거의 매일 지켰다.
```

일반 메모 예시 (스키마 없이 그냥 글만 써도 된다):

```text
# 아침 루틴 한 달 기록

폰을 열기 전에 물부터 마시는 걸 한 달 했다.
```

## 파일 구조

- code.gs : 파이프라인 전체 코드 (v0.4)
- naver_blog.txt : 네이버 블로그 포스트 템플릿
- tistory.txt : 티스토리 매거진 포스트 템플릿
- tumblr.txt : 텀블러 영문 감성 포스트 템플릿
- wordpress.txt : 스페인어 에세이 템플릿
- ameba.txt : 아메바 블로그 일상 포스트 템플릿 (일본어)
- xiaohongshu.txt : 샤오홍슈 콘텐츠 템플릿 (중국어)
- insta_on.txt / insta_off.txt : 인스타그램 캡션 템플릿 (계정별)
- meliv.txt : 음악 콘텐츠 템플릿
- viriditas.txt : 묵상 콘텐츠 템플릿
- seonmin_mov.txt : 촬영·영상 스크립트 템플릿

각 템플릿은 채널의 언어, 톤, 구조, 제목 규칙까지 지정한다.

## 설계 결정

- PROMPT_ONLY 모드: 초안 문서는 완성된 글이 아니라 "템플릿 + 메모"를 합친 프롬프트다. 이걸 챗봇에 붙여넣어 실제 초안을 받은 다음 문서를 교체한다. 글의 목소리는 사람이 유지하고, 기계는 뼈대만 잡는 구조.
- 키 관리: API 키는 코드에 넣지 않고 Apps Script의 Script Properties(GEMINI_API_KEY)에서 읽는다.
- 실패 처리: 채널 처리에 실패해도 메모는 processed로 이동시키고 로그에 남긴다. 메모가 인박스에 쌓여 다음 실행을 막는 일이 없게 하는 대신, 문제는 로그로 추적한다.

## 설치

1. Apps Script 프로젝트를 만들고 code.gs를 붙여넣는다
2. setupFolders()를 한 번 실행하면 인박스 / templates / 초안 / processed 폴더와 로그 시트가 자동으로 만들어진다
3. 폴더 위치를 바꾸고 싶으면 CONFIG의 ROOT_NAME을 수정한다. 폴더는 ID가 아니라 이름으로 찾는다
4. Gemini 자동 생성 모드를 쓸 때만: Script Properties에 GEMINI_API_KEY를 등록한다 (기본 PROMPT_ONLY모드에서는 필요 없다)
5. installTrigger()를 한 번 실행해 일일 트리거를 등록한다

## 기대 효과

주 11편(연 572편) 규모의 채널 운영 기준이다. 채널 글 한 편을 수작업으로 완성하는 데 평균 1시간이 걸린다면 연 572시간의 작업이다. 파이프라인을 쓰면 한 편당 메모 5분, 초안 생성 5분, 최종 다듬기 15-20분의 25-30분이 되고, 한 편당 30-35분이 절감된다.

- 수작업: 60분/편 x 572편 = 572시간/년
- 파이프라인: 25-30분/편 x 572편 = 약 239-286시간/년
- 절감: 30-35분/편 = 연간 약 290-330시간
- 운영 볼륨을 절반(주 5-6편)으로 줄여도 연간 약 150시간 절감

2026-11-20 naver_blog 첫 루프 실측(1회): 메모 작성 10분 37초, 파이프라인 실행(업로드-초안 생성-파일 오픈) 58초, 초안 완성(AI 왕복 포함) 2분 06초, 다듬기+발행 6분 51초. 합계 약 20분 30초로 추정치(25-30분)보다 짧았다. 수작업 60분/편 대비 절감은 약 40분/편, 주 11편 기준 연 약 380시간, 절반 볼륨(주 5-6편)로도 연 약 190시간이다. 구간별 시간은 메모 분량과 채널에 따라 달라지며, 실측 표본을 쌓아 수치를 계속 갱신한다.

## 현재 상태

v0.4 설치 완료, 1차 실행 테스트 성공. 메모가 채널에 매핑되고 초안 문서가 생성되고 인박스가 정리되기까지 전 구간을 확인했다. 다음 단계는 naver_blog 채널로 프롬프트부터 실제 초안까지의 첫 루프를 완주하는 것.

## LLM 제공자

자동 생성은 기존과 같이 `LLM_MODE: 'GEMINI'`로 켜고, `LLM_PROVIDER`로 제공자를 수동 선택합니다(자동 폴백 없음). 기본값은 `gemini`이며, 비 Gemini 제공자는 `LLM_MODEL`에 모델명을 지정하세요.

| LLM_PROVIDER | 스크립트 속성 키 | 무료 키 발급 |
| --- | --- | --- |
| `gemini` | `GEMINI_API_KEY` | https://aistudio.google.com |
| `githubmodels` | `GITHUB_MODELS_TOKEN` | https://github.com/marketplace/models (PAT에 `models:read` 권한) |
| `groq` | `GROQ_API_KEY` | https://console.groq.com |
| `openrouter` | `OPENROUTER_API_KEY` | https://openrouter.ai (모델명에 `:free`가 붙은 것만 무료) |

모델명 예: GitHub Models `openai/gpt-4o-mini`, Groq `llama-3.3-70b-versatile`, OpenRouter는 `:free` 모델 ID. 키는 프로젝트 설정 → **스크립트 속성**에만 저장하고 코드나 GitHub에는 절대 넣지 않습니다.

## 유튜브 영상 파이프라인 (GitHub Actions)

위 Apps Script 파이프라인과 별개로, `videos/` 매니페스트와 GitHub Actions로 세 채널(Seonmin MOV, Meliv Music, Viriditas Worship)에 영상을 unlisted 업로드하고 매주 금요일 21:17 KST에 public으로 전환한다. 설계와 운영은 [docs/youtube-pipeline.md](docs/youtube-pipeline.md) 참고.

### 리프레시 토큰 재발급

업로드·공개 잡이 `invalid_grant`로 실패하면(`[yt] ... 실패` 이슈가 자동으로 열림) 해당 토큰이 무효화된 것이다(6개월 미사용, 비밀번호 변경, 권한 철회, 동의 화면이 "테스트" 상태 등). 다음 절차로 재발급한다.

1. 실패 로그에서 어떤 secret이 실패했는지 확인한다 (채널 토큰 `YT_SEONMINMOV_REFRESH_TOKEN`·`YT_MELIV_REFRESH_TOKEN`·`YT_VIRIDITAS_REFRESH_TOKEN`, 드라이브 토큰 `DRIVE_REFRESH_TOKEN`).
2. 필요하면 해당 Google 계정의 [타사 앱 액세스](https://myaccount.google.com/connections)에서 이 앱의 권한을 철회한다(새 refresh token이 확실히 발급되도록).
3. 로컬에서 `npm ci --prefix scripts/yt` 후 도우미를 실행한다. `YT_CLIENT_ID`, `YT_CLIENT_SECRET`은 셸 환경변수로만 넘긴다.
   - 채널 토큰: `node scripts/yt/get-refresh-token.mjs --scope youtube` → 동의 화면에서 대상 **브랜드 채널**을 선택
   - 드라이브 토큰: `node scripts/yt/get-refresh-token.mjs --scope drive` → Drive 소유 계정(A)으로 동의
4. 도우미는 토큰을 화면에 출력하지 않고 권한 0600 파일(기본 `~/.yt-tokens/`)에 쓴 뒤 경로만 알려준다. 그 파일로 secret을 덮어쓰고 바로 지운다.
   ```sh
   gh secret set YT_SEONMINMOV_REFRESH_TOKEN < ~/.yt-tokens/<파일> && rm ~/.yt-tokens/<파일>
   ```
5. Actions 탭에서 실패한 워크플로를 다시 실행(공개는 `dry_run`으로 먼저 확인)하고, 성공하면 실패 이슈를 닫는다.

