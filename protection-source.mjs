/** Trusted Node bootstrap. Preload before the SDK or any extension imports. */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as nodeModule from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const files = new Map();
const edges = new Map();
const unknown = new Set();
const scopesAtLoad = new Map();
const nativeReceipts = new Map();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bootstrap = fileURLToPath(import.meta.url);
// The Node --import bootstrap is the trusted measurement root, not an attestation
// supplied by the child or the event-bus consumer.
files.set(import.meta.url, { path: bootstrap, sha256: hash(readFileSync(bootstrap)) });

const require = createRequire(import.meta.url);
const previouslyCached = new Set(
  Object.keys(require.cache).map((path) => pathToFileURL(path).href),
);
const preloaded = process.execArgv.some((arg, index, args) => {
  const value =
    arg === "--import" ? args[index + 1] : arg.startsWith("--import=") ? arg.slice(9) : undefined;
  if (!value) return false;
  try {
    return (
      realpathSync(value.startsWith("file:") ? fileURLToPath(value) : resolve(value)) === bootstrap
    );
  } catch {
    return false;
  }
});
if (preloaded && typeof nodeModule.registerHooks === "function")
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      // The host supplies its real SDK entry when the production package has no
      // private SDK dependency. This mirrors Pi's SDK alias for this entry only.
      const sdk = process.env.PASA_SANDBOX_PI_ENTRY;
      const sandboxEntry = pathToFileURL(join(dirname(bootstrap), "index.ts")).href;
      const actualSpecifier =
        specifier === "@mariozechner/pi-coding-agent" && context.parentURL === sandboxEntry && sdk
          ? pathToFileURL(realpathSync(sdk)).href
          : specifier;
      const result = nextResolve(actualSpecifier, context);
      // Node loads CommonJS native addons through dlopen, bypassing load().
      // Capture their exact resolved binary before returning to that loader.
      if (result.url.startsWith("file:") && result.url.endsWith(".node")) {
        const path = fileURLToPath(result.url);
        if (previouslyCached.has(result.url)) unknown.add(result.url);
        if (!files.has(result.url))
          files.set(result.url, { path, sha256: hash(readFileSync(path)) });
        scopesAtLoad.set(result.url, captureScopes([{ path }]));
      }
      if (context.parentURL) {
        const deps = edges.get(context.parentURL) ?? new Set();
        deps.add(result.url);
        edges.set(context.parentURL, deps);
      }
      return result;
    },
    load(url, context, nextLoad) {
      if (url.startsWith("node:")) return nextLoad(url, context);
      if (!url.startsWith("file:")) {
        unknown.add(url);
        return nextLoad(url, context);
      }
      const path = fileURLToPath(url);
      const bytes = readFileSync(path);
      const scopes = captureScopes([{ path }]);
      scopesAtLoad.set(url, scopes);
      // Native Node normally refuses TypeScript inside node_modules. Strip only
      // our own two modules with Node's public type eraser, from measured bytes.
      // A private per-load receipt proves index.ts executed through this path;
      // a Jiti fallback after a failed native load must never reuse its trace.
      if (
        path === join(dirname(bootstrap), "index.ts") ||
        path === join(dirname(bootstrap), "protection.ts")
      ) {
        const receipt = randomUUID();
        const source = nodeModule.stripTypeScriptTypes(bytes.toString("utf8"), { mode: "strip" });
        nativeReceipts.set(url, receipt);
        files.set(url, { path, sha256: hash(bytes) });
        return {
          format: "module",
          shortCircuit: true,
          source: `import.meta.pasaReceipt = ${JSON.stringify(receipt)};\n${source}`,
        };
      }
      const result = nextLoad(url, context);
      // A transformed or otherwise unobserved module is not a source proof.
      if (result.format === "addon" && path.endsWith(".node"))
        files.set(url, { path, sha256: hash(bytes) });
      else if (result.source == null || hash(result.source) !== hash(bytes)) unknown.add(url);
      else files.set(url, { path, sha256: hash(bytes) });
      return result;
    },
  });

/** Return the observed transitive module graph, never a discovery rescan. */
export function captureSources(entry) {
  const visited = new Set();
  const refs = new Map();
  function visit(url) {
    if (url.startsWith("node:") || visited.has(url)) return;
    visited.add(url);
    const ref = files.get(url);
    if (!ref || unknown.has(url)) throw new Error(`unobserved module: ${url}`);
    if (realpathSync(ref.path) !== ref.path || hash(readFileSync(ref.path)) !== ref.sha256) {
      throw new Error("source drift");
    }
    if (
      url !== import.meta.url &&
      JSON.stringify(captureScopes([ref])) !== JSON.stringify(scopesAtLoad.get(url))
    )
      throw new Error("package scope drift");
    refs.set(ref.path, { ...ref });
    for (const child of edges.get(url) ?? []) visit(child);
  }
  visit(entry);
  // Include the trusted bootstrap, whose lifetime must match the loaded graph.
  refs.set(bootstrap, { ...files.get(import.meta.url) });
  return [...refs.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Package scopes influence module resolution; freeze their presence and bytes. */
export function captureScopes(refs) {
  const scopes = new Map();
  for (const ref of refs) {
    let directory = dirname(ref.path);
    while (true) {
      const path = join(directory, "package.json");
      if (!scopes.has(path)) scopes.set(path, existsSync(path) ? hash(readFileSync(path)) : null);
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return [...scopes].sort(([a], [b]) => a.localeCompare(b));
}

/** Match a receipt injected into an actually executing native entry. */
export function nativeEntryIsObserved(url, receipt) {
  return typeof receipt === "string" && nativeReceipts.get(url) === receipt;
}
