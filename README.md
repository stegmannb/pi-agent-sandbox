# pi-sandbox

Sandbox for [pi](https://pi.dev/).

Sandboxes pi like this:
- read/write/edit: direct control using allow/deny lists
- bash: uses [Anthropic Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime) to control network and file system access

When a blocked action is attempted, the user is
prompted to allow it temporarily or permanently rather than silently failing.

![demo](./demo/demo.gif)

## Quickstart
#### Install
```bash
pi install npm:pi-sandbox
```

#### Configure
Add a config like this either to `~/.pi/agent` (global) or to `.pi/sandbox.json` (local).
Local config takes precedence over global.

Note below that the order of precedence for filesystem read and write are opposite.

```json
{
  "enabled": true,
  "network": {
    "allowedDomains": ["github.com", "*.github.com"],
    "deniedDomains": []
  },
  "filesystem": {
    // For READS:
    // - empty DENY means full system read access
    // - ALLOW takes precedence
    "denyRead": ["/Users", "/home"],
    "allowRead": [".", "~/.config", "~/.local", "Library"],

    // For WRITES:
    // - empty ALLOW means no write access at all
    // - DENY takes precedence
    "allowWrite": [".", "/tmp"],
    "denyWrite": [".env", ".env.*", "*.pem", "*.key"]
  }
}
```

#### Usage

```
pi --no-sandbox          disable sandboxing for the session
/sandbox                 show current configuration and session allowances
```

## What it does

**Bash commands** are wrapped with `sandbox-exec` (macOS) or `bubblewrap`
(Linux) to enforce network and filesystem restrictions at the OS level.

**Read, write, and edit tool calls** are intercepted before execution and
checked against the same filesystem policy. The OS-level sandbox cannot cover
these tools because they run directly in the Node.js process rather than in a
subprocess.

When a block is triggered, a prompt appears with four options:

- Abort (keep blocked)
- Allow for this session only
- Allow for this project — written to `.pi/sandbox.json`
- Allow for all projects — written to `~/.pi/agent/sandbox.json`

**Session allowances** are held in memory only. They are never written to disk
and the agent has no way to read or modify them. They are reset when the
extension reloads or pi restarts.

### What is prompted vs. hard-blocked

| Rule | Behaviour |
|------|-----------|
| Domain not in `allowedDomains` | Prompted (bash and `!cmd`) |
| Path not in `allowWrite` | Prompted (write/edit tools and bash write failures) |
| Path in `denyRead` (and not in `allowRead`) | Hard-blocked, no prompt |
| Path in `denyWrite` | Hard-blocked, no prompt |
| Domain in `deniedDomains` | Hard-blocked at OS level, no prompt |

If a path is added to `allowWrite` via a prompt but is also present in
`denyWrite`, it remains blocked. A warning is shown explaining which config
files to check.

`allowedDomains` supports `*.example.com` wildcards. `allowWrite` uses prefix
matching, so `.` covers the entire current working directory.

> **⚠️ Read and write have opposite precedence rules:**
>
> - **Read:** `allowRead` takes precedence over `denyRead`. This lets you deny
>   broad regions like `/Users` while re-allowing the workspace with
>   `allowRead: ["."]`.
> - **Write:** `denyWrite` takes precedence over `allowWrite`. A path in
>   `denyWrite` is always blocked, even if it matches `allowWrite`.

If neither file exists, built-in defaults apply (see above for the defaults).

The footer shows a lock indicator while the sandbox is active.

## Ackowledgements
Based on code from
[badlogic/pi-mono](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts)
by Mario Zechner, used under the
[MIT License](https://github.com/badlogic/pi-mono/blob/main/LICENSE).
