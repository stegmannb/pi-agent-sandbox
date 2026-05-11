{
  stdenv,
  lib,
  pnpm,
  pnpmConfigHook,
  fetchPnpmDeps,
  nodejs,
}:
let
  packageJson = builtins.fromJSON (builtins.readFile ../package.json);
in
stdenv.mkDerivation (finalAttrs: {
  pname = packageJson.name;
  version = packageJson.version;

  src = lib.cleanSource ../.;

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    fetcherVersion = 2;
    hash = "sha256-Gk9R+6UVLsrvWErqsErhmcz6sfw76TniMuVYEHyrxko=";
  };

  nativeBuildInputs = [
    pnpm
    pnpmConfigHook
    nodejs
  ];

  prePnpmInstall = ''
    pnpmInstallFlags+=(--prod)
  '';

  dontBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out"
    cp -r . "$out/"

    runHook postInstall
  '';

  postInstall = ''
    UTILS=$(find "$out/node_modules/.pnpm" \
      -path "*/sandbox-runtime*/dist/sandbox/macos-sandbox-utils.js" \
      | head -1)
    if [ -z "$UTILS" ]; then
      echo "ERROR: macos-sandbox-utils.js not found — sandbox-runtime missing?" >&2
      exit 1
    fi

    node ${../nix/patches/pi-agent-sandbox-metal-iokit.mjs} "$UTILS"
    node ${../nix/patches/pi-agent-sandbox-allow-browser-process.mjs} "$out/index.ts"
  '';

  meta = {
    description = packageJson.description;
    homepage = packageJson.homepage;
    license = lib.licenses.mit;
    maintainers = [ ];
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
})
