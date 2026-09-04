#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

event_args=()
if [ "$#" -gt 0 ]; then
  event_args=(--event "$1")
fi

actionlint \
  -config-file .github/actionlint.yaml \
  -ignore 'specifying action "https://[^" ]+@[0-9a-f]+" in invalid format' \
  .forgejo/workflows/ci.yml
bash -n .forgejo/ci/*.sh
shellcheck .forgejo/ci/*.sh
python hack/tier0_policy.py "${event_args[@]}"
python -m unittest discover -s test -p 'test_tier0_policy.py'
ruff format --check hack test/test_tier0_policy.py
ruff check hack test/test_tier0_policy.py
