#!/usr/bin/env bash
# ADR-120: the CI state of main at the start of every loop. Reads the last COMPLETED run of the CI workflow on main and never
# waits for a running one. Exit 0 = green, 1 = red (failed jobs and steps are listed), 2 = unknown (gh missing, offline, no run).
set -u

if ! command -v gh >/dev/null 2>&1; then
  echo "ci: unknown (gh not installed)"
  exit 2
fi

run="$(gh run list --workflow CI --branch main --status completed --limit 1 \
  --json databaseId,number,conclusion,headSha,displayTitle \
  --jq '.[0] | "\(.databaseId)\t\(.number)\t\(.conclusion)\t\(.headSha[0:7])\t\(.displayTitle)"' 2>/dev/null)"
if [ -z "$run" ]; then
  echo "ci: unknown (no completed run on main, or gh is offline)"
  exit 2
fi

IFS=$'\t' read -r id number conclusion sha title <<<"$run"
running="$(gh run list --workflow CI --branch main --status in_progress --limit 1 --json number --jq '.[0].number // empty' 2>/dev/null)"
note=""
[ -n "$running" ] && note=" (run #$running still running, not waited for)"

if [ "$conclusion" = "success" ]; then
  echo "ci: green — run #$number ($sha) $title$note"
  exit 0
fi

echo "ci: red — run #$number ($sha, $conclusion) $title$note"
gh run view "$id" --json jobs \
  --jq '.jobs[] | select(.conclusion != "success" and .conclusion != "skipped") | "  \(.name): \(.conclusion) — " + ([.steps[] | select(.conclusion == "failure") | .name] | join(", "))' 2>/dev/null
echo "  logs: gh run view $id --log-failed"
exit 1
