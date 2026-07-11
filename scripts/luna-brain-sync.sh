#!/bin/bash
# luna-brain-sync: drains packages/kernel/.brain/.pending-commits and updates
# .brain/ via an AI subagent (kimi CLI).
#
# Behavior:
#   - Empty queue  -> prints "nothing pending" and exits 0.
#   - kimi present -> runs `kimi -p "<prompt+diffs>"` from the repo root
#                     (-p = non-interactive one-prompt mode; in this mode the
#                     agent edits files without interactive approval).
#                     On success the queue is cleared.
#   - kimi missing -> writes prompt+diffs to ~/.luna-brain-sync-last.md, KEEPS
#                     the queue intact, prints manual instructions, exits 2.
#
# Verified against kimi-code CLI (`kimi --help`): there is no --headless flag;
# `-p, --prompt` is the non-interactive mode. Note: `-p` cannot be combined
# with `--yolo` or `--auto` (CLI rejects both) — prompt mode already applies
# edits non-interactively, verified with a real file-write test.
set -euo pipefail
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
REPO_ROOT="$(git -C "$(dirname "$SCRIPT_PATH")/.." rev-parse --show-toplevel)"
BRAIN="$REPO_ROOT/packages/kernel/.brain"
PENDING="$BRAIN/.pending-commits"
FALLBACK="$HOME/.luna-brain-sync-last.md"

if [ ! -s "$PENDING" ]; then
  echo "luna-brain-sync: nothing pending."
  exit 0
fi

HASHES=$(sort -u "$PENDING")
TMP_DIFF=$(mktemp)
trap 'rm -f "$TMP_DIFF"' EXIT

for h in $HASHES; do
  git -C "$REPO_ROOT" show --stat --format="COMMIT %h %ad %s" --date=short "$h" >> "$TMP_DIFF"
  echo "---" >> "$TMP_DIFF"
done

PROMPT=$(cat "$REPO_ROOT/scripts/luna-brain-sync-prompt.md")

if command -v kimi >/dev/null 2>&1; then
  (cd "$REPO_ROOT" && kimi -p "$PROMPT

Commits to process:

$(cat "$TMP_DIFF")")
  > "$PENDING"
  echo "luna-brain-sync: done. Review .brain changes and commit them."
else
  {
    echo "$PROMPT"
    echo
    echo "Commits to process:"
    echo
    cat "$TMP_DIFF"
  } > "$FALLBACK"
  echo "luna-brain-sync: 'kimi' CLI not found." >&2
  echo "Prompt+diffs written to $FALLBACK — queue NOT cleared." >&2
  echo "Paste that file into an agent session, let it edit .brain/, then run:" >&2
  echo "  > $PENDING" >&2
  exit 2
fi
