import { Parser, Language } from "web-tree-sitter"
import type { Node as SyntaxNode } from "web-tree-sitter"
import type { CodeChunk } from "./types.ts"
import type { LanguageConfig } from "./languages.ts"

const MAX_CHUNK_LINES = 150

let parserReady: Promise<void> | null = null
let parser: Parser | null = null
const loadedLanguages = new Map<string, Language>()

async function ensureParser(): Promise<Parser> {
  if (!parser) {
    if (!parserReady) {
      parserReady = Parser.init()
    }
    await parserReady
    parser = new Parser()
  }
  return parser
}

async function getLanguage(config: LanguageConfig): Promise<Language> {
  let lang = loadedLanguages.get(config.name)
  if (!lang) {
    const wasmPath = config.wasmPath
    lang = await Language.load(wasmPath)
    loadedLanguages.set(config.name, lang)
  }
  return lang
}

// Elixir call targets that represent definitions
const ELIXIR_DEFINITIONS = new Set([
  "defmodule", "defprotocol", "defimpl",
  "def", "defp", "defmacro", "defmacrop", "defguard", "defguardp", "defdelegate",
  "defstruct", "defexception",
  "schema", "embedded_schema",
])
const ELIXIR_CONTAINERS = new Set(["defmodule", "defprotocol", "defimpl"])

/** Get the Elixir call target identifier (e.g., "def", "defmodule") */
function elixirCallTarget(node: SyntaxNode): string | null {
  if (node.type !== "call") return null
  const target = node.childForFieldName("target")
  if (target?.type === "identifier") return target.text
  return null
}

/** Extract name from an Elixir call node */
function extractElixirName(node: SyntaxNode): string {
  const target = elixirCallTarget(node)
  if (!target) return ""
  const args = node.namedChildren.find(c => c.type === "arguments")
  if (!args) {
    // embedded_schema has no arguments, just a do_block
    if (target === "schema" || target === "embedded_schema") return target
    return ""
  }

  if (target === "defmodule" || target === "defprotocol") {
    const alias = args.namedChildren.find(c => c.type === "alias")
    if (alias) return alias.text
  } else if (target === "defimpl") {
    const alias = args.namedChildren.find(c => c.type === "alias")
    const keywords = args.namedChildren.find(c => c.type === "keywords")
    if (alias && keywords) {
      const forPair = keywords.namedChildren.find(c => c.type === "pair")
      const forValue = forPair?.namedChildren.find(c => c.type === "alias")
      if (forValue) return `${alias.text} for ${forValue.text}`
    }
    if (alias) return alias.text
  } else if (target === "defstruct" || target === "defexception") {
    return target
  } else if (target === "schema" || target === "embedded_schema") {
    return target
  } else {
    // def/defp/defmacro/defguard: first arg is a call node whose target is the function name
    const fnCall = args.namedChildren.find(c => c.type === "call")
    if (fnCall) {
      const fnTarget = fnCall.childForFieldName("target")
      if (fnTarget) return fnTarget.text
    }
    // defguard with binary_operator (when clause): is_admin(user) when ...
    const binOp = args.namedChildren.find(c => c.type === "binary_operator")
    if (binOp) {
      const innerCall = binOp.namedChildren.find(c => c.type === "call")
      if (innerCall) {
        const fnTarget = innerCall.childForFieldName("target")
        if (fnTarget) return fnTarget.text
      }
    }
    // Simple identifier arg (e.g. def to_string(data) without parens)
    const ident = args.namedChildren.find(c => c.type === "identifier")
    if (ident) return ident.text
  }
  return ""
}

/** Map Elixir call target to a normalized kind */
function elixirKind(target: string): string {
  if (target === "defmodule") return "module"
  if (target === "defprotocol") return "protocol"
  if (target === "defimpl") return "impl"
  if (target === "def" || target === "defp") return "function"
  if (target === "defmacro" || target === "defmacrop") return "macro"
  if (target === "defguard" || target === "defguardp") return "guard"
  if (target === "defdelegate") return "function"
  if (target === "defstruct") return "struct"
  if (target === "defexception") return "struct"
  if (target === "schema" || target === "embedded_schema") return "schema"
  return target
}

