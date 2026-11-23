# videos/ 매니페스트

영상 1편 = 매니페스트 1개(`videos/<slug>.yml`). 영상 파일은 드라이브 '영상' 폴더에 두고, 이 폴더에는 메타데이터만 둔다. 이 레포는 공개 레포이며 매니페스트 공개는 허용된 사항이다.

- 파일명: `^[a-z0-9][a-z0-9-]*\.yml$` (예: `2026-11-27-morning-routine.yml`)
- `_`로 시작하는 파일(`_example.yml`)과 이 README는 스크립트가 무시한다.
- 정의되지 않은 키는 검증 오류다.

## 필드

| 필드 | 필수 | 형식 / 규칙 | 비고 |
| --- | --- | --- | --- |
| `channel` | 필수 | `seonmin_mov` \| `meliv_music` \| `viriditas_worship` | 업로드할 채널(토큰 선택 기준) |
| `title` | 필수 | 1~100자, `<` `>` 금지 | |
| `description` | 선택 | UTF-8 5,000바이트 이하, `<` `>` 금지 | 기본 `""` |
| `tags` | 선택 | 문자열 배열, 각 태그 `<` `>` 금지, 합계 500자 이하(공백 포함 태그는 따옴표 2자 추가로 계산) | |
| `category_id` | 선택 | 숫자 문자열 | 기본 `"22"` |
| `default_language` | 선택 | BCP-47 (`ko`, `en`, `ko-KR`) | 기본 `ko`. 오디오 언어에도 사용 |
| `made_for_kids` | 필수 | boolean | `selfDeclaredMadeForKids` |
| `source` | 필수 | `{ type: drive, drive_file_id }` 또는 `{ type: drive, drive_file_name }` 중 정확히 하나 | `drive_file_name`은 '영상' 폴더(`DRIVE_VIDEO_FOLDER_ID`) 안 `.mp4` 파일명 |
| `publish_week` | 선택 | `YYYY-Www` (ISO 주차) | 있으면 그 주차(KST) 이후 공개 잡에서 공개, 없으면 업로드 후 첫 공개 잡에서 공개 |
| `youtube_id` | 기록 | `null` 또는 11자 `[A-Za-z0-9_-]` | 업로드 워크플로우가 기록 |
| `uploaded_at` | 기록 | `null` 또는 ISO 8601 | 업로드 워크플로우가 기록 |
| `published_at` | 기록 | `null` 또는 ISO 8601 | 공개 워크플로우가 기록 |

## 교차 규칙

- `youtube_id`와 `uploaded_at`은 함께 있거나 함께 없어야 한다.
- `published_at`이 있으면 `youtube_id`도 있어야 한다.
- 같은 `youtube_id`, 같은 `drive_file_id`, 같은 `drive_file_name`을 두 매니페스트가 쓸 수 없다.

## 상태와 멱등성

| 상태 | 조건 | 다음 동작 |
| --- | --- | --- |
| 업로드 대기 | `youtube_id: null` | 업로드 워크플로우가 unlisted로 업로드 |
| 공개 대기 | `youtube_id` 있음, `published_at: null` | 금요일 공개 잡이 public 전환 |
| 완료 | `published_at` 있음 | 아무 것도 하지 않음 |

워크플로우는 기록 시 주석과 키 순서를 보존한다. 기록 필드는 손으로 고치지 않는다.
