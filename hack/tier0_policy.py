#!/usr/bin/env python3
"""Fail-closed Forgejo Tier-0/no-release policy for pi-agent-sandbox."""

from __future__ import annotations

import argparse
import json
import re
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml

EXPECTED_CHECKS = [
    "ci / policy (pull_request)",
    "ci / typecheck (pull_request)",
    "ci / lint (pull_request)",
    "ci / format (pull_request)",
    "ci / test (pull_request)",
    "ci / nix (pull_request)",
]
CHECKOUT_ACTION = (
    "https://data.forgejo.org/actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803"
)
RUNNER_IMAGE = (
    "git.forest-arowana.ts.net/bastian/forgejo-runner-k8s@"
    "sha256:f038e4345561f4b0bb82bc31c9f6779394db574287779a437f261b7ec409e826"
)
EXPECTED_DECLARATION = {
    "schema": 1,
    "tier": 0,
    "releaseProfile": "none",
    "securityBoundary": "process-and-filesystem-sandbox",
    "role": "canonical process and filesystem safety boundary for agent tool execution",
    "owner": "Bastian",
    "defaultBranch": "main",
    "policy": "docs/forgejo-tier-0.md",
    "requiredChecks": EXPECTED_CHECKS,
    "forgejoRelease": {
        "enabled": False,
        "declarations": "forbidden",
        "tags": "forbidden",
        "forgejoReleases": "forbidden",
        "packages": "forbidden",
        "publishCredentials": "forbidden",
    },
    "externalReleaseBoundary": {
        "platform": "GitHub",
        "workflow": ".github/workflows/release.yml",
        "registry": "npm",
        "forgejoExecution": "forbidden",
        "taskScope": "unchanged",
    },
    "protectionAudit": {
        "method": "forgejo-owner-api-and-ui",
        "verifiedAt": None,
        "verifiedBy": None,
        "evidence": (
            "pending Owner-Apply and readback for main, merge, review, checks, "
            "tags, releases, and packages"
        ),
        "reviewDate": "2026-09-30",
        "triggers": ["forgejo-upgrade", "protection-setting-change"],
    },
    "ownerApplyTask": "HL-0081",
}
EXPECTED_CODEOWNERS = """* @Bastian/Reviewers

/.forgejo/ @Bastian/Reviewers
/.github/actionlint.yaml @Bastian/Reviewers
/.github/workflows/release.yml @Bastian/Reviewers
/.github/workflows/test.yml @Bastian/Reviewers
/.envrc @Bastian/Reviewers
/.npmrc @Bastian/Reviewers
/CODEOWNERS @Bastian/Reviewers
/devenv.lock @Bastian/Reviewers
/devenv.nix @Bastian/Reviewers
/devenv.yaml @Bastian/Reviewers
/docs/forgejo-tier-0.md @Bastian/Reviewers
/flake.lock @Bastian/Reviewers
/flake.nix @Bastian/Reviewers
/hack/ @Bastian/Reviewers
/index.ts @Bastian/Reviewers
/nix/ @Bastian/Reviewers
/package.json @Bastian/Reviewers
/patches/ @Bastian/Reviewers
/pnpm-lock.yaml @Bastian/Reviewers
/pnpm-workspace.yaml @Bastian/Reviewers
/src/ @Bastian/Reviewers
/test/ @Bastian/Reviewers
/tsconfig.json @Bastian/Reviewers
"""
EXPECTED_NPMRC = "auto-install-peers=false\n"
EXPECTED_WORKSPACE = """allowBuilds:
  '@google/genai': true
  koffi: true
  protobufjs: true
onlyBuiltDependencies:
  - "@google/genai"
  - koffi
  - protobufjs
patchedDependencies:
  '@anthropic-ai/sandbox-runtime@0.0.52': patches/@anthropic-ai__sandbox-runtime@0.0.52.patch
"""
CI_GATE_SPECS = {
    "policy": (
        "Validate Tier-0 and Forgejo no-release policy",
        "policy-tools",
        'bash .forgejo/ci/policy.sh "$GITHUB_EVENT_PATH"',
        15,
    ),
    "typecheck": (
        "Type-check sandbox boundary",
        "node-tools",
        "bash .forgejo/ci/typecheck.sh",
        15,
    ),
    "lint": (
        "Lint sandbox boundary",
        "node-tools",
        "bash .forgejo/ci/lint.sh",
        15,
    ),
    "format": (
        "Check sandbox formatting",
        "node-tools",
        "bash .forgejo/ci/format.sh",
        15,
    ),
    "test": (
        "Run complete sandbox verification",
        "node-tools",
        "bash .forgejo/ci/test.sh",
        15,
    ),
    "nix": (
        "Build sandbox Nix packages",
        "nix-tools",
        "bash .forgejo/ci/nix.sh",
        20,
    ),
}
PNPM_ENV = (
    "npm_config_ignore_scripts=true\n"
    'npm_config_script_shell="$(command -v bash)"\n'
    "export npm_config_ignore_scripts npm_config_script_shell"
)
PNPM_INSTALL = "pnpm install --frozen-lockfile --ignore-scripts"
EXPECTED_GATE_COMMANDS = {
    "typecheck": "pnpm run ci:check",
    "lint": "pnpm run ci:lint",
    "format": "pnpm run ci:fmt",
    "test": "pnpm run verify",
}
EXPECTED_PACKAGE_SCRIPTS = {
    "fmt": "oxfmt index.ts src/**/*.ts extensions/**/*.ts test/**/*.ts",
    "lint": "oxlint index.ts src/**/*.ts extensions/**/*.ts test/**/*.ts",
    "check": "tsc --noEmit",
    "test": "node --test test/**/*.test.ts",
    "ci:fmt": "oxfmt --check index.ts src/**/*.ts extensions/**/*.ts test/**/*.ts",
    "ci:lint": "pnpm run lint",
    "ci:check": "pnpm run check",
    "ci:test": "pnpm run test",
    "verify": (
        "pnpm run ci:fmt && pnpm run ci:lint && pnpm run ci:check && pnpm run ci:test"
    ),
}
FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
SECRET_CONTEXT_EXPRESSION = re.compile(r"\${{.*?\bsecrets\b.*?}}", re.DOTALL)
FORBIDDEN_FORGEJO_TEXT = re.compile(
    r"(?im)(packages:\s*write|contents:\s*write|\b(?:npm|pnpm)\s+publish\b|"
    r"\bgit\s+tag\b|\bfj\s+(?:release|package)\b|\brelease-retries/)"
)


