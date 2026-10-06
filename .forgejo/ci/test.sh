#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

npm_config_ignore_scripts=true
npm_config_script_shell="$(command -v bash)"
export npm_config_ignore_scripts npm_config_script_shell
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir tests/pi-073 install --ignore-workspace --ignore-scripts --frozen-lockfile
pnpm run verify
git diff --exit-code
