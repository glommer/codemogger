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

    # Install dependencies
    bun install --frozen-lockfile

    # Build the CLI
    # 1. Compile TypeScript to dist/
    bun run tsc -p tsconfig.build.json

    # 2. Bundle CLI with external dependencies
    bun build bin/codemogger.ts \
      --target node \
      --external @tursodatabase/database \
      --external @modelcontextprotocol/sdk \
      --external @huggingface/transformers \
      --external zod \
      --external commander \
      --external web-tree-sitter \
      --external tree-sitter-rust \
      --external tree-sitter-javascript \
      --external tree-sitter-typescript \
      --external tree-sitter-c \
      --external tree-sitter-cpp \
      --external tree-sitter-python \
      --external tree-sitter-go \
      --external tree-sitter-java \
      --external tree-sitter-scala \
      --external tree-sitter-php \
      --external tree-sitter-ruby \
      --external @tree-sitter-grammars/tree-sitter-zig \
      --outfile dist/cli.mjs

    # 3. Fix shebang from bun to node
    sed -i '1s|#!/usr/bin/env bun|#!/usr/bin/env node|' dist/cli.mjs

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
