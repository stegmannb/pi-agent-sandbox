import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (process.platform === "linux") {
  const capability = spawnSync(
    "bwrap",
    ["--unshare-user", "--unshare-pid", "--ro-bind", "/", "/", "true"],
    { encoding: "utf8" },
  );
  if (capability.error) throw capability.error;
  if (capability.status !== 0) {
    console.log(
      "OS integration unavailable: this Linux host denies a minimal bubblewrap user namespace. Lifecycle and real Pi loader tests remain mandatory.",
    );
    process.exit(0);
  }
}
const root = fileURLToPath(new URL("../", import.meta.url));
execFileSync(
  process.execPath,
  ["--import", `${root}protection-source.mjs`, `${root}tests/pi-loader-run.mjs`],
  {
    env: {
      ...process.env,
      PASA_PI_MODULE: `${root}tests/pi-073/node_modules/@mariozechner/pi-coding-agent/dist/index.js`,
    },
    stdio: "inherit",
    timeout: 60000,
  },
);
