import { describe, test, expect } from "bun:test"

import { mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { scanDirectory } from "../src/scan/walker.ts"

function setupFixture(gitignore: string, dirs: string[], files: Record<string, string>) {
  const tmp = join(import.meta.dir, ".tmp-walker-test")
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  writeFileSync(join(tmp, ".gitignore"), gitignore)
  for (const d of dirs) mkdirSync(join(tmp, d), { recursive: true })
  for (const [f, content] of Object.entries(files)) writeFileSync(join(tmp, f), content)
  return tmp
}

function cleanupFixture() {
  const tmp = join(import.meta.dir, ".tmp-walker-test")
  rmSync(tmp, { recursive: true, force: true })
}

describe("loadIgnorePatterns via scanDirectory", () => {
  test("plain name patterns are ignored", async () => {
    const tmp = setupFixture("vendor\n", ["vendor"], { "vendor/main.ts": "export const x = 1", "keep.ts": "export const y = 2" })
    try {
      const { files } = await scanDirectory(tmp)
      const names = files.map(f => f.relPath)
      expect(names).toContain("keep.ts")
      expect(names).not.toContain("vendor/main.ts")
    } finally {
      cleanupFixture()
    }
  })

  test("**/name/ patterns are ignored", async () => {
    const tmp = setupFixture("**/Pods/\n**/vendor/\n", ["Pods", "vendor"], { "Pods/lib.ts": "export const a = 1", "vendor/dep.ts": "export const b = 2", "app.ts": "export const c = 3" })
    try {
      const { files } = await scanDirectory(tmp)
      const names = files.map(f => f.relPath)
      expect(names).toContain("app.ts")
      expect(names).not.toContain("Pods/lib.ts")
      expect(names).not.toContain("vendor/dep.ts")
    } finally {
      cleanupFixture()
    }
  })

  test("**/name patterns without trailing slash are ignored", async () => {
    const tmp = setupFixture("**/generated\n", ["generated"], { "generated/out.ts": "export const x = 1", "src.ts": "export const y = 2" })
    try {
      const { files } = await scanDirectory(tmp)
      const names = files.map(f => f.relPath)
      expect(names).toContain("src.ts")
      expect(names).not.toContain("generated/out.ts")
    } finally {
      cleanupFixture()
    }
  })

  test("*.ext glob patterns are still skipped", async () => {
    const tmp = setupFixture("*.log\n", [], { "app.ts": "export const x = 1", "debug.log": "some log" })
    try {
      const { files } = await scanDirectory(tmp)
      const names = files.map(f => f.relPath)
      expect(names).toContain("app.ts")
    } finally {
      cleanupFixture()
    }
  })

  test("complex glob patterns like src/** are skipped", async () => {
    const tmp = setupFixture("src/**\n", ["src"], { "src/index.ts": "export const x = 1" })
    try {
      const { files } = await scanDirectory(tmp)
      const names = files.map(f => f.relPath)
      expect(names).toContain("src/index.ts")
    } finally {
      cleanupFixture()
    }
  })
})