class PolicyError(RuntimeError):
    """The repository violates its Forgejo Tier-0 declaration."""


class UniqueKeyLoader(yaml.SafeLoader):
    """Safe YAML loader that rejects duplicate mapping keys."""


def construct_unique_mapping(
    loader: UniqueKeyLoader, node: yaml.MappingNode, deep: bool = False
) -> dict[Any, Any]:
    mapping: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise PolicyError(f"duplicate YAML key: {key!r}")
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, construct_unique_mapping
)


def load_yaml(path: Path) -> dict[str, Any]:
    try:
        value = yaml.load(path.read_text(encoding="utf-8"), Loader=UniqueKeyLoader)
    except (OSError, yaml.YAMLError) as error:
        raise PolicyError(f"cannot parse {path}: {error}") from error
    if not isinstance(value, dict):
        raise PolicyError(f"{path} must contain a YAML mapping")
    return value


def load_json(path: Path) -> dict[str, Any]:
    def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        value: dict[str, Any] = {}
        for key, child in pairs:
            if key in value:
                raise PolicyError(f"duplicate JSON key in {path}: {key!r}")
            value[key] = child
        return value

    try:
        value = json.loads(
            path.read_text(encoding="utf-8"), object_pairs_hook=unique_object
        )
    except (OSError, json.JSONDecodeError) as error:
        raise PolicyError(f"cannot parse {path}: {error}") from error
    if not isinstance(value, dict):
        raise PolicyError(f"{path} must contain a JSON object")
    return value


def workflow_triggers(workflow: dict[str, Any]) -> dict[str, Any]:
    triggers = workflow.get("on", workflow.get(True))
    if not isinstance(triggers, dict):
        raise PolicyError("workflow triggers must be an explicit mapping")
    return triggers


