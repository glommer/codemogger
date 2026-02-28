import { test, expect, describe } from "bun:test"
import { chunkFile } from "../src/chunk/treesitter.ts"
import { detectLanguage } from "../src/chunk/languages.ts"

const ELIXIR_CONFIG = detectLanguage("test.ex")!

describe("elixir chunking", () => {
  test("detects .ex and .exs files", () => {
    expect(detectLanguage("lib/my_app/auth.ex")).not.toBeNull()
    expect(detectLanguage("lib/my_app/auth.ex")!.name).toBe("elixir")
    expect(detectLanguage("test/my_app_test.exs")).not.toBeNull()
    expect(detectLanguage("test/my_app_test.exs")!.name).toBe("elixir")
  })

  test("extracts public function", async () => {
    const source = `def login(email, password) do
  {:ok, email}
end`
    const chunks = await chunkFile("test.ex", source, "hash1", ELIXIR_CONFIG)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.kind).toBe("function")
    expect(chunks[0]!.name).toBe("login")
    expect(chunks[0]!.signature).toBe("def login(email, password) do")
  })

  test("extracts private function", async () => {
    const source = `defp hash_password(password) do
  Bcrypt.hash_pwd_salt(password)
end`
    const chunks = await chunkFile("test.ex", source, "hash1", ELIXIR_CONFIG)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.kind).toBe("function")
    expect(chunks[0]!.name).toBe("hash_password")
  })

  test("extracts defmacro", async () => {
    const source = `defmacro authenticated(do: block) do
  quote do
    if current_user() do
      unquote(block)
    end
  end
end`
    const chunks = await chunkFile("test.ex", source, "hash1", ELIXIR_CONFIG)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.kind).toBe("macro")
    expect(chunks[0]!.name).toBe("authenticated")
  })

  test("extracts defguard", async () => {
    const source = `defguard is_admin(user) when user.role == :admin`
    const chunks = await chunkFile("test.ex", source, "hash1", ELIXIR_CONFIG)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.kind).toBe("guard")
    expect(chunks[0]!.name).toBe("is_admin")
  })

  test("extracts defstruct", async () => {
    const source = `defstruct [:user, :token, :expires_at]`
    const chunks = await chunkFile("test.ex", source, "hash1", ELIXIR_CONFIG)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.kind).toBe("struct")
    expect(chunks[0]!.name).toBe("defstruct")
  })

  test("extracts small defmodule as single chunk", async () => {
    const source = `defmodule MyApp.Auth do
  def login(email) do
    {:ok, email}
  end

  defp validate(email) do
    String.contains?(email, "@")
  end
end`
    const chunks = await chunkFile("test.ex", source, "hash1", ELIXIR_CONFIG)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.kind).toBe("module")
    expect(chunks[0]!.name).toBe("MyApp.Auth")
  })

  test("extracts defprotocol", async () => {
    const source = `defprotocol Stringable do
  def to_string(data)
end`
    const chunks = await chunkFile("test.ex", source, "hash1", ELIXIR_CONFIG)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.kind).toBe("protocol")
    expect(chunks[0]!.name).toBe("Stringable")
  })

  test("extracts defimpl with for clause", async () => {
    const source = `defimpl Stringable, for: MyApp.Auth do
  def to_string(auth) do
    auth.user
  end
end`
    const chunks = await chunkFile("test.ex", source, "hash1", ELIXIR_CONFIG)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.kind).toBe("impl")
    expect(chunks[0]!.name).toBe("Stringable for MyApp.Auth")
  })

  test("ignores regular function calls", async () => {
    const source = `IO.puts("hello")
Enum.map([1, 2, 3], &(&1 * 2))
Logger.info("done")`
    const chunks = await chunkFile("test.ex", source, "hash1", ELIXIR_CONFIG)
    expect(chunks).toHaveLength(0)
  })

  test("ignores use/import/alias/require", async () => {
    const source = `use GenServer
import Ecto.Query
alias MyApp.Repo
require Logger`
    const chunks = await chunkFile("test.ex", source, "hash1", ELIXIR_CONFIG)
    expect(chunks).toHaveLength(0)
  })

  test("splits large module into sub-definitions", async () => {
    // Generate a module >150 lines
    const fns = Array.from({ length: 20 }, (_, i) =>
      `  def func_${i}(x) do\n${Array(6).fill("    x = x + 1").join("\n")}\n    x\n  end`
    ).join("\n\n")
    const source = `defmodule BigModule do\n${fns}\nend`

    const chunks = await chunkFile("test.ex", source, "hash1", ELIXIR_CONFIG)
    // Should split into individual functions, not one giant module chunk
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(c => c.kind === "function")).toBe(true)
    expect(chunks[0]!.name).toBe("func_0")
    expect(chunks[19]!.name).toBe("func_19")
  })

  test("extracts multiple top-level definitions", async () => {
    const source = `defmodule MyApp.Auth do
  def login(email) do
    {:ok, email}
  end
end

defprotocol Stringable do
  def to_string(data)
end

defimpl Stringable, for: MyApp.Auth do
  def to_string(auth) do
    auth.user
  end
end`
    const chunks = await chunkFile("test.ex", source, "hash1", ELIXIR_CONFIG)
    expect(chunks).toHaveLength(3)
    expect(chunks[0]!.kind).toBe("module")
    expect(chunks[0]!.name).toBe("MyApp.Auth")
    expect(chunks[1]!.kind).toBe("protocol")
    expect(chunks[1]!.name).toBe("Stringable")
    expect(chunks[2]!.kind).toBe("impl")
    expect(chunks[2]!.name).toBe("Stringable for MyApp.Auth")
  })

  test("extracts schema block", async () => {
    const source = `schema "users" do
  field :name, :string
  field :email, :string
  timestamps()
end`
    const chunks = await chunkFile("test.ex", source, "hash1", ELIXIR_CONFIG)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.kind).toBe("schema")
    expect(chunks[0]!.name).toBe("schema")
    expect(chunks[0]!.snippet).toContain("field :name")
  })

  test("extracts embedded_schema block", async () => {
    const source = `embedded_schema do
  field :lat, :float
  field :lng, :float
end`
    const chunks = await chunkFile("test.ex", source, "hash1", ELIXIR_CONFIG)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.kind).toBe("schema")
    expect(chunks[0]!.name).toBe("embedded_schema")
  })

  test("includes @doc and @spec in function chunk when module splits", async () => {
    const fns = Array.from({ length: 18 }, (_, i) =>
      `  def filler_${i}(x) do\n${Array(6).fill("    x = x + 1").join("\n")}\n    x\n  end`
    ).join("\n\n")
    const source = `defmodule BigModule do
  @doc "Logs in a user by email and password"
  @spec login(String.t(), String.t()) :: {:ok, map()}
  def login(email, password) do
    {:ok, email}
  end

${fns}
end`
    const chunks = await chunkFile("test.ex", source, "hash1", ELIXIR_CONFIG)
    const loginChunk = chunks.find(c => c.name === "login")!
    expect(loginChunk).toBeDefined()
    expect(loginChunk.snippet).toContain("@doc")
    expect(loginChunk.snippet).toContain("@spec login")
    expect(loginChunk.snippet).toContain("def login(email, password)")
    expect(loginChunk.startLine).toBe(2) // starts at @doc, not def
  })

  test("emits @moduledoc as own chunk when module splits", async () => {
    const fns = Array.from({ length: 18 }, (_, i) =>
      `  def filler_${i}(x) do\n${Array(6).fill("    x = x + 1").join("\n")}\n    x\n  end`
    ).join("\n\n")
    const source = `defmodule BigModule do
  @moduledoc "This module does things"

${fns}
end`
    const chunks = await chunkFile("test.ex", source, "hash1", ELIXIR_CONFIG)
    const docChunk = chunks.find(c => c.kind === "doc")!
    expect(docChunk).toBeDefined()
    expect(docChunk.name).toBe("BigModule")
    expect(docChunk.snippet).toContain("@moduledoc")
    expect(docChunk.snippet).toContain("This module does things")
  })

  test("@impl annotation attached to function chunk when module splits", async () => {
    const fns = Array.from({ length: 18 }, (_, i) =>
      `  def filler_${i}(x) do\n${Array(6).fill("    x = x + 1").join("\n")}\n    x\n  end`
    ).join("\n\n")
    const source = `defmodule BigModule do
  @impl true
  def init(state) do
    {:ok, state}
  end

${fns}
end`
    const chunks = await chunkFile("test.ex", source, "hash1", ELIXIR_CONFIG)
    const initChunk = chunks.find(c => c.name === "init")!
    expect(initChunk).toBeDefined()
    expect(initChunk.snippet).toContain("@impl true")
    expect(initChunk.snippet).toContain("def init(state)")
  })

  test("chunk metadata is correct", async () => {
    const source = `def greet(name) do
  "Hello, #{name}"
end`
    const chunks = await chunkFile("lib/app.ex", source, "abc123", ELIXIR_CONFIG)
    expect(chunks).toHaveLength(1)
    const chunk = chunks[0]!
    expect(chunk.filePath).toBe("lib/app.ex")
    expect(chunk.language).toBe("elixir")
    expect(chunk.fileHash).toBe("abc123")
    expect(chunk.startLine).toBe(1)
    expect(chunk.endLine).toBe(3)
    expect(chunk.chunkKey).toBe("lib/app.ex:1:3")
    expect(chunk.snippet).toContain("def greet(name)")
  })
})
