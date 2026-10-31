import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** A failure attributed to one external home, with a stable code for the wire. */
export class SourceFault extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.code = code
  }
}

const GENERATION_FILE = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/
const LEGACY_FLAT_FILE = /\.jsonl(?:\.zstd)?$/
const WINDOWS_QUALIFIED = /^[A-Za-z]:[\\/]|^\\\\/

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** True when `value` names one absolute, fully qualified path on this platform. */
export function isFullyQualifiedPath(value) {
  if (typeof value !== 'string' || value === '' || value.includes('\0')) return false
  if (!isAbsolute(value)) return false
  return process.platform !== 'win32' || WINDOWS_QUALIFIED.test(value)
}

/** Case-fold a path for identity comparisons on Windows. */
export function comparablePath(value) {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

/** The final path segment, or the whole spelling for a filesystem root. */
export function homeLeaf(homePath) {
  const stripped = homePath.replace(/[\\/]+$/, '')
  const leaf = basename(stripped)
  return leaf === '' ? homePath : leaf
}

function assertInside(root, candidate) {
  const rel = relative(root, candidate)
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return
  throw new SourceFault('unsafe-path', 'A sessions path resolves outside its home.')
}

async function checkedRealpath(root, candidate) {
  const actual = await realpath(candidate)
  assertInside(root, actual)
  return actual
}

/**
 * Classify one entry of a sessions tree. Every caller passes a directory whose
 * real path is already known, so a single-segment child cannot escape it; the
 * real-path check on directories still catches a junction or symlinked level.
 */
async function classifyEntry(root, path, label) {
  const info = await lstat(path)
  if (info.isSymbolicLink()) {
    throw new SourceFault('symlink', `A symbolic link was found in the sessions ${label}.`)
  }
  if (info.isFile()) return 'file'
  if (info.isDirectory()) {
    await checkedRealpath(root, path)
    return 'directory'
  }
  throw new SourceFault('unsupported-entry', `An unsupported filesystem entry was found in the sessions ${label}.`)
}

/**
 * Resolve a configured home and inspect its sessions tree.
 * @returns `{ state: 'missing' }` when the home has no sessions directory, or
 * `{ state: 'ready', home, root, compression }` when it is browsable.
 */
export async function inspectSessionsTree(configuredHome) {
  let home
  try {
    home = await realpath(configuredHome)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new SourceFault('home-missing', 'The configured DSH home does not exist.')
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      throw new SourceFault('home-unreadable', 'The configured DSH home cannot be read with the current permissions.')
    }
    throw error
  }

  const homeInfo = await stat(home)
  if (!homeInfo.isDirectory()) {
    throw new SourceFault('home-not-directory', 'The configured DSH home is not a directory.')
  }

  const sessionsPath = join(home, 'sessions')
  let rootInfo
  try {
    rootInfo = await lstat(sessionsPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing', home, root: sessionsPath, compression: 'zstd' }
    throw error
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new SourceFault('unsafe-root', 'The sessions entry must be a real directory inside the DSH home.')
  }

  const root = await checkedRealpath(home, sessionsPath)
  const compressionKinds = new Set()
  const projects = await readdir(root, { withFileTypes: true })

  for (const projectEntry of projects) {
    const projectPath = join(root, projectEntry.name)
    const projectKind = await classifyEntry(root, projectPath, 'root')
    if (projectKind === 'file') {
      if (LEGACY_FLAT_FILE.test(projectEntry.name)) {
        throw new SourceFault('legacy-layout', 'This sessions tree uses an unsupported flat-file layout.')
      }
      continue
    }

    const sessionEntries = await readdir(projectPath, { withFileTypes: true })
    for (const sessionEntry of sessionEntries) {
      const sessionPath = join(projectPath, sessionEntry.name)
      const sessionKind = await classifyEntry(root, sessionPath, 'project directory')
      if (sessionKind === 'file') {
        if (LEGACY_FLAT_FILE.test(sessionEntry.name)) {
          throw new SourceFault('legacy-layout', 'This sessions tree uses an unsupported flat-file layout.')
        }
        continue
      }

      const artifactEntries = await readdir(sessionPath, { withFileTypes: true })
      for (const artifactEntry of artifactEntries) {
        const artifactPath = join(sessionPath, artifactEntry.name)
        const artifactKind = await classifyEntry(root, artifactPath, 'session directory')
        if (artifactKind !== 'file' || !GENERATION_FILE.test(artifactEntry.name)) continue
        compressionKinds.add(artifactEntry.name.endsWith('.zstd') ? 'zstd' : 'none')
      }
    }
  }

  if (compressionKinds.size > 1) {
    throw new SourceFault('mixed-encoding', 'This DSH home contains both compressed and raw session generations.')
  }

  return {
    state: 'ready',
    home,
    root,
    compression: compressionKinds.values().next().value ?? 'zstd',
  }
}

/**
 * Detect a directory that is itself a sessions root, so the registration form
 * can explain the common "pointed one level too deep" mistake.
 */
export async function looksLikeSessionsRoot(path) {
  try {
    const projects = await readdir(path, { withFileTypes: true })
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const projectPath = join(path, project.name)
      const sessions = await readdir(projectPath, { withFileTypes: true })
      for (const session of sessions) {
        if (!session.isDirectory()) continue
        const artifacts = await readdir(join(projectPath, session.name), { withFileTypes: true })
        if (artifacts.some(artifact => artifact.isFile() && GENERATION_FILE.test(artifact.name))) return true
      }
    }
  } catch {
    return false
  }
  return false
}

