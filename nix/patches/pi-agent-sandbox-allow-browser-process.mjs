#!/usr/bin/env node
// Patch pi-agent-sandbox's index.ts so `allowBrowserProcess = true` actually
// bypasses OS-level sandboxing for direct Obsidian CLI invocations.
//
// Why: the Obsidian CLI launches a GUI/Electron process that requires a large
// and moving set of Mach/XPC/IOKit allowances on macOS. Trying to whitelist
// those in sandbox-exec is brittle and has repeatedly broken `obsidian help`
// and note operations. When the user explicitly enables allowBrowserProcess,
// we treat direct `obsidian ...` commands as trusted local GUI bridge commands
// and run them outside sandbox-exec.

import { readFileSync, writeFileSync } from 'fs';

const file = process.argv[2];
if (!file) {
  process.stderr.write('Usage: node pi-agent-sandbox-allow-browser-process.mjs <path>\n');
  process.exit(1);
}

let text = readFileSync(file, 'utf8');

const helperAnchor = 'function createSandboxedBashOps(): BashOperations {';
const helper = `function shouldBypassSandboxForCommand(command: string, cwd: string): boolean {\n  const config = loadConfig(cwd) as SandboxConfig & { allowBrowserProcess?: boolean };\n  if (!config.allowBrowserProcess) return false;\n\n  const trimmed = command.trim();\n\n  // Keep this intentionally narrow: only bypass a single direct Obsidian CLI\n  // invocation, optionally prefixed by simple env assignments. This avoids\n  // unsandboxing compound shell commands such as "foo && obsidian ...".\n  if (/[;&|<>]/.test(trimmed)) return false;\n\n  return /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:\"[^\"]*\"|'[^']*'|\\S+)\\s+)*(?:obsidian|\\/Applications\\/Obsidian\\.app\\/Contents\\/MacOS\\/obsidian)(?:\\s|$)/.test(trimmed);\n}\n\n${helperAnchor}`;

if (!text.includes(helperAnchor)) {
  process.stderr.write(
    `ERROR: helper anchor not found in ${file}\n` +
      '       The pi-agent-sandbox source may have changed — update the patch.\n',
  );
  process.exit(1);
}
text = text.replace(helperAnchor, helper);

const wrapOld = '      const wrappedCommand = await SandboxManager.wrapWithSandbox(command);';
const wrapNew = `      const wrappedCommand = shouldBypassSandboxForCommand(command, cwd)\n        ? command\n        : await SandboxManager.wrapWithSandbox(command);`;

if (!text.includes(wrapOld)) {
  process.stderr.write(
    `ERROR: wrapWithSandbox call not found in ${file}\n` +
      '       The pi-agent-sandbox source may have changed — update the patch.\n',
  );
  process.exit(1);
}
text = text.replace(wrapOld, wrapNew);

writeFileSync(file, text);
process.stdout.write(
  `patched ${file}\n` +
    '  allowBrowserProcess now bypasses sandbox-exec for direct obsidian CLI invocations\n',
);
