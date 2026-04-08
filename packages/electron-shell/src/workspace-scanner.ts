/**
 * Workspace scanner — runs in the Electron main process to gather a
 * lightweight summary of a folder the user just selected.
 *
 * The scan is intentionally shallow:
 *   - file count is a single-level readdir, ignoring common heavy dirs
 *   - stack detection looks at the top-level manifest files only
 *   - git branch is read from `.git/HEAD` directly (no subprocess)
 *
 * The studio renderer never reaches into the filesystem itself — all
 * disk I/O lives here so the renderer stays sandbox-safe.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
  type WorkspaceInfo,
  type WorkspaceStack,
  StudioError,
  createLogger,
} from '@agent-studio/shared'

const log = createLogger('electron-shell:workspace')

/** Folders we never count as "files" — they bloat the count and aren't user code. */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.cache',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.pytest_cache',
  '.idea',
  '.vscode',
])

/** Manifest filenames that uniquely identify a stack. */
const STACK_MANIFESTS: Array<{ file: string; stack: WorkspaceStack }> = [
  { file: 'package.json', stack: 'node' },
  { file: 'Cargo.toml', stack: 'rust' },
  { file: 'pyproject.toml', stack: 'python' },
  { file: 'requirements.txt', stack: 'python' },
  { file: 'setup.py', stack: 'python' },
  { file: 'go.mod', stack: 'go' },
  { file: 'Gemfile', stack: 'ruby' },
  { file: 'pom.xml', stack: 'java' },
  { file: 'build.gradle', stack: 'java' },
]

/** Scan a folder and return its `WorkspaceInfo`. */
export const scanWorkspace = async (folderPath: string): Promise<WorkspaceInfo> => {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(folderPath, { withFileTypes: true })
  } catch (cause) {
    throw new StudioError('WORKSPACE_READ_FAILED', {
      message: `Could not read folder: ${folderPath}`,
      cause,
      context: { path: folderPath },
    })
  }

  const fileCount = countFiles(entries)
  const stack = detectStack(entries)
  const gitBranch = await readGitBranch(folderPath)

  const info: WorkspaceInfo = {
    path: folderPath,
    name: path.basename(folderPath),
    fileCount,
    stack,
    gitBranch,
    scannedAt: Date.now(),
  }
  log.info('workspace scanned', { path: folderPath, fileCount, stack, gitBranch })
  return info
}

/** Count files in the top level, ignoring noisy directories. */
const countFiles = (entries: readonly import('node:fs').Dirent[]): number => {
  let count = 0
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      // Subdirs aren't recursed — file count is intentionally shallow.
      continue
    }
    if (entry.isFile()) count += 1
  }
  return count
}

/** Pick the first matching stack from `STACK_MANIFESTS`, or 'unknown'. */
const detectStack = (entries: readonly import('node:fs').Dirent[]): WorkspaceStack => {
  const fileNames = new Set(entries.filter((e) => e.isFile()).map((e) => e.name))
  for (const candidate of STACK_MANIFESTS) {
    if (fileNames.has(candidate.file)) return candidate.stack
  }
  return 'unknown'
}

/**
 * Read the current git branch from `.git/HEAD` without spawning git.
 *
 * `.git/HEAD` either contains a ref pointer (e.g. `ref: refs/heads/main\n`)
 * or a detached commit hash. We only handle the ref form — detached HEAD
 * shows as `null`.
 */
const readGitBranch = async (folderPath: string): Promise<string | null> => {
  try {
    const headPath = path.join(folderPath, '.git', 'HEAD')
    const raw = await fs.readFile(headPath, 'utf8')
    const match = raw.trim().match(/^ref:\s*refs\/heads\/(.+)$/)
    if (match && match[1]) return match[1]
    return null
  } catch {
    // Not a git repo, or HEAD is unreadable — both fine.
    return null
  }
}
