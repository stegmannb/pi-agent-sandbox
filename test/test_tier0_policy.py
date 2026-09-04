from __future__ import annotations

import importlib.util
import shutil
import tempfile
import unittest
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "tier0_policy", ROOT / "hack" / "tier0_policy.py"
)
assert SPEC is not None and SPEC.loader is not None
POLICY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(POLICY)


@contextmanager
def repository_fixture() -> Iterator[Path]:
    with tempfile.TemporaryDirectory() as directory:
        destination = Path(directory) / "repository"
        shutil.copytree(
            ROOT,
            destination,
            ignore=shutil.ignore_patterns(
                ".git",
                ".devenv*",
                ".direnv",
                "node_modules",
                "__pycache__",
            ),
        )
        yield destination


class Tier0PolicyTests(unittest.TestCase):
    def assert_repository_rejected(
        self, mutate: Callable[[Path], None], message: str
    ) -> None:
        with repository_fixture() as repository:
            mutate(repository)
            with self.assertRaisesRegex(POLICY.PolicyError, message):
                POLICY.validate_repository(repository)

    def mutate_ci(self, repository: Path, old: str, new: str) -> None:
        path = repository / ".forgejo/workflows/ci.yml"
        text = path.read_text(encoding="utf-8")
        self.assertIn(old, text)
        path.write_text(text.replace(old, new, 1), encoding="utf-8")

    def test_repository_satisfies_tier0_contract(self) -> None:
        POLICY.validate_repository(ROOT)

    def test_release_profile_cannot_be_enabled(self) -> None:
        def mutate(repository: Path) -> None:
            path = repository / ".forgejo/tier0.yaml"
            path.write_text(
                path.read_text(encoding="utf-8").replace(
                    "  enabled: false\n", "  enabled: true\n", 1
                ),
                encoding="utf-8",
            )

        self.assert_repository_rejected(mutate, "declaration must exactly match")

    def test_shadow_forgejo_workflow_is_rejected(self) -> None:
        def mutate(repository: Path) -> None:
            (repository / ".forgejo/workflows/shadow.yml").write_text(
                'name: shadow\n"on":\n  pull_request:\njobs: {}\n',
                encoding="utf-8",
            )

        self.assert_repository_rejected(mutate, "only active Forgejo workflow")

    def test_push_trigger_is_rejected(self) -> None:
        self.assert_repository_rejected(
            lambda repository: self.mutate_ci(
                repository,
                '"on":\n  pull_request:\n',
                '"on":\n  pull_request:\n  push:\n',
            ),
            "forbids push workflows",
        )

    def test_unpinned_external_action_is_rejected(self) -> None:
        self.assert_repository_rejected(
            lambda repository: self.mutate_ci(
                repository,
                POLICY.CHECKOUT_ACTION,
                "https://data.forgejo.org/actions/checkout@v6",
            ),
            "full commit SHA",
        )

    def test_ci_rejects_bracket_secret_reference(self) -> None:
        self.assert_repository_rejected(
            lambda repository: self.mutate_ci(
                repository,
                "env:\n  NIX_CONFIG: |\n",
                "env:\n  TOKEN: ${{ secrets['PUBLISH'] }}\n  NIX_CONFIG: |\n",
            ),
            "must not receive secrets",
        )

    def test_forgejo_publish_command_is_rejected(self) -> None:
        self.assert_repository_rejected(
            lambda repository: self.mutate_ci(
                repository,
                "          bash .forgejo/ci/test.sh\n",
                "          bash .forgejo/ci/test.sh\n          pnpm publish\n",
            ),
            "forbids publishing",
        )

    def test_required_job_cannot_ignore_failure(self) -> None:
        self.assert_repository_rejected(
            lambda repository: self.mutate_ci(
                repository,
                "  policy:\n",
                "  policy:\n    continue-on-error: true\n",
            ),
            "policy must fail closed",
        )

    def test_required_step_cannot_be_conditional(self) -> None:
        self.assert_repository_rejected(
            lambda repository: self.mutate_ci(
                repository,
                "      - name: Type-check sandbox boundary\n        shell: bash\n",
                "      - name: Type-check sandbox boundary\n"
                "        if: ${{ false }}\n"
                "        shell: bash\n",
            ),
            "steps must be unconditional and fail closed",
        )

    def test_checkout_must_use_exact_pull_request_head(self) -> None:
        self.assert_repository_rejected(
            lambda repository: self.mutate_ci(
                repository,
                "ref: ${{ github.event.pull_request.head.sha }}",
                "ref: ${{ github.sha }}",
            ),
            "checkout must be exact and credentialless",
        )

    def test_nix_gate_is_required(self) -> None:
        self.assert_repository_rejected(
            lambda repository: self.mutate_ci(
                repository,
                "  nix:\n",
                "  optional-nix:\n",
            ),
            "ci jobs must be exactly",
        )

    def test_commented_codeowners_rule_is_rejected(self) -> None:
        def mutate(repository: Path) -> None:
            path = repository / "CODEOWNERS"
            path.write_text(
                path.read_text(encoding="utf-8").replace(
                    "/index.ts @Bastian/Reviewers\n",
                    "#/index.ts @Bastian/Reviewers\n",
                    1,
                ),
                encoding="utf-8",
            )

        self.assert_repository_rejected(mutate, "must exactly match")

    def test_late_codeowners_override_is_rejected(self) -> None:
        def mutate(repository: Path) -> None:
            path = repository / "CODEOWNERS"
            path.write_text(
                path.read_text(encoding="utf-8") + "/index.ts @Bastian\n",
                encoding="utf-8",
            )

        self.assert_repository_rejected(mutate, "must exactly match")

    def test_gate_script_cannot_be_weakened(self) -> None:
        def mutate(repository: Path) -> None:
            path = repository / ".forgejo/ci/test.sh"
            path.write_text(
                path.read_text(encoding="utf-8").replace(
                    "pnpm run verify\n", "pnpm run ci:test\n", 1
                ),
                encoding="utf-8",
            )

        self.assert_repository_rejected(mutate, "script test must be exact")

    def test_oxc_runner_cannot_be_weakened(self) -> None:
        def mutate(repository: Path) -> None:
            path = repository / ".forgejo/ci/run-oxc.mjs"
            path.write_text(
                path.read_text(encoding="utf-8").replace(
                    "delete env.NAPI_RS_NATIVE_LIBRARY_PATH;\n", "", 1
                ),
                encoding="utf-8",
            )

        self.assert_repository_rejected(mutate, "Oxc runner must remain exact")

    def test_nix_gate_cannot_skip_the_sandbox_package(self) -> None:
        def mutate(repository: Path) -> None:
            path = repository / ".forgejo/ci/nix.sh"
            path.write_text(
                path.read_text(encoding="utf-8").replace(
                    "nix build --no-link .#default .#pi-model-router\n",
                    "nix build --no-link .#pi-model-router\n",
                    1,
                ),
                encoding="utf-8",
            )

        self.assert_repository_rejected(mutate, "script nix must be exact")

    def test_verify_contract_cannot_be_weakened(self) -> None:
        def mutate(repository: Path) -> None:
            path = repository / "package.json"
            path.write_text(
                path.read_text(encoding="utf-8").replace(
                    '"verify": "pnpm run ci:fmt && pnpm run ci:lint && '
                    'pnpm run ci:check && pnpm run ci:test"',
                    '"verify": "pnpm run ci:test"',
                    1,
                ),
                encoding="utf-8",
            )

        self.assert_repository_rejected(mutate, "script verify must remain exact")

    def test_protected_pre_hook_is_rejected(self) -> None:
        def mutate(repository: Path) -> None:
            path = repository / "package.json"
            path.write_text(
                path.read_text(encoding="utf-8").replace(
                    '"check": "tsc --noEmit",',
                    '"precheck": "node malicious.js",\n    "check": "tsc --noEmit",',
                    1,
                ),
                encoding="utf-8",
            )

        self.assert_repository_rejected(mutate, "protected hook precheck")

    def test_protected_post_hook_is_rejected(self) -> None:
        def mutate(repository: Path) -> None:
            path = repository / "package.json"
            path.write_text(
                path.read_text(encoding="utf-8").replace(
                    '"ci:test": "pnpm run test",',
                    '"ci:test": "pnpm run test",\n'
                    '    "postci:test": "node malicious.js",',
                    1,
                ),
                encoding="utf-8",
            )

        self.assert_repository_rejected(mutate, "protected hook postci:test")

    def test_script_shell_override_is_rejected(self) -> None:
        def mutate(repository: Path) -> None:
            path = repository / ".npmrc"
            path.write_text(
                path.read_text(encoding="utf-8") + "script-shell=./malicious.sh\n",
                encoding="utf-8",
            )

        self.assert_repository_rejected(mutate, "approved CI-safe contract")

    def test_workspace_build_policy_override_is_rejected(self) -> None:
        def mutate(repository: Path) -> None:
            path = repository / "pnpm-workspace.yaml"
            path.write_text(
                path.read_text(encoding="utf-8") + "  malicious-package: true\n",
                encoding="utf-8",
            )

        self.assert_repository_rejected(mutate, "workspace policy must remain exact")

    def test_package_manager_drift_is_rejected(self) -> None:
        def mutate(repository: Path) -> None:
            path = repository / "package.json"
            path.write_text(
                path.read_text(encoding="utf-8").replace(
                    '"packageManager": "pnpm@10.32.1"',
                    '"packageManager": "pnpm@latest"',
                    1,
                ),
                encoding="utf-8",
            )

        self.assert_repository_rejected(mutate, "packageManager must remain pinned")

    def test_duplicate_workflow_key_is_rejected(self) -> None:
        self.assert_repository_rejected(
            lambda repository: self.mutate_ci(
                repository,
                "permissions:\n  contents: read\n",
                "permissions:\n  contents: read\npermissions:\n  contents: read\n",
            ),
            "duplicate YAML key",
        )


if __name__ == "__main__":
    unittest.main()
