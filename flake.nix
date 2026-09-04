{
  description = "pi-sandbox packaged as a Nix flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    { nixpkgs, ... }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          pi-sandbox = pkgs.callPackage ./nix/package.nix { };
          pi-model-router = pkgs.callPackage ./nix/model-router-package.nix { };
          pythonWithYaml = pkgs.python3.withPackages (pythonPackages: [
            pythonPackages.pyyaml
          ]);
        in
        {
          default = pi-sandbox;
          inherit pi-sandbox pi-model-router;

          node-tools = pkgs.buildEnv {
            name = "pi-agent-sandbox-node-tools";
            paths = [
              pkgs.bash
              pkgs.coreutils
              pkgs.nodejs_22
              pkgs.pnpm
            ];
          };

          nix-tools = pkgs.buildEnv {
            name = "pi-agent-sandbox-nix-tools";
            paths = [
              pkgs.bash
              pkgs.coreutils
              pkgs.git
            ];
          };

          policy-tools = pkgs.buildEnv {
            name = "pi-agent-sandbox-policy-tools";
            paths = [
              pkgs.actionlint
              pkgs.bash
              pkgs.git
              pkgs.ruff
              pkgs.shellcheck
              pythonWithYaml
            ];
          };
        }
      );

      formatter = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        pkgs.writeShellApplication {
          name = "nixfmt-tree";
          runtimeInputs = [ pkgs.nixfmt-rfc-style ];
          text = ''
            nixfmt flake.nix devenv.nix nix/*.nix
          '';
        }
      );
    };
}
