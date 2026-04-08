{
  description = "Development shell for the pi-sandbox fork";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            git
            nodejs_22
            pnpm
          ];

          shellHook = ''
            echo "pi-sandbox devShell ready"
            echo "Use: pnpm install && pnpm run check"
          '';
        };

        formatter = pkgs.nixpkgs-fmt;
      });
}