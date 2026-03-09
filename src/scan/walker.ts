import { readdir, readFile, stat } from 'fs/promises';
import { join, relative } from 'path';
import { createHash } from 'crypto';
import { detectLanguage } from '../chunk/languages.ts';

export interface ScannedFile {
  /** Absolute path */
  absPath: string;
  /** Path relative to the indexed root */
  relPath: string;
  language: string;
  hash: string;
  content: string;
}

/** Directory names to always ignore */
const ALWAYS_IGNORE = new Set([
  '.git',
  'node_modules',
  'target',
  'build',
  'dist',
  '.next',
  '__pycache__',
  '.tox',
  '.venv',
  'venv',
  '.mypy_cache',
  '.cargo',
  '.rustup',
]);

/** Parse .gitignore-style patterns (simplified: directory names only) */
function loadIgnorePatterns(content: string): Set<string> {
  const patterns = new Set<string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Strip trailing slash for directory matching
    const clean = trimmed.replace(/\/$/, '');
    if (clean && !clean.includes('*')) {
      patterns.add(clean);
    }
  }
  return patterns;
}

/** Walk a directory tree and return source files with their content and hashes */
export async function scanDirectory(
  rootDir: string,
  languages?: string[]
): Promise<{ files: ScannedFile[]; errors: string[] }> {
  const files: ScannedFile[] = [];
  const errors: string[] = [];

  // Load .gitignore from root
  let ignorePatterns = new Set<string>();
  try {
    const gitignore = await readFile(join(rootDir, '.gitignore'), 'utf-8');
    ignorePatterns = loadIgnorePatterns(gitignore);
  } catch {
    // no .gitignore
  }

  const langFilter = languages ? new Set(languages) : null;

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      errors.push(`cannot read ${dir}: ${err}`);
      return;
    }

    for (const entry of entries) {
      const name = entry.name;

      // Skip hidden files and always-ignored directories
      if (name.startsWith('.') && name !== '.') continue;
      if (ALWAYS_IGNORE.has(name)) continue;
      if (ignorePatterns.has(name)) continue;

      const fullPath = join(dir, name);

      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      // Check if this is a supported language
      const langConfig = detectLanguage(name);
      if (!langConfig) continue;
      if (langFilter && !langFilter.has(langConfig.name)) continue;

      try {
        const stats = await stat(fullPath);
        // Skip empty files and very large files (>1MB)
        if (stats.size === 0 || stats.size > 1_000_000) continue;

        const content = await readFile(fullPath, 'utf-8');
        const hash = createHash('sha256').update(content).digest('hex');
        const relPath = relative(rootDir, fullPath);

        files.push({
          absPath: fullPath,
          relPath,
          language: langConfig.name,
          hash,
          content,
        });
      } catch (err) {
        errors.push(`cannot read ${fullPath}: ${err}`);
      }
    }
  }

  await walk(rootDir);
  return { files, errors };
}