def scalar_strings(value: Any) -> list[str]:
    strings: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            strings.extend(scalar_strings(key))
            strings.extend(scalar_strings(child))
    elif isinstance(value, list):
        for child in value:
            strings.extend(scalar_strings(child))
    elif isinstance(value, str):
        strings.append(value)
    return strings


def secret_context_expressions(value: Any) -> list[str]:
    return [
        match.group(0)
        for scalar in scalar_strings(value)
        for match in SECRET_CONTEXT_EXPRESSION.finditer(scalar)
    ]


def action_references(value: Any) -> list[str]:
    references: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "uses":
                if not isinstance(child, str):
                    raise PolicyError("Action uses values must be strings")
                references.append(child)
            references.extend(action_references(child))
    elif isinstance(value, list):
        for child in value:
            references.extend(action_references(child))
    return references


def validate_action_pins(path: Path, value: dict[str, Any]) -> None:
    for reference in action_references(value):
        if reference.startswith("./"):
            continue
        if "@" not in reference:
            raise PolicyError(f"external Action has no ref in {path}: {reference}")
        revision = reference.rsplit("@", 1)[1]
        if not FULL_SHA.fullmatch(revision):
            raise PolicyError(
                f"external Action is not pinned to a full commit SHA in {path}: "
                f"{reference}"
            )


def validate_declaration(root: Path) -> None:
    declaration = load_yaml(root / ".forgejo/tier0.yaml")
    if declaration != EXPECTED_DECLARATION:
        raise PolicyError("Tier-0 declaration must exactly match the approved contract")


def validate_codeowners(root: Path) -> None:
    text = (root / "CODEOWNERS").read_text(encoding="utf-8")
    if text != EXPECTED_CODEOWNERS:
        raise PolicyError(
            "CODEOWNERS must exactly match the approved fail-closed reviewer rules"
        )


def expected_stage_step() -> dict[str, str]:
    return {
        "name": "Stage exact head on ephemeral disk",
        "shell": "bash",
        "run": (
            "set -euo pipefail\n"
            'ci_workspace="$RUNNER_TEMP/pi-agent-sandbox"\n'
            'install -d "$ci_workspace"\n'
            'cp -a "$GITHUB_WORKSPACE/." "$ci_workspace/"\n'
            'echo "CI_WORKSPACE=$ci_workspace" >> "$GITHUB_ENV"\n'
        ),
    }


def expected_gate_step(job_name: str) -> dict[str, str]:
    gate_name, tool_package, command, _timeout = CI_GATE_SPECS[job_name]
    return {
        "name": gate_name,
        "shell": "bash",
        "run": (
            "set -euo pipefail\n"
            'cd "$CI_WORKSPACE"\n'
            f'tools="$(nix build --no-link --print-out-paths .#{tool_package})"\n'
            'export PATH="$tools/bin:$PATH"\n'
            f"{command}\n"
        ),
    }


def validate_ci_job(name: str, job: Any) -> None:
    if not isinstance(job, dict):
        raise PolicyError(f"ci job {name} must be a mapping")
    if "if" in job:
        raise PolicyError(f"required ci job {name} must not be conditional")
    if "continue-on-error" in job:
        raise PolicyError(f"required ci job {name} must fail closed")
    if set(job) != {"runs-on", "timeout-minutes", "container", "steps"}:
        raise PolicyError(f"required ci job {name} shape must be exact")
    if job.get("runs-on") != ["k8s-executor-small", "amd64"]:
        raise PolicyError(f"ci job {name} must use the approved runner")
    timeout = CI_GATE_SPECS[name][3]
    if job.get("timeout-minutes") != timeout:
        raise PolicyError(f"ci job {name} timeout must be exact")
    if job.get("container") != {"image": RUNNER_IMAGE}:
        raise PolicyError(f"ci job {name} container must be approved and immutable")

    steps = job.get("steps")
    if not isinstance(steps, list) or len(steps) != 3:
        raise PolicyError(f"ci job {name} must contain exactly three steps")
    for step in steps:
        if not isinstance(step, dict):
            raise PolicyError(f"ci job {name} steps must be mappings")
        if "if" in step or "continue-on-error" in step:
            raise PolicyError(
                f"ci job {name} steps must be unconditional and fail closed"
            )

    checkout_inputs: dict[str, Any] = {
        "persist-credentials": False,
        "ref": "${{ github.event.pull_request.head.sha }}",
    }
    if name == "policy":
        checkout_inputs = {"fetch-depth": 0, **checkout_inputs}
    if steps[0] != {"uses": CHECKOUT_ACTION, "with": checkout_inputs}:
        raise PolicyError(f"ci job {name} checkout must be exact and credentialless")
    if steps[1] != expected_stage_step():
        raise PolicyError(f"ci job {name} must stage the exact head ephemerally")
    if steps[2] != expected_gate_step(name):
        raise PolicyError(f"ci job {name} must execute its exact required gate")


