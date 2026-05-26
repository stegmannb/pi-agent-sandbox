{
  stdenv,
  lib,
  pnpm,
  pnpmConfigHook,
  fetchPnpmDeps,
  nodejs,
  jq,
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
    fetcherVersion = 3;
    hash = "sha256-hBw6mmprXJNWYsxLnZgG/z4+/+UG99CDobUf97SIngk=";
  };

  nativeBuildInputs = [
    pnpm
    pnpmConfigHook
    nodejs
    jq
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
      echo "ERROR: macos-sandbox-utils.js not found -- sandbox-runtime missing?" >&2
      exit 1
    fi

    node ${../nix/patches/pi-agent-sandbox-metal-iokit.mjs} "$UTILS"
    node ${../nix/patches/pi-agent-sandbox-allow-browser-process.mjs} "$out/index.ts"

    # Create sandbox/index.ts re-export shim
    mkdir -p "$out/sandbox"
    echo 'export { default } from "../index.ts";' > "$out/sandbox/index.ts"

    # Patch pi.extensions in package.json
    jq '.pi.extensions = ["./sandbox/index.ts"]' "$out/package.json" > "$out/package.json.tmp"
    mv "$out/package.json.tmp" "$out/package.json"
  '';

  meta = {
    description = packageJson.description;
    homepage = packageJson.homepage;
    license = lib.licenses.mit;
    maintainers = [ ];
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
})
