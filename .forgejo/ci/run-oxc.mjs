import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const [tool, ...args] = process.argv.slice(2);
const glibcBindings = {
  oxfmt: "@oxfmt/binding-linux-x64-gnu",
  oxlint: "@oxlint/binding-linux-x64-gnu",
};

if (!(tool in glibcBindings)) {
  console.error(`unsupported Oxc tool: ${tool ?? "missing"}`);
  process.exit(2);
}

const env = { ...process.env };
delete env.NAPI_RS_NATIVE_LIBRARY_PATH;

const report = process.report?.getReport();
if (process.platform === "linux" && process.arch === "x64" && report?.header?.glibcVersionRuntime) {
  const toolRequire = createRequire(require.resolve(tool));
  env.NAPI_RS_NATIVE_LIBRARY_PATH = toolRequire.resolve(glibcBindings[tool]);
}

const command = process.platform === "win32" ? `${tool}.cmd` : tool;
const result = spawnSync(command, args, { env, stdio: "inherit" });
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
