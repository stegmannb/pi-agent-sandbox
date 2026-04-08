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
  ];

  enterShell = ''
    echo "pi-sandbox devenv ready"
    echo "Use: pnpm install && pnpm run check"
  '';

  enterTest = ''
    pnpm install --frozen-lockfile
    pnpm run ci:fmt
    pnpm run ci:lint
    pnpm run ci:check
  '';
}