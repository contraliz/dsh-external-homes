import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { SourceFault, comparablePath, isRecord } from './source.js'

const REGISTRY_VERSION = 1
const MAX_LABEL_LENGTH = 120

function expandTilde(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/** Resolve the DSH home the way the launcher does: config, environment, default. */
export function resolveDshHome(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') {
    return resolve(expandTilde(configured.trim()))
  }
  const fromEnvironment = process.env.DSH_HOME
  if (typeof fromEnvironment === 'string' && fromEnvironment.trim() !== '') {
    return resolve(expandTilde(fromEnvironment.trim()))
  }
  return join(homedir(), '.dsh')
}

/** Resolve the JSON file that keeps runtime-registered homes. */
export function resolveRegistryFile(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') {
    const expanded = expandTilde(configured.trim())
    if (!isAbsolute(expanded)) {
      throw new SourceFault('invalid-path', 'config.registryFile must be an absolute path.')
    }
    return resolve(expanded)
  }
  return join(resolveDshHome(), 'external-homes.json')
}

function normalizeLabel(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.slice(0, MAX_LABEL_LENGTH)
}

function normalizeEntry(raw) {
  const value = typeof raw === 'string' ? { path: raw } : raw
  if (!isRecord(value) || typeof value.path !== 'string') return undefined
  const path = value.path.trim()
  if (path === '' || path.length > 4096 || path.includes('\0') || !isAbsolute(path)) return undefined
  const label = normalizeLabel(value.label)
  return label === undefined ? { path: resolve(path) } : { path: resolve(path), label }
}

/**
 * Read the runtime registry.
 * @returns `{ entries, corrupt }`, where `corrupt` means the file exists but
 * cannot be understood. A missing file is an empty registry, not an error.
 */
export async function readRegistry(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { entries: [], corrupt: false }
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      throw new SourceFault('registry-read-failed', 'The external-home registry cannot be read with the current permissions.')
    }
    throw new SourceFault('registry-read-failed', 'The external-home registry cannot be read. Check filesystem access.', { cause: error })
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { entries: [], corrupt: true }
  }

  const rawEntries = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.homes) ? parsed.homes : undefined
  if (rawEntries === undefined) return { entries: [], corrupt: true }

  const entries = []
  const seen = new Set()
  for (const raw of rawEntries) {
    const entry = normalizeEntry(raw)
    if (entry === undefined) continue
    const key = comparablePath(entry.path)
    if (seen.has(key)) continue
    seen.add(key)
    entries.push(entry)
  }
  return { entries, corrupt: false }
}

/**
 * Replace the registry atomically. A corrupt file is preserved beside the new
 * one before it is overwritten, so a hand edit is never silently destroyed.
 */
export async function writeRegistry(file, entries, options = {}) {
  const parent = dirname(file)
  try {
    await mkdir(parent, { recursive: true })
    if (options.backupCorrupt === true) {
      const backup = `${file}.corrupt-${Date.now()}`
      try {
        await rename(file, backup)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    const document = {
      version: REGISTRY_VERSION,
      homes: entries.map(entry => (entry.label === undefined ? { path: entry.path } : { path: entry.path, label: entry.label })),
    }
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
      await rename(temporary, file)
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  } catch (error) {
    if (error instanceof SourceFault) throw error
    throw new SourceFault('registry-write-failed', 'The external-home registry could not be written. Check filesystem access.', { cause: error })
  }
}

/**
 * Add one entry unless its path is already present.
 * @returns `{ entries, added }` with the resulting full entry list.
 */
export async function addRegistryEntry(file, entry) {
  const { entries, corrupt } = await readRegistry(file)
  const key = comparablePath(entry.path)
  if (entries.some(candidate => comparablePath(candidate.path) === key)) return { entries, added: false }
  const next = [...entries, entry]
  await writeRegistry(file, next, { backupCorrupt: corrupt })
  return { entries: next, added: true }
}

/**
 * Remove the entry whose path matches `key`.
 * @returns `{ entries, removed }` with the resulting full entry list.
 */
export async function removeRegistryEntry(file, key) {
  const { entries, corrupt } = await readRegistry(file)
  const next = entries.filter(entry => comparablePath(entry.path) !== key)
  if (next.length === entries.length) return { entries, removed: false }
  await writeRegistry(file, next, { backupCorrupt: corrupt })
  return { entries: next, removed: true }
}
