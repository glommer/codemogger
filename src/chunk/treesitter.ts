import { Parser, Language } from 'web-tree-sitter';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { CodeChunk } from './types.ts';
import type { LanguageConfig } from './languages.ts';

const MAX_CHUNK_LINES = 150;

let parserReady: Promise<void> | null = null;
let parser: Parser | null = null;
const loadedLanguages = new Map<string, Language>();

async function ensureParser(): Promise<Parser> {
  if (!parser) {
    if (!parserReady) {
      parserReady = Parser.init();
    }
    await parserReady;
    parser = new Parser();
  }
  return parser;
}

async function getLanguage(config: LanguageConfig): Promise<Language> {
  let lang = loadedLanguages.get(config.name);
  if (!lang) {
    const wasmPath = config.wasmPath;
    lang = await Language.load(wasmPath);
    loadedLanguages.set(config.name, lang);
  }
  return lang;
}

/** Extract the name from a tree-sitter node (e.g., function name, struct name) */
function extractName(node: SyntaxNode): string {
  // Unwrap export to get inner declaration first
  if (node.type === 'export_statement') {
    const inner = unwrapExport(node);
    if (inner) return extractName(inner);
    return '';
  }
  // Unwrap Python decorated_definition to get inner function/class
  if (node.type === 'decorated_definition') {
    const inner = node.childForFieldName('definition');
    if (inner) return extractName(inner);
    return '';
  }
  // C++ template_declaration: unwrap to inner declaration
  if (node.type === 'template_declaration') {
    const inner = node.namedChildren.find(
      (c) => c.type !== 'template_parameter_list'
    );
    if (inner) return extractName(inner);
    return '';
  }
  // Ruby singleton_method: self.method_name
  if (node.type === 'singleton_method') {
    const obj = node.childForFieldName('object');
    const nameNode = node.childForFieldName('name');
    if (obj && nameNode) return `${obj.text}.${nameNode.text}`;
    if (nameNode) return nameNode.text;
  }
  // Ruby assignment: CONSTANT = value
  if (node.type === 'assignment') {
    const left = node.namedChildren[0];
    if (left) return left.text;
    return '';
  }
  // C function_definition: name is nested inside declarator → function_declarator → declarator
  if (node.type === 'function_definition') {
    const declarator = node.childForFieldName('declarator');
    if (declarator?.type === 'function_declarator') {
      const fnName = declarator.childForFieldName('declarator');
      if (fnName) return fnName.text;
    }
  }
  // C type_definition: name is the type_identifier child
  if (node.type === 'type_definition') {
    const child = node.namedChildren.find((c) => c.type === 'type_identifier');
    if (child) return child.text;
  }
  // Go method_declaration: receiver.Type.Name
  if (node.type === 'method_declaration') {
    const nameNode = node.childForFieldName('name');
    const receiver = node.childForFieldName('receiver');
    if (nameNode && receiver) {
      const paramType =
        receiver.namedChildren?.[0]?.childForFieldName?.('type');
      if (paramType) return `${paramType.text}.${nameNode.text}`;
    }
    if (nameNode) return nameNode.text;
  }
  // Go type_declaration: extract from type_spec child
  if (node.type === 'type_declaration') {
    const spec = node.namedChildren.find((c) => c.type === 'type_spec');
    if (spec) {
      const nameNode = spec.childForFieldName('name');
      if (nameNode) return nameNode.text;
    }
  }
  // Go const_declaration / var_declaration: extract from spec child
  if (node.type === 'const_declaration' || node.type === 'var_declaration') {
    const spec = node.namedChildren.find(
      (c) => c.type === 'const_spec' || c.type === 'var_spec'
    );
    if (spec) {
      const nameNode = spec.childForFieldName('name');
      if (nameNode) return nameNode.text;
    }
  }
  // Scala val_definition: name is in "pattern" field
  if (node.type === 'val_definition') {
    const pattern = node.childForFieldName('pattern');
    if (pattern) return pattern.text;
  }
  // Zig variable_declaration: name is first identifier child (no field name)
  if (node.type === 'variable_declaration') {
    const ident = node.namedChildren.find((c) => c.type === 'identifier');
    if (ident) return ident.text;
  }
  // Zig test_declaration: name is the string child (not "string_literal")
  if (node.type === 'test_declaration') {
    const str = node.namedChildren.find(
      (c) => c.type === 'string' || c.type === 'string_literal'
    );
    if (str) return str.text.replace(/^"|"$/g, '');
  }
  // Try common child field names for identifiers
  for (const childType of ['name', 'identifier', 'type_identifier']) {
    const child = node.childForFieldName(childType);
    if (child) return child.text;
  }
  // Rust impl blocks: look for type (and optional trait)
  const typeNode = node.childForFieldName('type');
  if (typeNode) {
    const traitNode = node.childForFieldName('trait');
    if (traitNode) return `${traitNode.text} for ${typeNode.text}`;
    return typeNode.text;
  }
  // JS/TS variable/lexical declarations: extract from first declarator
  if (node.type === 'lexical_declaration') {
    const declarator = node.namedChildren.find(
      (c) => c.type === 'variable_declarator'
    );
    if (declarator) {
      const nameNode = declarator.childForFieldName('name');
      if (nameNode) return nameNode.text;
    }
  }
  return '';
}

