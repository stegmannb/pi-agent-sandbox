{ pkgs, lib, ... }:
{
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_22;
    corepack.enable = true;
    pnpm.enable = true;
  };

  packages =
    with pkgs;
    [
      git
      nixfmt-rfc-style
      ripgrep
      socat
    ]
    ++ lib.optionals stdenv.isLinux [ bubblewrap ];

  enterShell = ''
    echo "pi-sandbox devenv ready (devenv 2.x)"
    echo "Use: pnpm install && pnpm run check"
    echo "Build router package: nix build .#pi-model-router"
  '';

  enterTest = ''
    pnpm install --frozen-lockfile
    pnpm --dir tests/pi-073 install --ignore-workspace --ignore-scripts --frozen-lockfile
    pnpm run ci:fmt
    pnpm run ci:lint
    pnpm run ci:check
    pnpm test
    pnpm run test:loader
    pnpm run test:os
    nix build .#pi-model-router .#pi-sandbox --no-link
  '';
}