/** Extract the name from a tree-sitter node (e.g., function name, struct name) */
function extractName(node: SyntaxNode): string {
  // Elixir call nodes: extract name based on call target
  if (node.type === "call") {
    const target = elixirCallTarget(node)
    if (target && ELIXIR_DEFINITIONS.has(target)) return extractElixirName(node)
  }
  // Unwrap export to get inner declaration first
  if (node.type === "export_statement") {
    const inner = unwrapExport(node)
    if (inner) return extractName(inner)
    return ""
  }
  // Unwrap Python decorated_definition to get inner function/class
  if (node.type === "decorated_definition") {
    const inner = node.childForFieldName("definition")
    if (inner) return extractName(inner)
    return ""
  }
  // C++ template_declaration: unwrap to inner declaration
  if (node.type === "template_declaration") {
    const inner = node.namedChildren.find(c => c.type !== "template_parameter_list")
    if (inner) return extractName(inner)
    return ""
  }
  // Ruby singleton_method: self.method_name
  if (node.type === "singleton_method") {
    const obj = node.childForFieldName("object")
    const nameNode = node.childForFieldName("name")
    if (obj && nameNode) return `${obj.text}.${nameNode.text}`
    if (nameNode) return nameNode.text
  }
  // Ruby assignment: CONSTANT = value
  if (node.type === "assignment") {
    const left = node.namedChildren[0]
    if (left) return left.text
    return ""
  }
  // C function_definition: name is nested inside declarator → function_declarator → declarator
  if (node.type === "function_definition") {
    const declarator = node.childForFieldName("declarator")
    if (declarator?.type === "function_declarator") {
      const fnName = declarator.childForFieldName("declarator")
      if (fnName) return fnName.text
    }
  }
  // C type_definition: name is the type_identifier child
  if (node.type === "type_definition") {
    const child = node.namedChildren.find(c => c.type === "type_identifier")
    if (child) return child.text
  }
  // Go method_declaration: receiver.Type.Name
  if (node.type === "method_declaration") {
    const nameNode = node.childForFieldName("name")
    const receiver = node.childForFieldName("receiver")
    if (nameNode && receiver) {
      const paramType = receiver.namedChildren?.[0]?.childForFieldName?.("type")
      if (paramType) return `${paramType.text}.${nameNode.text}`
    }
    if (nameNode) return nameNode.text
  }
  // Go type_declaration: extract from type_spec child
  if (node.type === "type_declaration") {
    const spec = node.namedChildren.find(c => c.type === "type_spec")
    if (spec) {
      const nameNode = spec.childForFieldName("name")
      if (nameNode) return nameNode.text
    }
  }
  // Go const_declaration / var_declaration: extract from spec child
  if (node.type === "const_declaration" || node.type === "var_declaration") {
    const spec = node.namedChildren.find(c => c.type === "const_spec" || c.type === "var_spec")
    if (spec) {
      const nameNode = spec.childForFieldName("name")
      if (nameNode) return nameNode.text
    }
  }
  // Scala val_definition: name is in "pattern" field
  if (node.type === "val_definition") {
    const pattern = node.childForFieldName("pattern")
    if (pattern) return pattern.text
  }
  // Zig variable_declaration: name is first identifier child (no field name)
  if (node.type === "variable_declaration") {
    const ident = node.namedChildren.find(c => c.type === "identifier")
    if (ident) return ident.text
  }
  // Zig test_declaration: name is the string child (not "string_literal")
  if (node.type === "test_declaration") {
    const str = node.namedChildren.find(c => c.type === "string" || c.type === "string_literal")
    if (str) return str.text.replace(/^"|"$/g, "")
  }
  // Try common child field names for identifiers
  for (const childType of ["name", "identifier", "type_identifier"]) {
    const child = node.childForFieldName(childType)
    if (child) return child.text
  }
  // Rust impl blocks: look for type (and optional trait)
  const typeNode = node.childForFieldName("type")
  if (typeNode) {
    const traitNode = node.childForFieldName("trait")
    if (traitNode) return `${traitNode.text} for ${typeNode.text}`
    return typeNode.text
  }
  // JS/TS variable/lexical declarations: extract from first declarator
  if (node.type === "lexical_declaration") {
    const declarator = node.namedChildren.find(c => c.type === "variable_declarator")
    if (declarator) {
      const nameNode = declarator.childForFieldName("name")
      if (nameNode) return nameNode.text
    }
  }
  return ""
}

/** Unwrap export_statement to get the inner declaration */
function unwrapExport(node: SyntaxNode): SyntaxNode | null {
  if (node.type !== "export_statement") return null
  for (const child of node.namedChildren) {
    if (child.type !== "decorator" && child.type !== "comment") {
      return child
    }
  }
  return null
}

/** Extract the first line (signature) of a node */
function extractSignature(node: SyntaxNode, sourceLines: string[]): string {
  const startLine = node.startPosition.row
  return sourceLines[startLine]?.trim() ?? ""
}

