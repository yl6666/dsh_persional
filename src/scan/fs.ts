/**
 * Filesystem scanner - reads one repo directory into the pure extractors'
 * input shape (docs/product-design.md 4.3).
 *
 * Walks the directory skipping dependency/build outputs, classifies each
 * text file as manifest, contract, or searchable source, and reads it as
 * UTF-8. Node-only module: kept out of the browser-safe core export.
 * @module dsh-repo-board
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { isContractFile } from '../extract/contract.ts'
import { MANIFEST_FILES, contentFingerprint } from '../extract/manifest.ts'

/** Directories never descended into. */
const SKIP_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.nuxt',
  'coverage',
  '.turbo',
  '.cache',
]

/** Extensions never read as text. */
const BINARY_EXTENSIONS: readonly string[] = [
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.svgz',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.zip', '.gz', '.tar', '.tgz', '.bz2', '.7z', '.rar',
  '.jar', '.class', '.war',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.obj', '.o', '.a',
  '.pdf', '.mp4', '.mp3', '.wav', '.avi', '.mov',
  '.wasm', '.node', '.pyc', '.ds_store',
]

/** One repo's files classified for the extraction pipeline. */
export interface ScannedRepoFiles {
  /** Root manifests plus gemspecs, path -> content. */
  readonly manifest: Record<string, string>
  /** Contract-bearing files, path -> content. */
  readonly contracts: Record<string, string>
  /** Remaining searchable text files, path -> content. */
  readonly sources: Record<string, string>
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

function isBinary(name: string): boolean {
  const lower = name.toLowerCase()
  return BINARY_EXTENSIONS.some(ext => lower.endsWith(ext))
}

/**
 * Walk one repo directory and classify its text files. Manifests are matched
 * by exact root-relative path (`package.json`, `go.mod`, ...) plus any
 * `*.gemspec`; contracts by {@link isContractFile}; everything else lands in
 * sources.
 */
export async function scanRepoDirectory(dir: string): Promise<ScannedRepoFiles> {
  const manifest: Record<string, string> = {}
  const contracts: Record<string, string> = {}
  const sources: Record<string, string> = {}

  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.includes(entry.name)) continue
        await walk(absolute)
        continue
      }
      if (!entry.isFile() || isBinary(entry.name)) continue
      const rel = toPosix(relative(dir, absolute))
      const content = await readFile(absolute, 'utf8')
      if (MANIFEST_FILES.includes(rel) || rel.endsWith('.gemspec')) {
        manifest[rel] = content
        continue
      }
      if (isContractFile(rel)) {
        contracts[rel] = content
        continue
      }
      sources[rel] = content
    }
  }

  await walk(dir)
  return { manifest, contracts, sources }
}

/**
 * Fingerprint over the manifest + contract files (design 4.4): the rescan
 * driver. v0.1 always rescans and merges idempotently; the fingerprint is
 * stored on the node for future skip-if-unchanged optimizations.
 */
export function scannedFingerprint(files: ScannedRepoFiles): string {
  return contentFingerprint({ ...files.manifest, ...files.contracts })
}
