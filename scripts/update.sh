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

  local backup
  backup="$(mktemp -t jobplug-manifest)"
  cp "$manifest" "$backup"
  echo "Saved your manifest.json"

  local tmp
  tmp="$(mktemp -d -t jobplug)"
  echo "Downloading $branch …"
  curl -fsSL -o "$tmp/jobplug.zip" \
    "https://github.com/$repo/archive/refs/heads/$branch.zip"

  echo "Unpacking over $root"
  ( cd "$parent" && unzip -oq "$tmp/jobplug.zip" )

  cp "$backup" "$manifest"
  rm -rf "$tmp" "$backup"

  local client
  client="$(grep -o '"client_id"[^,]*' "$manifest" | head -1)"
  echo
  echo "Done. Your OAuth client is intact: $client"
  echo
  echo "Next:"
  echo "  1. chrome://extensions  ->  reload JobPlug (the circular arrow)"
  echo "  2. Reload any job tab you have open — content scripts only inject"
  echo "     into pages loaded after the extension reloads."
}

main "$@"
