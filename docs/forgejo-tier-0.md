# Forgejo Tier 0

This Forgejo repository is a Tier-0 process and filesystem security boundary.
Changes to sandbox initialization, subprocess wrapping, configuration merging,
path matching, permission prompts, or Nix patches can change what an agent may
read, write, or execute.

Every Forgejo pull request must produce these exact checks on its current head:

- `ci / policy (pull_request)`
- `ci / typecheck (pull_request)`
- `ci / lint (pull_request)`
- `ci / format (pull_request)`
- `ci / test (pull_request)`
- `ci / nix (pull_request)`

The jobs are unconditional, credentialless, and run from an ephemeral copy of
the exact pull-request head. Dependency installation uses the committed pnpm
lockfile with lifecycle hooks disabled. Protected pnpm scripts cannot define
`pre*` or `post*` hooks, and each JavaScript gate selects the pinned Nix Bash
as its script shell. The test gate runs the complete `pnpm run verify`
contract, including negative configuration and path-policy fixtures. The Nix
gate evaluates all supported systems and builds both packaged extensions.

The Forgejo release profile is `none`. Forgejo workflows must not run on pushes,
create tags, publish packages, create Forgejo Releases, or receive publishing
credentials. The existing `.github/workflows/release.yml` GitHub/npm contract
is a separate external release boundary and is deliberately unchanged by
HL-0198.

After merge, the Owner must configure and read back `main` protection: direct
and administrator pushes disabled, one current approval from
`Bastian/Reviewers`, stale approvals dismissed, unresolved change requests and
official review requests blocking, all six exact contexts required, and only
rebase/fast-forward merge paths enabled. Repeat the administrative readback
after Forgejo upgrades, protection changes, and by 2026-09-30.
