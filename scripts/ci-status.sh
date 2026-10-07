#!/usr/bin/env bash
# ADR-120 (corrected): the CI state of main, read before every push and never waited for.
#   scripts/ci-status.sh            the last COMPLETED run of the CI workflow on main
#   scripts/ci-status.sh <run-id>   one remembered run (the own last push, from STATE.md `ci_log`): green, red or still running
# Exit 0 = green, 1 = red (failed jobs and steps are listed), 2 = unknown (gh missing, offline, no run), 3 = still running,
# 4 = superseded (a cancelled pending run; the newer run covers its commit).
set -uo pipefail

if ! command -v gh >/dev/null 2>&1; then
  echo "ci: unknown (gh not installed)"
  exit 2
fi

if [ $# -ge 1 ]; then
  run="$(gh run view "$1" --json databaseId,number,status,conclusion,headSha,displayTitle \
    --jq '"\(.databaseId)|\(.number)|\(.status)|\(.conclusion)|\(.headSha[0:7])|\(.displayTitle)"' 2>/dev/null)"
  if [ -z "$run" ]; then
    echo "ci: unknown (run $1 not found, or gh is offline)"
    exit 2
  fi
  # "|" and not a tab: read collapses empty whitespace fields (an unfinished run has no conclusion); the title is the last field.
  IFS='|' read -r id number status conclusion sha title <<<"$run"
  if [ "$status" != "completed" ]; then
    echo "ci: running — run #$number ($sha) $title (not waited for)"
    exit 3
  fi
else
  # The newest completed run among the last 20, picked here: the server-side status filter was seen returning an old run
  # (2026-10-05: run #47 instead of #70).
  run="$(gh run list --workflow CI --branch main --limit 20 \
    --json databaseId,number,status,conclusion,headSha,displayTitle \
    --jq '[.[] | select(.status == "completed" and .conclusion != "cancelled" and .conclusion != "skipped")] | sort_by(-.number) | .[0] // empty | "\(.databaseId)|\(.number)|\(.conclusion)|\(.headSha[0:7])|\(.displayTitle)"' 2>/dev/null)"
  if [ -z "$run" ]; then
    echo "ci: unknown (no completed run on main, or gh is offline)"
    exit 2
  fi
  IFS='|' read -r id number conclusion sha title <<<"$run"
fi

running="$(gh run list --workflow CI --branch main --status in_progress --limit 1 --json number --jq '.[0].number // empty' 2>/dev/null)"
note=""
[ -n "$running" ] && [ "$running" != "$number" ] && note=" (run #$running still running, not waited for)"

if [ "$conclusion" = "success" ]; then
  echo "ci: green — run #$number ($sha) $title$note"
  exit 0
fi
# A pending run on main is replaced by a newer push (GitHub keeps one pending run per concurrency group): not a failure, the
# newer run covers this commit too.
if [ "$conclusion" = "cancelled" ]; then
  echo "ci: superseded — run #$number ($sha) was replaced by a newer run that includes it$note"
  exit 4
fi

echo "ci: red — run #$number ($sha, $conclusion) $title$note"
gh run view "$id" --json jobs \
  --jq '.jobs[] | select(.conclusion != "success" and .conclusion != "skipped") | "  \(.name): \(.conclusion) — " + ([.steps[] | select(.conclusion == "failure") | .name] | join(", "))' 2>/dev/null
echo "  logs: gh run view $id --log-failed"
exit 1