def validate_gate_scripts(root: Path) -> None:
    base = (
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n\n"
        'repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"\n'
        'cd "$repo_root"\n\n'
    )
    expected = {
        name: base + f"{PNPM_ENV}\n{PNPM_INSTALL}\n{command}\n"
        for name, command in EXPECTED_GATE_COMMANDS.items()
    }
    expected["nix"] = (
        base
        + "nix flake show --all-systems\n"
        + "nix build --no-link .#default .#pi-model-router\n"
    )
    expected["policy"] = (
        base
        + "event_args=()\n"
        + 'if [ "$#" -gt 0 ]; then\n'
        + '  event_args=(--event "$1")\n'
        + "fi\n\n"
        + "actionlint \\\n"
        + "  -config-file .github/actionlint.yaml \\\n"
        + '  -ignore \'specifying action "https://[^" ]+@[0-9a-f]+" in invalid format\' \\\n'
        + "  .forgejo/workflows/ci.yml\n"
        + "bash -n .forgejo/ci/*.sh\n"
        + "shellcheck .forgejo/ci/*.sh\n"
        + 'python hack/tier0_policy.py "${event_args[@]}"\n'
        + "python -m unittest discover -s test -p 'test_tier0_policy.py'\n"
        + "ruff format --check hack test/test_tier0_policy.py\n"
        + "ruff check hack test/test_tier0_policy.py\n"
    )
    script_dir = root / ".forgejo/ci"
    paths = {path.stem: path for path in script_dir.glob("*.sh")}
    if set(paths) != set(expected):
        raise PolicyError("Forgejo gate script inventory must be exact")
    for name, content in expected.items():
        path = paths[name]
        if path.read_text(encoding="utf-8") != content:
            raise PolicyError(f"Forgejo gate script {name} must be exact")
        if not path.stat().st_mode & stat.S_IXUSR:
            raise PolicyError(f"Forgejo gate script {name} must be executable")


def validate_package_contract(root: Path) -> None:
    if (root / ".npmrc").read_text(encoding="utf-8") != EXPECTED_NPMRC:
        raise PolicyError(".npmrc must exactly match the approved CI-safe contract")
    if (root / "pnpm-workspace.yaml").read_text(encoding="utf-8") != EXPECTED_WORKSPACE:
        raise PolicyError("pnpm workspace policy must remain exact")
    package = load_json(root / "package.json")
    if package.get("packageManager") != "pnpm@10.32.1":
        raise PolicyError("packageManager must remain pinned to pnpm@10.32.1")
    scripts = package.get("scripts")
    if not isinstance(scripts, dict):
        raise PolicyError("package.json scripts must be a mapping")
    for name, command in EXPECTED_PACKAGE_SCRIPTS.items():
        if scripts.get(name) != command:
            raise PolicyError(f"package.json script {name} must remain exact")
        for prefix in ("pre", "post"):
            lifecycle_name = f"{prefix}{name}"
            if lifecycle_name in scripts:
                raise PolicyError(
                    f"package.json must not define protected hook {lifecycle_name}"
                )
    if not (root / "pnpm-lock.yaml").is_file():
        raise PolicyError("the pnpm lockfile is required")


