#!/usr/bin/env bash
# 업로드·공개 워크플로의 매니페스트 기록(videos/)을 main에 커밋·push한다.
# 두 워크플로는 concurrency 그룹이 달라 동시에 push할 수 있으므로, 거부(non-fast-forward 등)되면
# pull --rebase 후 최대 PUSH_ATTEMPTS회 다시 push한다. 끝내 실패하면 ::error::를 남기고 exit 1.
# 사용: push-manifests.sh '<커밋 메시지>'
set -uo pipefail

msg="$1"
attempts="${PUSH_ATTEMPTS:-3}"
delay="${PUSH_RETRY_DELAY:-5}"

fail() {
  echo "::error::$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '\n**매니페스트 기록 실패**: %s\n' "$1" >> "$GITHUB_STEP_SUMMARY"
  fi
  exit 1
}

git add videos || fail '매니페스트 스테이징(git add) 실패'
if git diff --cached --quiet; then
  echo '매니페스트 변경 없음'
  exit 0
fi
git commit -q -m "$msg" || fail '매니페스트 커밋 실패'

lost='YouTube 작업 결과가 main에 기록되지 않았다. 다음 실행 전에 Step Summary의 youtube_id·시각을 매니페스트에 직접 기록해야 한다(중복 업로드 방지)'
for i in $(seq 1 "$attempts"); do
  if ! git pull -q --rebase origin main; then
    git rebase --abort 2>/dev/null
    fail "pull --rebase 충돌. ${lost}"
  fi
  if git push -q origin HEAD:main; then
    echo "매니페스트 기록 push 완료 (시도 ${i}/${attempts})"
    exit 0
  fi
  echo "::warning::매니페스트 기록 push 거부 (시도 ${i}/${attempts}). 다시 pull --rebase 후 재시도"
  [ "$i" -lt "$attempts" ] && sleep $((delay * i))
done
fail "매니페스트 기록 push ${attempts}회 실패. ${lost}"