/** Unwrap export_statement to get the inner declaration */
function unwrapExport(node: SyntaxNode): SyntaxNode | null {
  if (node.type !== 'export_statement') return null;
  for (const child of node.namedChildren) {
    if (child.type !== 'decorator' && child.type !== 'comment') {
      return child;
    }
  }
  return null;
}

/** Extract the first line (signature) of a node */
function extractSignature(node: SyntaxNode, sourceLines: string[]): string {
  const startLine = node.startPosition.row;
  return sourceLines[startLine]?.trim() ?? '';
}

/** Chunk a single source file using tree-sitter AST */
export async function chunkFile(
  filePath: string,
  content: string,
  fileHash: string,
  config: LanguageConfig
): Promise<CodeChunk[]> {
  const p = await ensureParser();
  const lang = await getLanguage(config);
  p.setLanguage(lang);

  const tree = p.parse(content);
  if (!tree) return [];
  const sourceLines = content.split('\n');
  const chunks: CodeChunk[] = [];

  const topLevelSet = new Set(config.topLevelNodes);
  const splitSet = new Set(config.splitNodes);

  function makeChunk(node: SyntaxNode, kind: string): CodeChunk {
    const startLine = node.startPosition.row + 1; // 1-based
    const endLine = node.endPosition.row + 1;
    const name = extractName(node);
    const signature = extractSignature(node, sourceLines);
    const snippet = node.text;

    return {
      chunkKey: `${filePath}:${startLine}:${endLine}`,
      filePath,
      language: config.name,
      kind,
      name,
      signature,
      snippet,
      startLine,
      endLine,
      fileHash,
    };
  }

  function nodeKind(type: string): string {
    // Normalize tree-sitter node types to simpler kind names
    if (type.includes('function') || type === 'function_item')
      return 'function';
    if (type.includes('struct')) return 'struct';
    if (type.includes('enum')) return 'enum';
    if (type.includes('impl')) return 'impl';
    if (type.includes('trait')) return 'trait';
    if (
      type === 'type_item' ||
      type === 'type_alias_declaration' ||
      type === 'type_definition' ||
      type === 'type_declaration'
    )
      return 'type';
    if (type.includes('const')) return 'const';
    if (type.includes('static')) return 'static';
    if (
      type.includes('macro') ||
      type === 'preproc_def' ||
      type === 'preproc_function_def'
    )
      return 'macro';
    if (type === 'namespace_definition') return 'namespace';
    if (type === 'template_declaration') return 'template';
    if (type.includes('mod')) return 'module';
    if (type.includes('class')) return 'class';
    if (type === 'method_declaration') return 'method';
    if (type.includes('method')) return 'method';
    if (type.includes('interface')) return 'interface';
    if (
      type === 'variable_declaration' ||
      type === 'lexical_declaration' ||
      type === 'var_declaration' ||
      type === 'val_definition' ||
      type === 'assignment'
    )
      return 'variable';
    if (type === 'declaration') return 'declaration';
    if (type === 'decorated_definition') return 'function'; // will be refined by inner node
    if (type === 'test_declaration') return 'test';
    if (type === 'object_definition') return 'object';
    if (type === 'record_declaration') return 'record';
    if (type === 'constructor_declaration') return 'constructor';
    return type;
  }

  function processNode(node: SyntaxNode): void {
    // Unwrap export statements to get inner declaration
    if (node.type === 'export_statement') {
      const inner = unwrapExport(node);
      if (inner && topLevelSet.has(inner.type)) {
        // Use the export node for line range (includes `export` keyword) but inner for kind/name
        const kind = nodeKind(inner.type);
        const lineCount = node.endPosition.row - node.startPosition.row + 1;

        if (lineCount <= MAX_CHUNK_LINES || !splitSet.has(inner.type)) {
          chunks.push(makeChunk(node, kind));
        } else {
          splitLargeNode(inner, node);
        }
        return;
      }
      // export_statement with no recognizable inner declaration (e.g. `export default expr`)
      // — skip variable-like default exports, keep function/class
      if (
        inner &&
        (inner.type.includes('function') || inner.type.includes('class'))
      ) {
        chunks.push(makeChunk(node, nodeKind(inner.type)));
      }
      return;
    }

    // Unwrap Python decorated_definition to get inner function/class
    if (node.type === 'decorated_definition') {
      const inner = node.childForFieldName('definition');
      if (inner) {
        const kind = nodeKind(inner.type);
        const lineCount = node.endPosition.row - node.startPosition.row + 1;
        if (lineCount <= MAX_CHUNK_LINES || !splitSet.has(inner.type)) {
          chunks.push(makeChunk(node, kind));
        } else {
          splitLargeNode(inner, node);
        }
        return;
      }
    }

    // Unwrap C++ template declarations to get inner class/function
    if (node.type === 'template_declaration') {
      const inner = node.namedChildren.find(
        (c) => c.type !== 'template_parameter_list'
      );
      if (inner) {
        const kind = nodeKind(inner.type);
        const lineCount = node.endPosition.row - node.startPosition.row + 1;
        if (lineCount <= MAX_CHUNK_LINES || !splitSet.has(inner.type)) {
          chunks.push(makeChunk(node, kind));
        } else {
          splitLargeNode(inner, node);
        }
        return;
      }
    }

    if (!topLevelSet.has(node.type)) return;

    const lineCount = node.endPosition.row - node.startPosition.row + 1;
    const kind = nodeKind(node.type);

    if (lineCount <= MAX_CHUNK_LINES || !splitSet.has(node.type)) {
      chunks.push(makeChunk(node, kind));
      return;
    }

    splitLargeNode(node, node);
  }

  // Body wrapper node types that contain the actual sub-items of a class/module/namespace
  const bodyWrappers = new Set([
    'class_body', // TS/JS/Java
    'declaration_list', // C++/PHP namespace/class body
    'field_declaration_list', // C++ struct/class body
    'body_statement', // Ruby module/class body
    'block', // Python class body
  ]);

  function splitLargeNode(node: SyntaxNode, outerNode: SyntaxNode): void {
    // Large item (e.g., big class/impl block): split into sub-items
    let hasSubItems = false;

    function isSubItem(type: string): boolean {
      return (
        topLevelSet.has(type) ||
        type.includes('function') ||
        type.includes('method') ||
        type.includes('constructor')
      );
    }

    for (const sub of node.children) {
      if (isSubItem(sub.type)) {
        chunks.push(makeChunk(sub, nodeKind(sub.type)));
        hasSubItems = true;
      } else if (bodyWrappers.has(sub.type)) {
        // Walk into body wrapper nodes (class_body, declaration_list, etc.)
        for (const inner of sub.children) {
          if (isSubItem(inner.type)) {
            chunks.push(makeChunk(inner, nodeKind(inner.type)));
            hasSubItems = true;
          }
        }
      }
    }

    // If no sub-items found, emit the whole block
    if (!hasSubItems) {
      chunks.push(makeChunk(outerNode, nodeKind(node.type)));
    }
  }

  // Walk top-level children of the root node
  for (const child of tree.rootNode.children) {
    processNode(child);
  }

  tree.delete();
  return chunks;
}
