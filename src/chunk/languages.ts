import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

export interface LanguageConfig {
  name: string;
  extensions: string[];
  wasmPath: string;
  /** AST node types that represent top-level definitions */
  topLevelNodes: string[];
  /** AST node types that can be split into sub-items when too large */
  splitNodes: string[];
}

const RUST: LanguageConfig = {
  name: 'rust',
  extensions: ['.rs'],
  wasmPath: _require.resolve('tree-sitter-rust/tree-sitter-rust.wasm'),
  topLevelNodes: [
    'function_item',
    'struct_item',
    'enum_item',
    'impl_item',
    'trait_item',
    'type_item',
    'const_item',
    'static_item',
    'macro_definition',
    'mod_item',
  ],
  splitNodes: ['impl_item', 'trait_item', 'mod_item'],
};

const JAVASCRIPT: LanguageConfig = {
  name: 'javascript',
  extensions: ['.js', '.jsx', '.mjs', '.cjs'],
  wasmPath: _require.resolve(
    'tree-sitter-javascript/tree-sitter-javascript.wasm'
  ),
  topLevelNodes: [
    'function_declaration',
    'generator_function_declaration',
    'class_declaration',
    'variable_declaration',
    'lexical_declaration',
    'export_statement',
  ],
  splitNodes: ['class_declaration'],
};

const TYPESCRIPT: LanguageConfig = {
  name: 'typescript',
  extensions: ['.ts', '.mts', '.cts'],
  wasmPath: _require.resolve(
    'tree-sitter-typescript/tree-sitter-typescript.wasm'
  ),
  topLevelNodes: [
    'function_declaration',
    'generator_function_declaration',
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
    'type_alias_declaration',
    'enum_declaration',
    'variable_declaration',
    'lexical_declaration',
    'export_statement',
  ],
  splitNodes: [
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
  ],
};

const TSX: LanguageConfig = {
  name: 'tsx',
  extensions: ['.tsx'],
  wasmPath: _require.resolve('tree-sitter-typescript/tree-sitter-tsx.wasm'),
  topLevelNodes: [
    'function_declaration',
    'generator_function_declaration',
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
    'type_alias_declaration',
    'enum_declaration',
    'variable_declaration',
    'lexical_declaration',
    'export_statement',
  ],
  splitNodes: [
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
  ],
};

const C: LanguageConfig = {
  name: 'c',
  extensions: ['.c', '.h'],
  wasmPath: _require.resolve('tree-sitter-c/tree-sitter-c.wasm'),
  topLevelNodes: [
    'function_definition',
    'declaration',
    'type_definition',
    'enum_specifier',
    'struct_specifier',
    'preproc_def',
    'preproc_function_def',
  ],
  splitNodes: [],
};

const PYTHON: LanguageConfig = {
  name: 'python',
  extensions: ['.py', '.pyi'],
  wasmPath: _require.resolve('tree-sitter-python/tree-sitter-python.wasm'),
  topLevelNodes: [
    'function_definition',
    'class_definition',
    'decorated_definition',
  ],
  splitNodes: ['class_definition'],
};

const GO: LanguageConfig = {
  name: 'go',
  extensions: ['.go'],
  wasmPath: _require.resolve('tree-sitter-go/tree-sitter-go.wasm'),
  topLevelNodes: [
    'function_declaration',
    'method_declaration',
    'type_declaration',
    'const_declaration',
    'var_declaration',
  ],
  splitNodes: [],
};

const ZIG: LanguageConfig = {
  name: 'zig',
  extensions: ['.zig'],
  wasmPath: _require.resolve(
    '@tree-sitter-grammars/tree-sitter-zig/tree-sitter-zig.wasm'
  ),
  topLevelNodes: [
    'function_declaration',
    'variable_declaration',
    'test_declaration',
  ],
  splitNodes: [],
};

const JAVA: LanguageConfig = {
  name: 'java',
  extensions: ['.java'],
  wasmPath: _require.resolve('tree-sitter-java/tree-sitter-java.wasm'),
  topLevelNodes: [
    'class_declaration',
    'interface_declaration',
    'enum_declaration',
    'record_declaration',
  ],
  splitNodes: [
    'class_declaration',
    'interface_declaration',
    'enum_declaration',
  ],
};

const SCALA: LanguageConfig = {
  name: 'scala',
  extensions: ['.scala', '.sc'],
  wasmPath: _require.resolve('tree-sitter-scala/tree-sitter-scala.wasm'),
  topLevelNodes: [
    'class_definition',
    'object_definition',
    'trait_definition',
    'function_definition',
    'val_definition',
  ],
  splitNodes: ['class_definition', 'object_definition', 'trait_definition'],
};

const CPP: LanguageConfig = {
  name: 'cpp',
  extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'],
  wasmPath: _require.resolve('tree-sitter-cpp/tree-sitter-cpp.wasm'),
  topLevelNodes: [
    'function_definition',
    'class_specifier',
    'struct_specifier',
    'enum_specifier',
    'namespace_definition',
    'template_declaration',
    'declaration',
  ],
  splitNodes: ['class_specifier', 'struct_specifier', 'namespace_definition'],
};

const PHP: LanguageConfig = {
  name: 'php',
  extensions: ['.php'],
  wasmPath: _require.resolve('tree-sitter-php/tree-sitter-php_only.wasm'),
  topLevelNodes: [
    'class_declaration',
    'interface_declaration',
    'trait_declaration',
    'function_definition',
    'enum_declaration',
  ],
  splitNodes: [
    'class_declaration',
    'interface_declaration',
    'trait_declaration',
  ],
};

const CSHARP: LanguageConfig = {
  name: 'c_sharp',
  extensions: ['.cs'],
  wasmPath: _require.resolve('tree-sitter-c-sharp/tree-sitter-c_sharp.wasm'),
  topLevelNodes: [
    'class_declaration',
    'interface_declaration',
    'struct_declaration',
    'enum_declaration',
    'record_declaration',
    'method_declaration',
    'namespace_declaration',
  ],
  splitNodes: [
    'class_declaration',
    'interface_declaration',
    'struct_declaration',
    'namespace_declaration',
  ],
};

const RUBY: LanguageConfig = {
  name: 'ruby',
  extensions: ['.rb'],
  wasmPath: _require.resolve('tree-sitter-ruby/tree-sitter-ruby.wasm'),
  topLevelNodes: [
    'module',
    'class',
    'method',
    'singleton_method',
    'assignment',
  ],
  splitNodes: ['module', 'class'],
};

const LANGUAGES: LanguageConfig[] = [
  RUST,
  JAVASCRIPT,
  TYPESCRIPT,
  TSX,
  C,
  CPP,
  CSHARP,
  PYTHON,
  GO,
  ZIG,
  JAVA,
  SCALA,
  PHP,
  RUBY,
];

const EXT_MAP = new Map<string, LanguageConfig>();
for (const lang of LANGUAGES) {
  for (const ext of lang.extensions) {
    EXT_MAP.set(ext, lang);
  }
}

export function detectLanguage(filePath: string): LanguageConfig | null {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = filePath.slice(dot);
  return EXT_MAP.get(ext) ?? null;
}

export function supportedExtensions(): string[] {
  return Array.from(EXT_MAP.keys());
}
