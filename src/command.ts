/**
 * Locate the DBX MCP server executable.
 *
 * DBX ships its MCP server as a separate binary (`dbx-mcp`) that is not on the
 * PATH of a normal desktop session. The plugin therefore resolves it in a fixed
 * order and reports where the executable came from, so a wrong setup is visible
 * in the log instead of failing on the first query.
 *
 * @module dsh-data-dbx/command
 */

import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** Executable name of the DBX MCP server. */
export const DEFAULT_MCP_COMMAND = 'dbx-mcp'

/** Where a resolved executable came from. */
export type McpCommandSource = 'config' | 'env' | 'path' | 'well-known' | 'npm' | 'workspace' | 'default'

/** A resolved executable together with its provenance. */
export interface ResolvedMcpCommand {
  /** Executable to spawn. */
  command: string
  /** Where the executable was found. */
  source: McpCommandSource
}

/** Directories that hold user-installed binaries. */
const WELL_KNOWN_BIN_DIRS = ['.local/bin', 'bin', '.npm-global/bin']

/** Roots that may contain a DBX checkout with the published MCP package. */
function workspaceRoots(env: NodeJS.ProcessEnv): string[] {
  const home = env['HOME'] ?? homedir()
  return [
    join(home, 'Github'),
    join(home, 'Projects'),
    join(home, 'src'),
    join(home, 'Developer'),
    join(home, 'code'),
    join(home, 'workspace'),
  ]
}

/** Roots that may contain an npm-installed DBX MCP package. */
function npmRoots(env: NodeJS.ProcessEnv): string[] {
  const roots = [join(env['HOME'] ?? homedir(), '.npm-global/lib/node_modules')]
  const prefix = env['NPM_CONFIG_PREFIX']
  if (prefix) roots.push(join(prefix, 'lib/node_modules'))
  roots.push('/opt/homebrew/lib/node_modules', '/usr/local/lib/node_modules')
  return roots
}

/**
 * Check that a path is a file the current process may execute.
 *
 * @param file - candidate path.
 * @returns whether the path is an executable regular file.
 */
function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * Find an executable on the PATH.
 *
 * @param name - executable name.
 * @param env - environment carrying the PATH.
 * @returns the absolute path, or undefined.
 */
function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const path = env['PATH']
  if (!path) return undefined
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

/**
 * Search a tree for the published DBX MCP binary.
 *
 * The npm package `@dbx-app/mcp-<platform>` installs the executable at
 * `node_modules/@dbx-app/mcp-<platform>/bin/dbx-mcp`.
 *
 * @param roots - directories to search.
 * @param maxDepth - how deep to descend.
 * @returns the absolute path, or undefined.
 */
function findMcpPackage(roots: string[], maxDepth = 6): string | undefined {
  const queue: { dir: string; depth: number }[] = []
  for (const root of roots) queue.push({ dir: root, depth: 0 })
  let visited = 0
  while (queue.length > 0 && visited < 20_000) {
    const { dir, depth } = queue.shift()!
    visited += 1
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (!entry.isDirectory() && entry.isSymbolicLink()) {
        if (entry.name === 'dbx-mcp' && isExecutable(full)) return full
        continue
      }
      if (!entry.isDirectory()) continue
      if (entry.name === '@dbx-app') {
        const packageDirs = (() => {
          try {
            return readdirSync(full, { withFileTypes: true })
          } catch {
            return []
          }
        })()
        for (const pkg of packageDirs) {
          const binary = join(full, pkg.name, 'bin', 'dbx-mcp')
          if (isExecutable(binary)) return binary
        }
        continue
      }
      if (entry.name === 'node_modules' || depth < maxDepth) {
        queue.push({ dir: full, depth: depth + 1 })
      }
    }
  }
  return undefined
}

/**
 * Resolve the DBX MCP server executable.
 *
 * Resolution order: an explicit `command`, the `DBX_MCP_COMMAND` environment
 * variable, the PATH, well-known user binary directories, an npm-installed
 * package, and finally a DBX checkout in the usual workspace directories.
 *
 * @param options - the configured command and the environment to search.
 * @returns the executable to spawn and where it came from.
 */
export function resolveMcpCommand(options: {
  command?: string | undefined
  env?: NodeJS.ProcessEnv
}): ResolvedMcpCommand {
  const env = options.env ?? process.env
  const configured = (options.command ?? '').trim()
  if (configured.length > 0 && configured !== DEFAULT_MCP_COMMAND) {
    return { command: configured, source: 'config' }
  }

  const fromEnv = env['DBX_MCP_COMMAND']
  if (fromEnv && isExecutable(fromEnv)) return { command: fromEnv, source: 'env' }

  const fromPath = findOnPath(DEFAULT_MCP_COMMAND, env)
  if (fromPath) return { command: fromPath, source: 'path' }

  const home = env['HOME'] ?? homedir()
  for (const dir of WELL_KNOWN_BIN_DIRS) {
    const candidate = join(home, dir, DEFAULT_MCP_COMMAND)
    if (isExecutable(candidate)) return { command: candidate, source: 'well-known' }
  }

  const fromNpm = findMcpPackage(npmRoots(env))
  if (fromNpm) return { command: fromNpm, source: 'npm' }

  const fromWorkspace = findMcpPackage(workspaceRoots(env))
  if (fromWorkspace) return { command: fromWorkspace, source: 'workspace' }

  return { command: DEFAULT_MCP_COMMAND, source: 'default' }
}