/**
 * Validate and canonicalize a user-supplied home path.
 * @returns the real path of an existing directory.
 */
export async function resolveHomeInput(value) {
  if (typeof value !== 'string') throw new SourceFault('invalid-path', 'Enter a folder path.')
  const trimmed = value.trim()
  if (trimmed === '') throw new SourceFault('invalid-path', 'Enter a folder path.')
  if (trimmed.length > 4096) throw new SourceFault('invalid-path', 'That folder path is too long.')
  if (trimmed.includes('\0')) throw new SourceFault('invalid-path', 'That folder path contains an invalid character.')
  if (!isAbsolute(trimmed)) {
    throw new SourceFault('invalid-path', 'Enter an absolute folder path, such as D:\\work\\other-dsh-home.')
  }
  if (process.platform === 'win32' && !WINDOWS_QUALIFIED.test(trimmed)) {
    throw new SourceFault('invalid-path', 'Enter a fully qualified Windows folder path, such as D:\\work\\other-dsh-home.')
  }
  let actual
  try {
    actual = await realpath(trimmed)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new SourceFault('home-missing', 'That folder does not exist.')
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      throw new SourceFault('home-unreadable', 'That folder cannot be read with the current permissions.')
    }
    throw error
  }

  const info = await stat(actual)
  if (!info.isDirectory()) throw new SourceFault('home-not-directory', 'That path is a file, not a folder.')
  return actual
}

/** Turn a source failure into a short message safe to show in the panel. */
export function sourceFailureMessage(error) {
  switch (error?.code) {
    case 'home-missing': return 'This DSH home does not exist.'
    case 'home-not-directory': return 'This path is not a folder.'
    case 'home-unreadable': return 'This DSH home cannot be read with the current permissions.'
    case 'unsafe-root': return 'The sessions entry must be a real directory inside the DSH home.'
    case 'unsafe-path': return 'A sessions path resolves outside its DSH home.'
    case 'symlink': return 'A symbolic link is present in the sessions tree. Remove it before browsing this home.'
    case 'unsupported-entry': return 'The sessions tree contains an unsupported filesystem entry.'
    case 'legacy-layout': return 'This sessions tree uses an unsupported flat-file layout.'
    case 'mixed-encoding': return 'This home mixes compressed and raw session generations; DSH requires one encoding per home.'
    case 'root-changed': return 'The sessions directory changed. Restart DSH before browsing it.'
    case 'encoding-changed': return 'Session encoding changed after the plugin loaded. Restart DSH before browsing it.'
    case 'invalid-path':
    case 'sessions-root':
    case 'duplicate':
    case 'not-registered':
    case 'configured':
    case 'registry-full':
    case 'registration-disabled':
    case 'registry-read-failed':
    case 'registry-write-failed':
    case 'source-missing':
    case 'session-missing':
    case 'session-too-large':
    case 'import-failed':
    case 'request':
      return error.message
    default: return 'Could not read stored sessions. Check filesystem access and DSH format compatibility.'
  }
}
