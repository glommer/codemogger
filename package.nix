{
  lib,
  stdenv,
  bun,
  nodejs,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "codemogger";
  version = "0.1.4";

  src = ./.;

  nativeBuildInputs = [
    bun
    nodejs
  ];

  # Required for native modules (tree-sitter grammars, Turso)
  buildInputs = lib.optionals stdenv.isLinux [ stdenv.cc.cc.lib ];

  # Bun expects a writable home directory
  HOME = "/tmp";

  buildPhase = ''
    runHook preBuild

    export BUN_INSTALL_CACHE_DIR="$(mktemp -d)"
    # Install dependencies
    bun install --frozen-lockfile

    # Build the CLI
    bun run build

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/bin $out/lib/node_modules/codemogger

    # Copy the bundled CLI and dist files
    cp -r dist $out/lib/node_modules/codemogger/
    cp -r node_modules $out/lib/node_modules/codemogger/

    # Create symlink to the CLI binary
    ln -s $out/lib/node_modules/codemogger/dist/cli.mjs $out/bin/codemogger

    runHook postInstall
  '';

  meta = {
    description = "Code indexing library with tree-sitter chunking and vector+FTS search for AI coding agents";
    homepage = "https://github.com/glommer/codemogger";
    license = lib.licenses.mit;
    mainProgram = "codemogger";
    platforms = lib.platforms.unix;
  };
})
