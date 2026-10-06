import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./sync-mirror.mjs", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "git-mirror-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, "work");
  const left = join(root, "forgejo.git");
  const right = join(root, "github.git");
  const git = (args, cwd = work) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  mkdirSync(work);
  git(["init", "--initial-branch=main"]);
  git(["config", "user.name", "Mirror test"]);
  git(["config", "user.email", "mirror-test@localhost"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["config", "tag.gpgsign", "false"]);
  git(["init", "--bare", "--initial-branch=main", left]);
  git(["init", "--bare", "--initial-branch=main", right]);
  git(["remote", "add", "forgejo", left]);
  git(["remote", "add", "github", right]);
  const commit = (message) => {
    writeFileSync(join(work, "content"), message);
    git(["add", "content"]);
    git(["commit", "-m", message]);
    return git(["rev-parse", "HEAD"]);
  };
  const seed = commit("initial");
  git(["push", "forgejo", "main"]);
  git(["push", "github", "main"]);
  const sync = (...args) =>
    spawnSync(process.execPath, [script, ...args], { cwd: work, encoding: "utf8" });
  const success = (...args) => {
    const result = sync(...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result;
  };
  const ref = (remote, name) => git(["show-ref", "--hash", name], remote);
  const checkpoint = () => ref(left, "refs/mirror/checkpoint");
  return { work, left, right, git, commit, seed, sync, success, ref, checkpoint };
}

test("fast-forwards commits in both directions and remains idempotent", (t) => {
  const f = fixture(t);
  f.success();
  const a = f.commit("from Forgejo");
  f.git(["push", "forgejo", "main"]);
  f.success();
  assert.equal(f.ref(f.right, "refs/heads/main"), a);
  const b = f.commit("from GitHub");
  f.git(["push", "github", "main"]);
  f.success();
  assert.equal(f.ref(f.left, "refs/heads/main"), b);
  const state = f.checkpoint();
  f.success();
  assert.equal(f.checkpoint(), state);
});

test("copies release branches from either side and excludes development branches", (t) => {
  const f = fixture(t);
  f.git(["push", "forgejo", "main:release/from-forgejo", "main:private/development"]);
  f.git(["push", "github", "main:release/from-github"]);
  f.success();
  assert.equal(f.ref(f.right, "refs/heads/release/from-forgejo"), f.seed);
  assert.equal(f.ref(f.left, "refs/heads/release/from-github"), f.seed);
  assert.throws(() => f.ref(f.right, "refs/heads/private/development"));
});

test("synchronizes correctly from an Actions-style shallow checkout", (t) => {
  const f = fixture(t);
  const next = f.commit("source update after shallow boundary");
  f.git(["push", "forgejo", "main"]);
  const shallow = join(f.work, "shallow");
  f.git(["clone", "--depth=1", "--origin=forgejo", `file://${f.left}`, shallow]);
  f.git(["remote", "add", "github", f.right], shallow);
  assert.equal(f.git(["rev-parse", "--is-shallow-repository"], shallow), "true");
  const result = spawnSync(process.execPath, [script], { cwd: shallow, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.ref(f.right, "refs/heads/main"), next);
});

test("propagates a previously synchronized deletion in each direction", (t) => {
  const f = fixture(t);
  f.git(["push", "forgejo", "main:release/delete-left", "main:release/delete-right"]);
  f.success();
  f.git(["push", "forgejo", ":release/delete-left"]);
  f.git(["push", "github", ":release/delete-right"]);
  f.success();
  for (const remote of [f.left, f.right]) {
    assert.throws(() => f.ref(remote, "refs/heads/release/delete-left"));
    assert.throws(() => f.ref(remote, "refs/heads/release/delete-right"));
  }
});

test("stops before any writes when commits diverge", (t) => {
  const f = fixture(t);
  f.success();
  const state = f.checkpoint();
  const a = f.commit("left change");
  f.git(["push", "forgejo", "main", "main:release/new"]);
  f.git(["checkout", "-B", "other", f.seed]);
  const b = f.commit("right change");
  f.git(["push", "github", "HEAD:main"]);
  const result = f.sync();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /branches have diverged/);
  assert.equal(f.ref(f.left, "refs/heads/main"), a);
  assert.equal(f.ref(f.right, "refs/heads/main"), b);
  assert.throws(() => f.ref(f.right, "refs/heads/release/new"));
  assert.equal(f.checkpoint(), state);
});

test("preserves changes when the other side deletes the branch", (t) => {
  const f = fixture(t);
  f.git(["push", "forgejo", "main:release/conflict"]);
  f.success();
  const state = f.checkpoint();
  f.git(["push", "forgejo", ":release/conflict"]);
  const changed = f.commit("changed release");
  f.git(["push", "github", "main:release/conflict"]);
  const result = f.sync();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /deleted on one side and changed/);
  assert.equal(f.ref(f.right, "refs/heads/release/conflict"), changed);
  assert.equal(f.checkpoint(), state);
});

