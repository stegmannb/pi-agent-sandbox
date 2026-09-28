# Trusted protection snapshots

The running sandbox extension handles `pasa:protection:snapshot:v1` on Pi's local
EventBus. This is a trusted SDK-host API. It is never registered as a model tool,
does not execute a prompt, and does not enumerate other protections. The host must
obtain its complete protection inventory from its actual live ResourceLoader.
Types are exported from `protection.ts`.

## Loading

Use Node 22.18 or newer with synchronous module hooks and native type stripping.
Start a fresh process with the source capture bootstrap **before importing the
SDK or loading any extensions**:

```sh
node --import /absolute/pi-agent-sandbox/protection-source.mjs host.mjs
```

Before `ResourceLoader.reload()`, bind the native entry to the host's real SDK
installation. This is needed for a production sandbox package, where Pi is a peer
dependency supplied by the host rather than a private bundled SDK:

```js
import { fileURLToPath } from "node:url";
process.env.PASA_SANDBOX_PI_ENTRY = fileURLToPath(
  import.meta.resolve("@mariozechner/pi-coding-agent"),
);
```

Pass the same path setting to the child. The early Node hook uses this alias only
for `index.ts`'s SDK import. It captures the actual loaded SDK source closure;
no host-supplied hashes are accepted. Changing the setting invalidates readiness.
Without the setting, native Node dependency resolution applies.

Configure the real ResourceLoader to load
`/absolute/pi-agent-sandbox/pasa-extension.mjs`. This small native-module entry
loads the same `index.ts` extension as the ordinary installation. Pi's existing
Jiti loader supports this entry; no Pi patch or inline factory is needed. The
ordinary package entry remains `index.ts`. A late bootstrap, bundled loader,
transformed source, or unobserved cached dependency cannot produce readiness.
Do not replace an already loaded extension within a running session to obtain
an attestation. Restart with the documented bootstrap instead.

The bootstrap records actual Node resolution and loading, including transitive
modules, JSON dependencies, package scope presence and native addon binaries.
It compares the bytes returned by the loader with the backing file. For its own
`index.ts` and `protection.ts`, it feeds the measured bytes through Node's public
type eraser. This also supports installations under `node_modules`, where Node
otherwise disallows native TypeScript. A per-load receipt injected into the
executing native entry prevents a Jiti fallback from reusing the trace of an
unsuccessful native loading attempt. No receipt or expected digest is accepted
from the host or consumer. Native
CommonJS addons are measured at resolution, immediately before Node's `dlopen`
path. Node built-ins and system shared libraries belong to the trusted host OS,
not to the local JavaScript dependency manifest. The bootstrap itself is the
trusted measurement root. This is not remote attestation or a defense against
host code with arbitrary in-process mutation privileges.

An extension source is measured while loading, never reconstructed from a later
filesystem scan. Every response rechecks the recorded closure and package
scopes. Newly imported dependencies, edited files, new package scopes and
unobserved modules invalidate the old proof. Source references include absolute
paths and SHA-256 hashes. Hosts must run parent and child against the same
installed deployment. The Node version, platform and architecture also enter
the effective policy digest.

The bootstrap privately records each module's complete package-scope expectations
in ancestor read order, including absent paths. Each source check resolves its
real path and reads and hashes its full bytes, then freshly checks every scope
from the module directory to the filesystem root before visiting dependencies.
Shared ancestors are checked again for every module. The immutable load-time
list saves path construction, maps, sorting and JSON comparison, but never
reuses a previous check's observations. Missing load-time expectations refuse.
The public `captureScopes` result stays path-sorted, and `loadedSources.check`
still performs its separate final scope check after the graph check.

These checks are sequential observations, not an atomic filesystem snapshot.
They can detect a scope change between source reads even when it is restored
later. A change after the last relevant read may escape that invocation and is
checked afresh on the next invocation.

## Request and response

```ts
import type { SnapshotRequest } from "/absolute/pi-agent-sandbox/protection.ts";

const request: SnapshotRequest = {
  version: 1,
  requestId: crypto.randomUUID(),
  protectionId: "pi-agent-sandbox",
  expectedSessionId: session.sessionManager.getSessionId(),
  targetCwd: canonicalChildCwd,
  respond(response) {
    // Validate all IDs/version, binding, code/config/env refs and readiness.
  },
};
eventBus.emit("pasa:protection:snapshot:v1", request);
```

Only requests for this exact protection are answered. The same request ID
receives at most one response; consumers must use a fresh request ID for every
collection. The callback runs synchronously and no snapshot request changes
policy, initializes the OS sandbox, prompts the user or executes a tool.

A ready response contains `binding: { cwd, sessionId, generation }`,
`enabled: true`, `initialized: true`, `stateDigest`, `codeFiles`,
`configurationFiles`, `environment`, and
`replay: { kind: "file-backed", verifiedCwd, stateDigest }`. All hashes use
SHA-256. Policy hashes use recursively key-sorted JSON, preserve array order and
omit undefined object fields. They include the effective merged policy, canonical
cwd, home directory, platform, architecture and Node version. They do not expose
raw settings. Configuration references include only existing global/project
sandbox files; absence of either file is also captured and checked internally.

