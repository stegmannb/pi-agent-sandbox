# pi-sandbox

Sandbox for [pi](https://pi.dev/).

Sandboxes pi like this:

- read/write/edit: direct control using allow/deny lists
- bash: uses [Anthropic Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime) to control network and file system access

When a blocked action is attempted, the user is
prompted to allow it temporarily or permanently rather than silently failing.

![demo](./demo/demo.gif)

## Notes

There is an example config at [sandbox.json](./sandbox.json). It was quite a few things added to get this extension to work with [agent-browser](https://agent-browser.dev/) and other common tools.

These open significant security loopholes, so shouldn't be used in a sensitive context or when you don't need browser support.

You may need to trial and error to find additional things you need to allow.

## Quickstart

#### Development environment

```bash
direnv allow
devenv shell
```

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
  "allowBrowserProcess": true, // If you want to use agent-browser or similar Chrome setup
  "network": {
    "allowLocalBinding": true, // ditto
    "allowAllUnixSockets": true, // ditto
    "allowedDomains": ["github.com", "*.github.com"],
    "deniedDomains": []
  },
  "filesystem": {
    // For READS:
    // - ANY read is prompted unless the path is already in allowRead
    // - Granting a prompt adds to allowRead, which overrides denyRead
    // - denyRead is not a hard-block; it just marks regions as denied by default
    "denyRead": ["/Users", "/home"],
    "allowRead": [".", "~/.config", "~/.local", "Library"],

    // For WRITES:
    // - empty ALLOW means no write access at all
    // - DENY takes precedence and is never prompted
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

### Config validation and error behavior

The extension validates the structure of every config file it reads. If a
file cannot be parsed as JSON or contains a field with the wrong type (e.g.
`"enabled": "yes"` instead of `true`, or `"allowedDomains"` containing a
non-string entry), the extension:

1. Shows an `error` notification immediately — **sandbox stays disabled** for
   the session instead of silently falling back to defaults.
2. Names the exact file and field that is invalid in the error message.

This prevents a misconfigured file from creating a false sense of security
(user believes the sandbox is active when it is not).

To fix a broken config, edit the file at the path shown in the error message
and restart the session (or run `/sandbox-enable` once the file is valid).

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

| Rule                           | Behaviour                                           |
| ------------------------------ | --------------------------------------------------- |
| Domain not in `allowedDomains` | Prompted (bash and `!cmd`)                          |
| Path not in `allowRead`        | Prompted (read tool); granting adds to `allowRead`  |
| Path not in `allowWrite`       | Prompted (write/edit tools and bash write failures) |
| Path in `denyWrite`            | Hard-blocked, no prompt                             |
| Domain in `deniedDomains`      | Hard-blocked at OS level, no prompt                 |

If a path is added to `allowWrite` via a prompt but is also present in
`denyWrite`, it remains blocked. A warning is shown explaining which config
files to check.

`allowedDomains` supports `*.example.com` wildcards. `allowWrite` uses prefix
matching, so `.` covers the entire current working directory.

> **⚠️ Read and write have different precedence rules:**
>
> - **Read:** Every read is prompted unless the path is already in `allowRead`.
>   `denyRead` is not a hard-block — it marks regions as denied by default, but
>   granting a prompt adds the path to `allowRead`, overriding `denyRead`.
> - **Write:** `denyWrite` takes precedence over `allowWrite` and is never
>   prompted. A path in `denyWrite` is always blocked, even if it matches
>   `allowWrite`.

If neither file exists, built-in defaults apply (see above for the defaults).

The footer shows a lock indicator while the sandbox is active.

## Ackowledgements

Based on code from
[badlogic/pi-mono](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts)
by Mario Zechner, used under the
[MIT License](https://github.com/badlogic/pi-mono/blob/main/LICENSE).

## Development

- `devenv.nix` defines the project development environment
- `devenv.yaml` pins devenv inputs
- `devenv.lock` is generated via `devenv update`
- `.envrc` wires direnv to devenv

Run `pnpm install` once after entering the shell, then validate with:

```bash
pnpm run ci:fmt
pnpm run ci:lint
pnpm run ci:check
```