/** Chunk a single source file using tree-sitter AST */
export async function chunkFile(
  filePath: string,
  content: string,
  fileHash: string,
  config: LanguageConfig,
): Promise<CodeChunk[]> {
  const p = await ensureParser()
  const lang = await getLanguage(config)
  p.setLanguage(lang)

  const tree = p.parse(content)
  if (!tree) return []
  const sourceLines = content.split("\n")
  const chunks: CodeChunk[] = []

  const topLevelSet = new Set(config.topLevelNodes)
  const splitSet = new Set(config.splitNodes)

  function makeChunk(node: SyntaxNode, kind: string): CodeChunk {
    const startLine = node.startPosition.row + 1  // 1-based
    const endLine = node.endPosition.row + 1
    const name = extractName(node)
    const signature = extractSignature(node, sourceLines)
    const snippet = node.text

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
    }
  }

  function nodeKind(type: string): string {
    // Normalize tree-sitter node types to simpler kind names
    if (type.includes("function") || type === "function_item") return "function"
    if (type.includes("struct")) return "struct"
    if (type.includes("enum")) return "enum"
    if (type.includes("impl")) return "impl"
    if (type.includes("trait")) return "trait"
    if (type === "type_item" || type === "type_alias_declaration" || type === "type_definition" || type === "type_declaration") return "type"
    if (type.includes("const")) return "const"
    if (type.includes("static")) return "static"
    if (type.includes("macro") || type === "preproc_def" || type === "preproc_function_def") return "macro"
    if (type === "namespace_definition") return "namespace"
    if (type === "template_declaration") return "template"
    if (type.includes("mod")) return "module"
    if (type.includes("class")) return "class"
    if (type === "method_declaration") return "method"
    if (type.includes("method")) return "method"
    if (type.includes("interface")) return "interface"
    if (type === "variable_declaration" || type === "lexical_declaration" || type === "var_declaration" || type === "val_definition" || type === "assignment") return "variable"
    if (type === "declaration") return "declaration"
    if (type === "decorated_definition") return "function" // will be refined by inner node
    if (type === "test_declaration") return "test"
    if (type === "object_definition") return "object"
    if (type === "record_declaration") return "record"
    if (type === "constructor_declaration") return "constructor"
    return type
  }

  function processNode(node: SyntaxNode): void {
    // Unwrap export statements to get inner declaration
    if (node.type === "export_statement") {
      const inner = unwrapExport(node)
      if (inner && topLevelSet.has(inner.type)) {
        // Use the export node for line range (includes `export` keyword) but inner for kind/name
        const kind = nodeKind(inner.type)
        const lineCount = node.endPosition.row - node.startPosition.row + 1

        if (lineCount <= MAX_CHUNK_LINES || !splitSet.has(inner.type)) {
          chunks.push(makeChunk(node, kind))
        } else {
          splitLargeNode(inner, node)
        }
        return
      }
      // export_statement with no recognizable inner declaration (e.g. `export default expr`)
      // — skip variable-like default exports, keep function/class
      if (inner && (inner.type.includes("function") || inner.type.includes("class"))) {
        chunks.push(makeChunk(node, nodeKind(inner.type)))
      }
      return
    }

    // Unwrap Python decorated_definition to get inner function/class
    if (node.type === "decorated_definition") {
      const inner = node.childForFieldName("definition")
      if (inner) {
        const kind = nodeKind(inner.type)
        const lineCount = node.endPosition.row - node.startPosition.row + 1
        if (lineCount <= MAX_CHUNK_LINES || !splitSet.has(inner.type)) {
          chunks.push(makeChunk(node, kind))
        } else {
          splitLargeNode(inner, node)
        }
        return
      }
    }

    // Unwrap C++ template declarations to get inner class/function
    if (node.type === "template_declaration") {
      const inner = node.namedChildren.find(c => c.type !== "template_parameter_list")
      if (inner) {
        const kind = nodeKind(inner.type)
        const lineCount = node.endPosition.row - node.startPosition.row + 1
        if (lineCount <= MAX_CHUNK_LINES || !splitSet.has(inner.type)) {
          chunks.push(makeChunk(node, kind))
        } else {
          splitLargeNode(inner, node)
        }
        return
      }
    }

    // Elixir: all definitions are `call` nodes — filter by target identifier
    if (config.name === "elixir" && node.type === "call") {
      const target = elixirCallTarget(node)
      if (!target || !ELIXIR_DEFINITIONS.has(target)) return
      const kind = elixirKind(target)
      const lineCount = node.endPosition.row - node.startPosition.row + 1
      if (lineCount <= MAX_CHUNK_LINES || !ELIXIR_CONTAINERS.has(target)) {
        chunks.push(makeChunk(node, kind))
      } else {
        splitElixirContainer(node)
      }
      return
    }

    if (!topLevelSet.has(node.type)) return

    const lineCount = node.endPosition.row - node.startPosition.row + 1
    const kind = nodeKind(node.type)

    if (lineCount <= MAX_CHUNK_LINES || !splitSet.has(node.type)) {
      chunks.push(makeChunk(node, kind))
      return
    }

    splitLargeNode(node, node)
  }

  // Body wrapper node types that contain the actual sub-items of a class/module/namespace
  const bodyWrappers = new Set([
    "class_body",              // TS/JS/Java
    "declaration_list",        // C++/PHP namespace/class body
    "field_declaration_list",  // C++ struct/class body
    "body_statement",          // Ruby module/class body
    "block",                   // Python class body
  ])

  // Elixir module attributes that should be attached to the next definition
  const ELIXIR_ANNOTATIONS = new Set(["doc", "spec", "impl"])

  /** Create a chunk spanning from annotationStart to defNode's end */
  function makeElixirChunkWithAnnotations(
    defNode: SyntaxNode,
    kind: string,
    annotationStartRow: number,
  ): CodeChunk {
    const startLine = annotationStartRow + 1 // 1-based
    const endLine = defNode.endPosition.row + 1
    const name = extractName(defNode)
    const signature = extractSignature(defNode, sourceLines)
    const snippet = sourceLines.slice(annotationStartRow, defNode.endPosition.row + 1).join("\n")
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
    }
  }

  /** Get the call target of a unary_operator's inner call (e.g., @doc → "doc") */
  function elixirAttributeTarget(node: SyntaxNode): string | null {
    if (node.type !== "unary_operator") return null
    const inner = node.namedChildren.find(c => c.type === "call")
    if (!inner) return null
    const target = inner.childForFieldName("target")
    if (target?.type === "identifier") return target.text
    return null
  }

  function splitElixirContainer(node: SyntaxNode): void {
    const doBlock = node.namedChildren.find(c => c.type === "do_block")
    if (!doBlock) {
      chunks.push(makeChunk(node, elixirKind(elixirCallTarget(node) ?? "call")))
      return
    }

    const moduleName = extractElixirName(node)
    const children = doBlock.namedChildren
    let hasSubItems = false
    let pendingAnnotationStart: number | null = null

    for (let i = 0; i < children.length; i++) {
      const child = children[i]!

      // @moduledoc → emit as its own chunk
      const attrTarget = elixirAttributeTarget(child)
      if (attrTarget === "moduledoc") {
        const startLine = child.startPosition.row + 1
        const endLine = child.endPosition.row + 1
        chunks.push({
          chunkKey: `${filePath}:${startLine}:${endLine}`,
          filePath,
          language: config.name,
          kind: "doc",
          name: moduleName,
          signature: sourceLines[child.startPosition.row]?.trim() ?? "",
          snippet: child.text,
          startLine,
          endLine,
          fileHash,
        })
        hasSubItems = true
        continue
      }

      // @doc/@spec/@impl → remember start position for the next definition
      if (attrTarget && ELIXIR_ANNOTATIONS.has(attrTarget)) {
        if (pendingAnnotationStart === null) {
          pendingAnnotationStart = child.startPosition.row
        }
        continue
      }

      // Definition → emit with any preceding annotations
      const target = elixirCallTarget(child)
      if (target && ELIXIR_DEFINITIONS.has(target)) {
        if (pendingAnnotationStart !== null) {
          chunks.push(makeElixirChunkWithAnnotations(child, elixirKind(target), pendingAnnotationStart))
        } else {
          chunks.push(makeChunk(child, elixirKind(target)))
        }
        hasSubItems = true
        pendingAnnotationStart = null
        continue
      }

      // Anything else (use, import, etc.) — reset pending annotations
      pendingAnnotationStart = null
    }

    if (!hasSubItems) {
      chunks.push(makeChunk(node, elixirKind(elixirCallTarget(node) ?? "call")))
    }
  }

  function splitLargeNode(node: SyntaxNode, outerNode: SyntaxNode): void {
    // Large item (e.g., big class/impl block): split into sub-items
    let hasSubItems = false

    function isSubItem(type: string): boolean {
      return topLevelSet.has(type) || type.includes("function") || type.includes("method") || type.includes("constructor")
    }

    for (const sub of node.children) {
      if (isSubItem(sub.type)) {
        chunks.push(makeChunk(sub, nodeKind(sub.type)))
        hasSubItems = true
      } else if (bodyWrappers.has(sub.type)) {
        // Walk into body wrapper nodes (class_body, declaration_list, etc.)
        for (const inner of sub.children) {
          if (isSubItem(inner.type)) {
            chunks.push(makeChunk(inner, nodeKind(inner.type)))
            hasSubItems = true
          }
        }
      }
    }

    // If no sub-items found, emit the whole block
    if (!hasSubItems) {
      chunks.push(makeChunk(outerNode, nodeKind(node.type)))
    }
  }

  // Walk top-level children of the root node
  for (const child of tree.rootNode.children) {
    processNode(child)
  }

  tree.delete()
  return chunks
}
