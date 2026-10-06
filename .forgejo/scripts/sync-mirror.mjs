import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const STATE_REF = "refs/mirror/checkpoint";

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
    ...options,
  }).trim();
}

function matches(name, patterns) {
  return patterns.some((pattern) => {
    const regex = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${regex}$`).test(name);
  });
}

function selected(ref, config) {
  if (ref.startsWith("refs/heads/")) {
    return matches(ref.slice("refs/heads/".length), config.branches);
  }
  if (ref.startsWith("refs/tags/")) {
    return matches(ref.slice("refs/tags/".length), config.tags);
  }
  return false;
}

function remoteRefs(remote, config) {
  const output = git(["ls-remote", "--refs", remote, "refs/heads/*", "refs/tags/*"]);
  return Object.fromEntries(
    output
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t"))
      .filter(([, ref]) => selected(ref, config))
      .map(([oid, ref]) => [ref, oid]),
  );
}

function fetchRefs(remote, config) {
  const prefix = `refs/mirror-fetch/${remote}/`;
  git([
    "fetch",
    ...(git(["rev-parse", "--is-shallow-repository"]) === "true" ? ["--unshallow"] : []),
    "--quiet",
    "--no-tags",
    "--prune",
    remote,
    `+refs/heads/*:${prefix}heads/*`,
    `+refs/tags/*:${prefix}tags/*`,
  ]);
  const output = git(["for-each-ref", "--format=%(refname) %(objectname)", prefix]);
  return Object.fromEntries(
    output
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" "))
      .map(([ref, oid]) => [ref.replace(prefix, "refs/"), oid])
      .filter(([ref]) => selected(ref, config)),
  );
}

function ancestor(older, newer) {
  try {
    git(["merge-base", "--is-ancestor", older, newer]);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function readState(remote, config) {
  const advertised = git(["ls-remote", "--refs", remote, STATE_REF]);
  if (!advertised) return { oid: undefined, refs: {} };
  git(["fetch", "--quiet", "--no-tags", remote, `+${STATE_REF}:${STATE_REF}`]);
  const oid = git(["rev-parse", STATE_REF]);
  const state = JSON.parse(git(["show", `${oid}:state.json`]));
  if (state.version !== 1 || JSON.stringify(state.config) !== JSON.stringify(config)) {
    throw new Error("Mirror selection changed. Review the checkpoint before changing its scope.");
  }
  return { oid, refs: state.refs };
}

function plan(left, right, previous) {
  const result = {};
  const conflicts = [];
  for (const ref of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
    const a = left[ref];
    const b = right[ref];
    const old = previous[ref];
    if (a === b) {
      result[ref] = a;
    } else if (!a || !b) {
      const present = a || b;
      if (!old) result[ref] = present;
      else if (old !== present)
        conflicts.push(`${ref}: deleted on one side and changed on the other`);
      // A missing ref that existed at the checkpoint is a deletion.
    } else if (ref.startsWith("refs/tags/")) {
      conflicts.push(`${ref}: different tag objects`);
    } else if (old && (!ancestor(old, a) || !ancestor(old, b))) {
      conflicts.push(`${ref}: history was rewritten since the checkpoint`);
    } else if (ancestor(a, b)) {
      result[ref] = b;
    } else if (ancestor(b, a)) {
      result[ref] = a;
    } else {
      conflicts.push(`${ref}: branches have diverged`);
    }
  }
  if (conflicts.length) throw new Error(`Mirror conflicts:\n${conflicts.join("\n")}`);
  return result;
}

function sameRefs(a, b) {
  const sorted = (refs) => Object.entries(refs).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}

function writeState(config, refs, parent) {
  const content = `${JSON.stringify({ version: 1, config, refs }, null, 2)}\n`;
  const blob = git(["hash-object", "-w", "--stdin"], { input: content });
  const tree = git(["mktree"], { input: `100644 blob ${blob}\tstate.json\n` });
  const args = ["commit-tree", tree];
  if (parent) args.push("-p", parent);
  return git(args, {
    input: "chore(mirror): record synchronized refs\n",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Repository mirror",
      GIT_AUTHOR_EMAIL: "mirror@localhost",
      GIT_COMMITTER_NAME: "Repository mirror",
      GIT_COMMITTER_EMAIL: "mirror@localhost",
    },
  });
}

function pushRefs(remote, before, after, extra = []) {
  const updates = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((ref) => before[ref] !== after[ref])
    .map((ref) => ({ ref, before: before[ref], after: after[ref] }));
  updates.push(...extra);
  if (!updates.length) return;
  // Every write compares the destination with the fetched snapshot, including
  // creates and deletes. The planner permits only fast-forward branch updates.
  git([
    "push",
    "--atomic",
    ...updates.map(({ ref, before }) => `--force-with-lease=${ref}:${before || ""}`),
    remote,
    ...updates.map(({ ref, after }) => `${after || ""}:${ref}`),
  ]);
  for (const { ref, after } of updates) {
    console.log(`${remote}: ${ref} ${after ? `-> ${after}` : "deleted"}`);
  }
}

try {
  const { values } = parseArgs({
    options: {
      left: { type: "string", default: "forgejo" },
      right: { type: "string", default: "github" },
      branch: { type: "string", multiple: true, default: ["main", "release/*"] },
      tag: { type: "string", multiple: true, default: [] },
      "dry-run": { type: "boolean", default: false },
    },
  });
  // Remote names are used in local ref namespaces. URLs belong in git config.
  if (![values.left, values.right].every((name) => /^[a-zA-Z0-9_-]+$/.test(name))) {
    throw new Error("Use named Git remotes for --left and --right.");
  }
  if (values.left === values.right) throw new Error("Two different remotes are required.");
  const config = {
    left: git(["remote", "get-url", values.left]),
    right: git(["remote", "get-url", values.right]),
    branches: values.branch,
    tags: values.tag,
  };
  // The checkpoint must never persist authentication embedded in remote URLs.
  if ([config.left, config.right].some((url) => /^https?:\/\/[^/]*@/.test(url))) {
    throw new Error("Use SSH or a credential helper instead of credentials in remote URLs.");
  }
  const state = readState(values.left, config);
  const left = fetchRefs(values.left, config);
  const right = fetchRefs(values.right, config);
  const refs = plan(left, right, state.refs);
  if (values["dry-run"]) {
    console.log(JSON.stringify({ left, right, synchronized: refs }, null, 2));
  } else {
    pushRefs(values.right, right, refs);
    pushRefs(values.left, left, refs);
    if (
      !sameRefs(remoteRefs(values.left, config), refs) ||
      !sameRefs(remoteRefs(values.right, config), refs)
    ) {
      throw new Error(
        "A remote changed during synchronization. Retry after checking both remotes.",
      );
    }
    if (!state.oid || !sameRefs(state.refs, refs)) {
      const oid = writeState(config, refs, state.oid);
      pushRefs(values.left, {}, {}, [{ ref: STATE_REF, before: state.oid, after: oid }]);
    }
    console.log("Both remotes match the mirror checkpoint.");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
