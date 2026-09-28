import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
for (const sdk of [
  undefined,
  fileURLToPath(
    new URL("./pi-073/node_modules/@mariozechner/pi-coding-agent/dist/index.js", import.meta.url),
  ),
]) {
  const env = { ...process.env };
  if (sdk) env.PASA_PI_MODULE = sdk;
  else delete env.PASA_PI_MODULE;
  execFileSync(
    process.execPath,
    ["--import", `${root}protection-source.mjs`, `${root}tests/pi-loader-run.mjs`, "--mock-os"],
    { env, stdio: "inherit", timeout: 60000 },
  );
  execFileSync(
    process.execPath,
    [`${root}tests/pi-loader-run.mjs`, "--mock-os", "--expect-unbacked"],
    { env, stdio: "inherit", timeout: 60000 },
  );
  if (sdk)
    execFileSync(
      process.execPath,
      [
        "--import",
        `${root}protection-source.mjs`,
        `${root}tests/pi-loader-run.mjs`,
        "--mock-os",
        "--project-config",
      ],
      { env, stdio: "inherit", timeout: 60000 },
    );
  if (sdk)
    execFileSync(
      process.execPath,
      [
        "--import",
        `${root}protection-source.mjs`,
        `${root}tests/pi-loader-run.mjs`,
        "--mock-os",
        "--failed-native-fallback",
        "--expect-unbacked",
      ],
      { env, stdio: "inherit", timeout: 60000 },
    );
}
