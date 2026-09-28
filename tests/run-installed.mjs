import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const fixture = realpathSync(mkdtempSync(join(tmpdir(), "pasa-installed-")));
const installed = join(fixture, "node_modules", "pi-sandbox");
try {
  mkdirSync(join(installed, "node_modules", "@anthropic-ai"), { recursive: true });
  for (const file of [
    "index.ts",
    "protection.ts",
    "protection-source.mjs",
    "pasa-extension.mjs",
    "package.json",
  ])
    copyFileSync(join(root, file), join(installed, file));
  const runtimeEntry = require.resolve("@anthropic-ai/sandbox-runtime/package.json");
  symlinkSync(
    fileURLToPath(new URL(".", `file://${runtimeEntry}`)),
    join(installed, "node_modules", "@anthropic-ai", "sandbox-runtime"),
  );
  execFileSync(
    process.execPath,
    [
      "--import",
      join(installed, "protection-source.mjs"),
      join(root, "tests", "pi-loader-run.mjs"),
      "--mock-os",
      "--project-config",
    ],
    {
      env: {
        ...process.env,
        PASA_SANDBOX_ENTRY: join(installed, "pasa-extension.mjs"),
        PASA_PI_MODULE: join(
          root,
          "tests",
          "pi-073",
          "node_modules",
          "@mariozechner",
          "pi-coding-agent",
          "dist",
          "index.js",
        ),
      },
      stdio: "inherit",
      timeout: 60000,
    },
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
