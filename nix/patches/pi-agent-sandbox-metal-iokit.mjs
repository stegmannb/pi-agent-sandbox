#!/usr/bin/env node
// Patch macos-sandbox-utils.js from @anthropic-ai/sandbox-runtime to allow
// two additional capabilities needed by node-llama-cpp (qmd vsearch/query):
//
// 1. Metal/AGX IOKit user-client classes (iokit-open section)
//    AGXDeviceUserClient      — Metal GPU device user client
//    AGXAccelerator           — AGX accelerator registry entry
//    Without these, sandbox-exec blocks Metal command queue creation on
//    Apple Silicon. node-llama-cpp logs: "ggml_metal_init: failed to create
//    command queue".
//
// 2. vm.swapusage sysctl (sysctl-read section)
//    node-llama-cpp calls sysctlbyname("vm.swapusage") to determine how much
//    swap space is available before deciding whether a model fits in memory.
//    Without this, it logs: "Failed to get swap info".
//
// Neither capability is configurable via sandbox.json; the iokit-open and
// sysctl-read blocks are hardcoded in the generated sandbox-exec profile.

import { readFileSync, writeFileSync } from 'fs';

const file = process.argv[2];
if (!file) {
  process.stderr.write('Usage: node pi-agent-sandbox-metal-iokit.mjs <path>\n');
  process.exit(1);
}

let patched = readFileSync(file, 'utf8');

const iokitAnchor = `'  (iokit-user-client-class "IOSurfaceSendRight")',`;
const iokitAdd =
  `\n        '  (iokit-user-client-class "AGXDeviceUserClient")',` +
  `\n        '  (iokit-registry-entry-class "AGXAccelerator")',`;

if (!patched.includes(iokitAnchor)) {
  process.stderr.write(
    `ERROR: iokit-open pattern not found in ${file}\n` +
      '       The sandbox-runtime version may have changed — update the patch.\n',
  );
  process.exit(1);
}
patched = patched.replace(iokitAnchor, iokitAnchor + iokitAdd);

const sysctlAnchor = `'  (sysctl-name "vm.loadavg")',`;
const sysctlAdd = `\n        '  (sysctl-name "vm.swapusage")',`;

if (!patched.includes(sysctlAnchor)) {
  process.stderr.write(
    `ERROR: sysctl vm.loadavg anchor not found in ${file}\n` +
      '       The sandbox-runtime version may have changed — update the patch.\n',
  );
  process.exit(1);
}
patched = patched.replace(sysctlAnchor, sysctlAnchor + sysctlAdd);

writeFileSync(file, patched);
process.stdout.write(
  `patched ${file}\n` +
    '  iokit-open  + AGXDeviceUserClient, AGXAccelerator\n' +
    '  sysctl-read + vm.swapusage\n',
);
