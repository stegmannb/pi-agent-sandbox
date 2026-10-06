# Git mirror

The mirror runs hourly and on manual dispatch. Remote URLs, pinned host keys
and branch/tag selections are supplied through repository Actions variables.
The dedicated deploy key is stored in `TWO_WAY_MIRROR_SSH_KEY`.

The [shared technical reference](https://github.com/stegmannb/pi-agent-subagents/blob/main/docs/repository-mirror.md)
documents the algorithm, checkpoint, conflict rules and parameterized deployment
interface. Run this copy's integration tests with
`node --test .forgejo/scripts/sync-mirror.test.mjs`.
