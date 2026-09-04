#!/usr/bin/env bash
#
# Update an unpacked JobPlug install in place.
#
# Two things must not change, or Chrome and Google stop agreeing with each other:
#   · the extension folder path — Chrome derives the extension ID from it, and
#     the OAuth client is registered against that ID
#   · oauth2.client_id in manifest.json — your own client, which a fresh
#     download would overwrite with the placeholder
#
# So this downloads over the existing folder and puts your manifest back.
#
# Usage:  bash scripts/update.sh
#
# The whole body is a function so bash parses it before the download replaces
# this file underneath the running shell.
set -euo pipefail

main() {
  local branch="claude/job-app-tracker-extension-dajhwt"
  local repo="sofiatofigh0/jobplug"

  local script_dir root parent folder
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  root="$(dirname "$script_dir")"
  parent="$(dirname "$root")"
  folder="$(basename "$root")"

  local manifest="$root/extension/manifest.json"
  [ -f "$manifest" ] || { echo "No extension/manifest.json under $root" >&2; exit 1; }

  local expected="jobplug-${branch//\//-}"
  if [ "$folder" != "$expected" ]; then
    echo "This folder is named '$folder', but the download expands to '$expected'."
    echo "Rename it back, or update manually — unzipping elsewhere changes the"
    echo "extension ID and breaks your OAuth client." >&2
    exit 1
  fi

  # Carry forward only the two fields that are yours. Restoring the whole file
  # would also restore its content_scripts list, silently reverting any fix
  # shipped in the manifest itself - which is exactly what happened once.
  local client key
  client="$(sed -n 's/.*"client_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -1)"
  key="$(sed -n 's/.*"key"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest" | head -1)"
  echo "Keeping your OAuth client ID${key:+ and pinned extension key}"

  local tmp
  tmp="$(mktemp -d -t jobplug)"
  echo "Downloading $branch ..."
  curl -fsSL -o "$tmp/jobplug.zip" \
    "https://github.com/$repo/archive/refs/heads/$branch.zip"

  echo "Unpacking over $root"
  ( cd "$parent" && unzip -oq "$tmp/jobplug.zip" )

  awk -v k="$key" -v c="$client" '
    { if (c != "" && $0 ~ /"client_id"/) sub(/"client_id"[ \t]*:[ \t]*"[^"]*"/, "\"client_id\": \"" c "\"") }
    { print }
    /"version"[ \t]*:/ { if (k != "" && !done) { print "  \"key\": \"" k "\","; done=1 } }
  ' "$manifest" > "$manifest.tmp" && mv "$manifest.tmp" "$manifest"
  rm -rf "$tmp"

  echo
  echo "Done. Client ID: $(sed -n 's/.*"client_id": "\([^"]*\)".*/\1/p' "$manifest")"
  echo "Injected scripts: $(sed -n 's/.*"src\/content\/detector.js".*/ok/p' "$manifest" | head -1)"
  echo
  echo "Next:"
  echo "  1. chrome://extensions  ->  reload JobPlug (the circular arrow)"
  echo "  2. Reload any job tab you have open — content scripts only inject"
  echo "     into pages loaded after the extension reloads."
}

main "$@"