Global config resolves from `PI_CODING_AGENT_DIR` or `~/.pi/agent`, then the
project's `.pi/sandbox.json` is merged using the extension's real resolver.
Parent configuration must still match the initialized instance. The target cwd
must be canonical, have the same config-file presence/content, and resolve the
same merged policy. Relative policy paths are then interpreted in the target
cwd; its independently calculated digest is returned in `replay.stateDigest`.
The parent's binding and state remain unchanged. Global config references retain
their absolute path. For the project config, the consumer maps only the exact
parent `<binding.cwd>/.pi/sandbox.json` reference to
`<replay.verifiedCwd>/.pi/sandbox.json`, preserving the SHA-256 comparison; the
child reports its own actual path. Do not discard hashes or normalize arbitrary
paths. Relative agent-directory or SDK-entry environment paths are unsupported. New, missing, or changed target
project settings refuse replay. The child independently loads the extension,
initializes its sandbox and requests its own snapshot with its own cwd/session.
It is never passed a digest to echo.

`environment` contains hashes of path settings used by policy/runtime resolution:
`HOME`, `PI_CODING_AGENT_DIR`, `PASA_SANDBOX_PI_ENTRY`, `TMPDIR`, `TMP`, `TEMP`, `PATH`, `SHELL`,
`CLAUDE_CODE_TMPDIR`, and `CLAUDE_TMPDIR`.
No API keys, auth files or credential environment hashes are returned.
Explicit parent-proxy and MITM-proxy configurations are unsupported in v1;
they may depend on credentials or live state outside these policy files.
The existing `NODE_OPTIONS=--use-env-proxy` setup is idempotent across session
starts. Network allow/deny behavior is unchanged.

## Readiness lifecycle

Readiness requires completed `session_start`, successful SandboxManager
initialization and a successful kernel launch with its generated sandbox profile.
There is no readiness before start or after shutdown. A changed live session ID
requires a new completed start. Lifecycle changes increment generation;
asynchronous manager resets/initializations are serialized, and stale completions
cannot certify another generation.

Pending initialization returns `NOT_INITIALIZED`; initialization failures return
`INITIALIZATION_FAILED`. Existing reinitialization catches cannot preserve an old
ready flag. Bash execution while an enabled sandbox is pending or failed refuses
instead of falling back to an unsandboxed subprocess.

V1 supports only file-backed state. Any session grant/denial, grant through the
interactive permission UI, reset-session event, or toggle marks the instance as
runtime-mutated. Resetting grants or toggling back on does not restore a
file-backed proof. Disabling returns `DISABLED`; other mutations return
`RUNTIME_MUTATION`. The adapter never resets parent policy to make it replayable.
A changed live SandboxManager configuration also refuses. Other fixed refusal
codes are `SESSION_MISMATCH`, `CONFIG_DRIFT`, `CWD_UNREPRODUCIBLE`, and
`UNBACKED_CONFIGURATION`. Replies contain no exceptions or raw error messages.

Hosts must recheck the parent immediately before authorizing each first child
prompt and recheck the child immediately before every prompt. Any unsupported,
missing, duplicate or mismatched response fails closed. Apply a 5000 ms collection
deadline. The host owns transport, inventory classification and tool/role limits;
this API does not enforce them or authenticate untrusted in-process code.

## Validation

```sh
pnpm install --frozen-lockfile
pnpm --dir tests/pi-073 install --ignore-workspace --ignore-scripts --frozen-lockfile
pnpm run ci:fmt
pnpm run ci:lint
pnpm run ci:check
pnpm test
pnpm run test:loader
pnpm run test:os
```

To compare scope-check preparation against an earlier bootstrap, extract that
revision's `protection-source.mjs` and pass its absolute path to
`node tests/compare-source-capture.mjs`. The runner alternates six fresh processes
at the same fixture paths using the installed Pi 0.73 SDK. It asserts matching
source/scope digests, actual read/presence/realpath traces and refusal results,
and reports five capture and full-proof timing samples per process. Only the
bootstrap's own content differs between variants; it remains fully verified.
Timing samples run without IO instrumentation. This is a local comparison, not
a kernel-protection test or a portable latency guarantee.

Unit tests register the actual extension with controlled SandboxManager methods
for deterministic startup, race, mutation and drift cases. Loader tests use the
real Pi ResourceLoader and AgentSession APIs with both the product's locked Pi
version and a separately locked Pi 0.73.0 fixture. They compare independent child
process snapshots for another cwd, including source/config/environment hashes,
and verify the same loader refuses an unobserved closure.

The OS test uses the real manager and kernel, verifies allowed and denied writes,
and verifies an independently initialized child. On Linux it first checks that
the host permits a minimal bubblewrap user namespace. Restricted container hosts
report that limitation explicitly; they do not claim a successful kernel test.
A missing bubblewrap executable or a later sandbox failure fails the test.

The Forgejo `protection` job runs all checks above on PRs and pushes using locked
Nix tools, without publishing or release credentials. This adapter workflow is
separate from the repository's pending Tier-0 migration. The formatter/linter
patches keep their existing versions and prefer Node's positive glibc runtime
report over an Alpine host's musl `ldd`; fallback behavior remains unchanged.
