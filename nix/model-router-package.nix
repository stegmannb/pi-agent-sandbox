{
  stdenv,
  lib,
}:
let
  packageJson = builtins.fromJSON (builtins.readFile ../extensions/model-router/package.json);
in
stdenv.mkDerivation {
  pname = packageJson.name;
  version = packageJson.version;

  src = lib.cleanSource ../extensions/model-router;

  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/model-router"
    cp -r . "$out/model-router/"

    runHook postInstall
  '';

  meta = {
    description = packageJson.description;
    license = lib.licenses.mit;
    maintainers = [ ];
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
