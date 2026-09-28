import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { captureSources, captureScopes } from "./protection-source.mjs";

export const SNAPSHOT_CHANNEL = "pasa:protection:snapshot:v1";
export const PROTECTION_ID = "pi-agent-sandbox";
export type Ref = { path: string; sha256: string };
export type Reason =
  | "NOT_INITIALIZED"
  | "DISABLED"
  | "SESSION_MISMATCH"
  | "RUNTIME_MUTATION"
  | "CONFIG_DRIFT"
  | "CWD_UNREPRODUCIBLE"
  | "INITIALIZATION_FAILED"
  | "UNBACKED_CONFIGURATION";
export interface SnapshotRequest {
  version: 1;
  requestId: string;
  protectionId: "pi-agent-guard" | "pi-agent-sandbox";
  expectedSessionId: string;
  targetCwd: string;
  respond: (response: SnapshotResponse) => void;
}
export type SnapshotResponse = {
  version: 1;
  requestId: string;
  protectionId: typeof PROTECTION_ID;
} & (
  | { status: "unsupported"; reason: Reason }
  | {
      status: "ready";
      binding: { cwd: string; sessionId: string; generation: number };
      enabled: true;
      initialized: true;
      stateDigest: string;
      codeFiles: Ref[];
      configurationFiles: Ref[];
      environment: { name: string; sha256: string }[];
      replay: { kind: "file-backed"; verifiedCwd: string; stateDigest: string };
    }
);

export function digest(value: unknown): string {
  const canonical = (v: any): any =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .filter((k) => v[k] !== undefined)
              .map((k) => [k, canonical(v[k])]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value) ?? null))
    .digest("hex");
}
const hashFile = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
export function configuration(paths: string[]): [string, string | null][] {
  return paths.map((path) => [path, existsSync(path) ? hashFile(path) : null]);
}
export function environment() {
  // Only path settings used by policy/runtime resolution. Never hash credentials,
  // proxies, API keys, or the arbitrary contents of NODE_OPTIONS.
  return [
    "HOME",
    "PI_CODING_AGENT_DIR",
    "PASA_SANDBOX_PI_ENTRY",
    "TMPDIR",
    "TMP",
    "TEMP",
    "PATH",
    "SHELL",
    "CLAUDE_CODE_TMPDIR",
    "CLAUDE_TMPDIR",
  ].map((name) => ({ name, sha256: digest(process.env[name] ?? null) }));
}
export function effectiveState(config: unknown, cwd: string): string {
  return digest({
    config,
    cwd,
    home: homedir(),
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
  });
}

// Captured while the actual extension module is loading, before any session.
// Late bootstrap, Jiti transforms, cached unobserved modules and bundles refuse.
export function loadedSources(entry: string) {
  try {
    const refs = captureSources(entry);
    const scopes = captureScopes(refs);
    return {
      refs: [
        ...refs,
        ...scopes
          .filter((entry): entry is [string, string] => entry[1] !== null)
          .map(([path, sha256]) => ({ path, sha256 })),
      ]
        .filter((ref, i, all) => all.findIndex((other) => other.path === ref.path) === i)
        .sort((a, b) => a.path.localeCompare(b.path)),
      check: () =>
        digest(captureSources(entry)) === digest(refs) &&
        digest(captureScopes(refs)) === digest(scopes),
    };
  } catch {
    return undefined;
  }
}
export function canonicalCwd(path: string): string {
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) throw new Error("cwd is not a directory");
  return canonical;
}
