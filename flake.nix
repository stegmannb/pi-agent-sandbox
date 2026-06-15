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
        in
        {
          default = pi-sandbox;
          inherit pi-sandbox pi-model-router;
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