def validate_ci_workflow(root: Path) -> None:
    path = root / ".forgejo/workflows/ci.yml"
    workflow = load_yaml(path)
    if set(workflow) != {"name", "on", "permissions", "env", "jobs"}:
        raise PolicyError("the required-check workflow shape must be exact")
    if workflow.get("name") != "ci":
        raise PolicyError("the required-check workflow must be named ci")
    if workflow_triggers(workflow) != {"pull_request": None}:
        raise PolicyError("ci must run unfiltered and only for pull requests")
    if workflow.get("permissions") != {"contents": "read"}:
        raise PolicyError("ci permissions must be read-only")
    if secret_context_expressions(workflow):
        raise PolicyError("pull-request CI must not receive secrets")
    if workflow.get("env") != {
        "NIX_CONFIG": (
            "accept-flake-config = true\n"
            "experimental-features = nix-command flakes\n"
            "fallback = true\n"
            "sandbox = false\n"
        )
    }:
        raise PolicyError("ci workflow environment must contain only pinned Nix config")

    jobs = workflow.get("jobs")
    if not isinstance(jobs, dict) or set(jobs) != set(CI_GATE_SPECS):
        raise PolicyError(f"ci jobs must be exactly {sorted(CI_GATE_SPECS)}")
    for name, job in jobs.items():
        validate_ci_job(name, job)


def validate_workflows(root: Path) -> None:
    workflow_dir = root / ".forgejo/workflows"
    active_paths = sorted(
        set(workflow_dir.glob("*.yml")) | set(workflow_dir.glob("*.yaml"))
    )
    if [path.name for path in active_paths] != ["ci.yml"]:
        raise PolicyError("ci.yml must be the only active Forgejo workflow")
    for path in active_paths:
        workflow = load_yaml(path)
        validate_action_pins(path, workflow)
        if "push" in workflow_triggers(workflow):
            raise PolicyError("Forgejo releaseProfile none forbids push workflows")
        if FORBIDDEN_FORGEJO_TEXT.search(path.read_text(encoding="utf-8")):
            raise PolicyError(
                f"Forgejo releaseProfile none forbids publishing in {path}"
            )
    validate_ci_workflow(root)


def validate_external_release_boundary(root: Path) -> None:
    path = root / ".github/workflows/release.yml"
    if not path.is_file():
        raise PolicyError(
            "the external GitHub/npm release workflow must remain present"
        )
    forgejo_text = "\n".join(
        path.read_text(encoding="utf-8")
        for directory in (root / ".forgejo/workflows", root / ".forgejo/ci")
        for path in directory.rglob("*")
        if path.is_file()
    )
    if ".github/workflows/release.yml" in forgejo_text:
        raise PolicyError(
            "Forgejo automation must not invoke the GitHub release boundary"
        )


def git(root: Path, *args: str) -> str:
    try:
        return subprocess.run(
            ["git", "-C", str(root), *args],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except subprocess.CalledProcessError as error:
        raise PolicyError(error.stderr.strip() or "git command failed") from error


def validate_event(root: Path, event_path: Path) -> None:
    try:
        event = json.loads(event_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise PolicyError(f"cannot parse event payload: {error}") from error
    pull_request = event.get("pull_request")
    if not isinstance(pull_request, dict):
        raise PolicyError("the policy workflow requires a pull_request event")
    base = pull_request.get("base")
    head = pull_request.get("head")
    if not isinstance(base, dict) or not isinstance(head, dict):
        raise PolicyError("pull_request event must contain base and head")
    if base.get("ref") != "main":
        raise PolicyError("Tier-0 pull requests must target main")
    head_sha = head.get("sha")
    if not isinstance(head_sha, str) or not FULL_SHA.fullmatch(head_sha):
        raise PolicyError("pull_request head must be a full commit SHA")
    if git(root, "rev-parse", "HEAD") != head_sha:
        raise PolicyError("checked-out commit does not match the pull-request head")


def validate_repository(root: Path, event_path: Path | None = None) -> None:
    validate_declaration(root)
    validate_codeowners(root)
    validate_workflows(root)
    validate_gate_scripts(root)
    validate_package_contract(root)
    validate_external_release_boundary(root)
    if event_path is not None:
        validate_event(root, event_path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--root", type=Path, default=Path(__file__).resolve().parents[1]
    )
    parser.add_argument("--event", type=Path)
    args = parser.parse_args()
    try:
        validate_repository(args.root.resolve(), args.event)
    except PolicyError as error:
        print(f"Tier-0 policy failed: {error}", file=sys.stderr)
        return 1
    print("Forgejo Tier-0/no-release policy passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