test("reports a unilateral history rewrite without restoring or overwriting it", (t) => {
  const f = fixture(t);
  const newer = f.commit("newer");
  f.git(["push", "forgejo", "main"]);
  f.success();
  f.git(["push", "--force-with-lease", "github", `${f.seed}:main`]);
  const result = f.sync();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /history was rewritten/);
  assert.equal(f.ref(f.left, "refs/heads/main"), newer);
  assert.equal(f.ref(f.right, "refs/heads/main"), f.seed);
});

test("mirrors annotated and lightweight tags when selected and propagates deletions", (t) => {
  const f = fixture(t);
  f.git(["tag", "-a", "v1", "-m", "version one"]);
  f.git(["tag", "v2"]);
  f.git(["push", "forgejo", "refs/tags/v1"]);
  f.git(["push", "github", "refs/tags/v2"]);
  f.success("--tag", "*");
  assert.equal(f.ref(f.right, "refs/tags/v1"), f.ref(f.left, "refs/tags/v1"));
  assert.equal(f.ref(f.left, "refs/tags/v2"), f.seed);
  f.git(["push", "github", ":refs/tags/v1"]);
  f.success("--tag", "*");
  assert.throws(() => f.ref(f.left, "refs/tags/v1"));
});

test("stops on differing tags and scope changes", (t) => {
  const f = fixture(t);
  f.git(["tag", "v1"]);
  f.git(["push", "forgejo", "refs/tags/v1"]);
  f.success("--tag", "*");
  f.commit("other tag target");
  f.git(["tag", "-f", "v1"]);
  f.git(["push", `--force-with-lease=refs/tags/v1:${f.seed}`, "github", "refs/tags/v1"]);
  assert.match(f.sync("--tag", "*").stderr, /different tag objects/);
  assert.match(f.sync().stderr, /Mirror selection changed/);
});

test("dry run does not write refs or a checkpoint", (t) => {
  const f = fixture(t);
  const next = f.commit("dry-run change");
  f.git(["push", "github", "main"]);
  const result = f.success("--dry-run");
  assert.equal(JSON.parse(result.stdout).synchronized["refs/heads/main"], next);
  assert.equal(f.ref(f.left, "refs/heads/main"), f.seed);
  assert.throws(() => f.checkpoint());
});

test("recovers after a remote rejects a write and keeps the old checkpoint", (t) => {
  const f = fixture(t);
  f.success();
  const state = f.checkpoint();
  const next = f.commit("pending change");
  f.git(["push", "github", "main"]);
  const hook = join(f.left, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  assert.equal(f.sync().status, 1);
  assert.equal(f.checkpoint(), state);
  rmSync(hook);
  f.success();
  assert.equal(f.ref(f.left, "refs/heads/main"), next);
});

test("a stale destination lease rejects a concurrent update", (t) => {
  const f = fixture(t);
  f.success();
  const state = f.checkpoint();
  const next = f.commit("mirror source update");
  f.git(["push", "forgejo", "main"]);
  f.git(["checkout", "-B", "race", f.seed]);
  const competing = f.commit("concurrent destination update");
  f.git(["push", "github", "race"]);
  // Mutate GitHub's main between fetch and push using a local pre-push hook.
  const hook = join(f.work, ".git", "hooks", "pre-push");
  writeFileSync(
    hook,
    `#!/bin/sh\nif [ "$1" = github ]; then\n  git --git-dir='${f.right}' update-ref refs/heads/main ${competing}\nfi\n`,
    { mode: 0o755 },
  );
  const result = f.sync();
  assert.equal(result.status, 1);
  assert.equal(f.ref(f.right, "refs/heads/main"), competing);
  assert.equal(f.ref(f.left, "refs/heads/main"), next);
  assert.equal(f.checkpoint(), state);
});

test("recovers a partial sync across two remotes without losing either change", (t) => {
  const f = fixture(t);
  f.git(["push", "forgejo", "main:release/other"]);
  f.success();
  const state = f.checkpoint();
  const a = f.commit("Forgejo main update");
  f.git(["push", "forgejo", "main"]);
  f.git(["checkout", "-B", "other", f.seed]);
  const b = f.commit("GitHub release update");
  f.git(["push", "github", "HEAD:release/other"]);
  const hook = join(f.left, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  assert.equal(f.sync().status, 1);
  assert.equal(f.ref(f.right, "refs/heads/main"), a);
  assert.equal(f.ref(f.left, "refs/heads/release/other"), f.seed);
  assert.equal(f.checkpoint(), state);
  rmSync(hook);
  f.success();
  assert.equal(f.ref(f.left, "refs/heads/main"), a);
  assert.equal(f.ref(f.left, "refs/heads/release/other"), b);
  assert.equal(f.ref(f.right, "refs/heads/main"), a);
  assert.equal(f.ref(f.right, "refs/heads/release/other"), b);
});
