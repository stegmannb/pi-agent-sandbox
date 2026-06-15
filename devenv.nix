{ pkgs, ... }:
{
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_22;
    corepack.enable = true;
    pnpm.enable = true;
  };

  packages = with pkgs; [
    git
    nixfmt-rfc-style
  ];

  enterShell = ''
    echo "pi-sandbox devenv ready (devenv 2.x)"
    echo "Use: pnpm install && pnpm run check"
    echo "Build router package: nix build .#pi-model-router"
  '';

  enterTest = ''
    pnpm install --frozen-lockfile
    pnpm run ci:fmt
    pnpm run ci:lint
    pnpm run ci:check
    nix build .#pi-model-router
  '';
}
