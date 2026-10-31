import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { apply as jsonlSessionPersistence } from '@deepseek-ai/dsh-session-persistence-jsonl'
import Schema from '@deepseek-ai/schemastery'
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  SourceFault,
  comparablePath,
  homeLeaf,
  inspectSessionsTree,
  isFullyQualifiedPath,
  isRecord,
  looksLikeSessionsRoot,
  resolveHomeInput,
  sourceFailureMessage,
} from './lib/source.js'
import {
  addRegistryEntry,
  readRegistry,
  removeRegistryEntry,
  resolveDshHome,
  resolveRegistryFile,
} from './lib/registry.js'
import {
  pageInteger,
  snapshotRecord,
  timestampOf,
  titleText,
} from './lib/sessions.js'

export const name = 'external-homes'
export const inject = ['connection', 'sessionPersistence']

export const Config = Schema.object({
  homes: Schema.array(String).default([]),
  registryFile: Schema.string().default(''),
  allowRegistration: Schema.boolean().default(true),
})

const ROUTE_PATH = '/api/external-homes'
const LIST_PAGE_SIZE = 50
const MAX_LIST_PAGE_SIZE = 1000
const MAX_REGISTERED_HOMES = 50
const MAX_LABEL_LENGTH = 120
const TITLE_READ_LIMIT = 40
const MAX_TITLE_READS = 100
const TITLE_CONCURRENCY = 6
const IMPORT_PAGE_SIZE = 500
const MAX_IMPORT_EVENTS = 50_000

/** Run an async mapper over items with bounded concurrency. */
async function mapLimit(items, limit, mapper) {
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++
      await mapper(items[current], current)
    }
  })
  await Promise.all(workers)
}

/** Validate the profile-provided part of the configuration. */
function validateConfig(config) {
  const rawHomes = config?.homes ?? []
  if (!Array.isArray(rawHomes)) {
    throw new Error('external-homes: config.homes must be an array of absolute DSH home paths.')
  }

  const configHomes = []
  const seen = new Set()
  for (const value of rawHomes) {
    if (!isFullyQualifiedPath(value)) {
      throw new Error('external-homes: every config.homes entry must be an absolute DSH home path.')
    }
    const home = resolve(value)
    const key = comparablePath(home)
    if (seen.has(key)) throw new Error('external-homes: config.homes contains the same directory more than once.')
    seen.add(key)
    configHomes.push(home)
  }

  return {
    configHomes,
    registryFile: resolveRegistryFile(config?.registryFile),
    allowRegistration: config?.allowRegistration !== false,
  }
}

function makeSource(home, origin, label) {
  return {
    id: comparablePath(home),
    path: home,
    origin,
    label,
    home: undefined,
    root: undefined,
    compression: undefined,
    context: undefined,
    persistence: undefined,
    initPromise: undefined,
    snapshots: new Map(),
    titles: new Map(),
    status: 'pending',
    count: 0,
    error: undefined,
    disposed: false,
  }
}

function publicSource(source) {
  const result = {
    id: source.id,
    label: source.label,
    path: source.path,
    origin: source.origin,
    status: source.status,
    count: source.count,
  }
  if (source.error !== undefined) result.error = source.error
  return result
}

async function ensureSource(source) {
  if (source.disposed) throw new SourceFault('source-missing', 'This DSH home is no longer registered.')

  if (source.persistence !== undefined) {
    const current = await inspectSessionsTree(source.path)
    if (current.state !== 'ready'
      || comparablePath(current.home) !== comparablePath(source.home)
      || comparablePath(current.root) !== comparablePath(source.root)) {
      throw new SourceFault('root-changed', 'The sessions directory changed. Restart DSH before browsing it.')
    }
    if (current.compression !== source.compression) {
      throw new SourceFault('encoding-changed', 'Session encoding changed after the plugin loaded. Restart DSH before browsing it.')
    }
    return current
  }

  if (source.initPromise !== undefined) return source.initPromise
  source.initPromise = (async () => {
    const inspected = await inspectSessionsTree(source.path)
    source.home = inspected.home
    if (inspected.state === 'missing') return inspected

    const storageContext = new Context()
    try {
      await storageContext.plugin(SessionStore)
      await storageContext.plugin(jsonlSessionPersistence, {
        root: inspected.root,
        compression: inspected.compression,
      })
    } catch (error) {
      await storageContext.fiber.dispose()
      throw error
    }

    if (source.disposed) {
      await storageContext.fiber.dispose()
      throw new SourceFault('source-missing', 'This DSH home is no longer registered.')
    }

    source.root = inspected.root
    source.compression = inspected.compression
    source.context = storageContext
    source.persistence = storageContext.sessionPersistence
    return inspected
  })()

  try {
    return await source.initPromise
  } finally {
    source.initPromise = undefined
  }
}

async function disposeSource(source) {
  source.disposed = true
  if (source.initPromise !== undefined) {
    await source.initPromise.catch(() => {})
  }
  const context = source.context
  source.context = undefined
  source.persistence = undefined
  source.snapshots = new Map()
  source.titles = new Map()
  if (context !== undefined) await context.fiber.dispose()
}

function sourceLabel(origin, home, index, customLabel) {
  if (typeof customLabel === 'string' && customLabel.trim() !== '') return customLabel.trim().slice(0, MAX_LABEL_LENGTH)
  const leaf = homeLeaf(home)
  return origin === 'config' ? `Home ${index + 1} · ${leaf}` : leaf
}

/** Read the latest stored title from the first events of one external session. */
async function readSessionTitle(source, snapshot, signal) {
  const key = `${String(snapshot.header.id)}:${String(snapshot.revision)}`
  if (source.titles.has(key)) return source.titles.get(key)

  let handle
  try {
    handle = await source.persistence.open(snapshot.header.id, 'read', { signal })
    const result = await handle.read(0, TITLE_READ_LIMIT, { signal })
    let title
    for (const event of result.events) {
      if (event.type === 'session/title') title = titleText(event.data?.title)
    }
    source.titles.set(key, title)
    return title
  } catch (error) {
    if (signal.aborted) throw error
    return undefined
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {})
  }
}

/** Attach display titles to the page's records, bounded by count and concurrency. */
async function readPageTitles(entries, signal) {
  const selected = entries.slice(0, MAX_TITLE_READS)
  const bySource = new Map()
  for (const entry of selected) {
    const list = bySource.get(entry.source) ?? []
    list.push(entry)
    bySource.set(entry.source, list)
  }
  for (const [source, sourceEntries] of bySource) {
    await mapLimit(sourceEntries, TITLE_CONCURRENCY, async (entry) => {
      signal.throwIfAborted()
      const title = await readSessionTitle(source, entry.snapshot, signal)
      if (title !== undefined) entry.record.title = title
    })
  }
}

function isAlreadyExists(error) {
  return error?.name === 'SessionAlreadyExistsError' || error?.code === 'SESSION_ALREADY_EXISTS'
}

export function apply(ctx, config = {}) {
  if (typeof ctx.connection?.fetch?.register !== 'function') {
    throw new Error('external-homes: this DSH version does not expose exact Fetch routes (ctx.connection.fetch).')
  }
  const { configHomes, registryFile, allowRegistration } = validateConfig(config)

  let sources = []
  let sourceById = new Map()
  const sourceCache = new Map()
  let registryEntries = []
  let registryCorrupt = false
  let registryError
  let chain = Promise.resolve()
  let currentHomePromise
  const imports = new Map()

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`external-homes: ${message}`)
    } catch {
      // Logging must never break browsing.
    }
  }

  /** Serialize registry reads and mutations so one write cannot interleave another. */
  function serialized(task) {
    const run = chain.then(task, task)
    chain = run.then(() => {}, () => {})
    return run
  }

  function currentHome() {
    currentHomePromise ??= realpath(resolveDshHome()).catch(() => resolveDshHome())
    return currentHomePromise
  }

  function reconcileSources() {
    const next = []
    const used = new Set()

    for (const [index, home] of configHomes.entries()) {
      const key = comparablePath(home)
      if (used.has(key)) continue
      used.add(key)
      const source = sourceCache.get(key) ?? makeSource(home, 'config', '')
      source.origin = 'config'
      source.label = sourceLabel('config', home, index, undefined)
      sourceCache.set(key, source)
      next.push(source)
    }

    for (const entry of registryEntries) {
      const key = comparablePath(entry.path)
      if (used.has(key)) continue
      used.add(key)
      const source = sourceCache.get(key) ?? makeSource(entry.path, 'registry', '')
      source.origin = 'registry'
      source.label = sourceLabel('registry', entry.path, 0, entry.label)
      sourceCache.set(key, source)
      next.push(source)
    }

    for (const [key, source] of sourceCache) {
      if (used.has(key)) continue
      sourceCache.delete(key)
      void disposeSource(source).catch(error => warn(`could not dispose a removed home: ${String(error)}`))
    }

    sources = next
    sourceById = new Map(next.map(source => [source.id, source]))
  }

  async function syncSources() {
    let result
    try {
      result = await readRegistry(registryFile)
    } catch (error) {
      registryCorrupt = true
      registryError = sourceFailureMessage(error)
      warn(`the runtime registry could not be read: ${error?.message ?? String(error)}`)
      reconcileSources()
      return { corrupt: true, error: registryError }
    }

    if (result.corrupt) {
      registryCorrupt = true
      registryError = 'The runtime registry file is unreadable. Registered homes are hidden until it is repaired; adding a home backs up the unreadable file and starts a new registry.'
      warn('the runtime registry is unreadable; keeping the last known homes')
    } else {
      registryCorrupt = false
      registryError = undefined
      registryEntries = result.entries
    }
    reconcileSources()
    return { corrupt: registryCorrupt, error: registryError }
  }

  function registrationInfo() {
    const info = { enabled: allowRegistration, registryFile }
    if (registryError !== undefined) info.error = registryError
    return info
  }

  async function listSource(source, signal) {
    const inspected = await ensureSource(source)
    if (inspected.state === 'missing') {
      source.snapshots = new Map()
      return { status: 'missing', entries: [] }
    }

    const snapshots = (await source.persistence.list({ signal }))
      .filter(snapshot => snapshot.header.origin !== 'subagent')
    source.snapshots = new Map(snapshots.map(snapshot => [String(snapshot.header.id), snapshot]))
    return {
      status: 'ready',
      entries: snapshots.map(snapshot => ({
        source,
        snapshot,
        record: snapshotRecord(snapshot, source),
      })),
    }
  }

  async function listAll(args, signal) {
    await serialized(syncSources)

    const offset = pageInteger(args.offset, 0, 1_000_000)
    const pageSize = pageInteger(args.limit, LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE) || LIST_PAGE_SIZE
    const entries = []

    for (const source of sources) {
      signal.throwIfAborted()
      try {
        const result = await listSource(source, signal)
        source.status = result.status
        source.count = result.entries.length
        source.error = undefined
        entries.push(...result.entries)
      } catch (error) {
        if (signal.aborted) throw error
        source.snapshots = new Map()
        source.status = 'error'
        source.count = 0
        source.error = sourceFailureMessage(error)
      }
    }

    entries.sort((left, right) =>
      timestampOf(right.record.header.createdAt) - timestampOf(left.record.header.createdAt)
      || left.record.sourceId.localeCompare(right.record.sourceId)
      || String(left.record.header.id).localeCompare(String(right.record.header.id)))

    const page = entries.slice(offset, offset + pageSize)
    await readPageTitles(page, signal)

    return {
      sources: sources.map(publicSource),
      sessions: page.map(entry => entry.record),
      offset,
      limit: pageSize,
      total: entries.length,
      registration: registrationInfo(),
    }
  }

  async function importSession(args, signal) {
    const { sourceId, id } = args
    if (typeof sourceId !== 'string' || sourceId.length === 0 || sourceId.length > 4096) {
      throw new SourceFault('source-missing', 'Refresh the list before opening this conversation.')
    }
    if (typeof id !== 'string' || id.length === 0 || id.length > 512) {
      throw new SourceFault('session-missing', 'The requested conversation is invalid.')
    }

    const source = sourceById.get(sourceId)
    if (source === undefined) throw new SourceFault('source-missing', 'Refresh the list before opening this conversation.')

    const inspected = await ensureSource(source)
    if (inspected.state !== 'ready') throw new SourceFault('session-missing', 'The requested conversation is unavailable.')
    const snapshot = source.snapshots.get(id)
    if (snapshot === undefined) throw new SourceFault('session-missing', 'Refresh the conversation list before opening this session.')

    const current = await currentHome()
    if (comparablePath(source.home) === comparablePath(current)) {
      return { sessionId: id, imported: false }
    }

    const importedId = `session-ext-${createHash('sha256').update(`${source.id}\0${id}`).digest('hex').slice(0, 32)}`
    const existing = imports.get(importedId)
    if (existing !== undefined) return existing

    const task = (async () => {
      try {
        const stored = await ctx.sessionPersistence.stat(importedId)
        if (stored !== undefined && stored !== null) return { sessionId: importedId, imported: false }
      } catch {
        // A missing imported copy is the expected case.
      }

      const events = []
      const reader = await source.persistence.open(id, 'read', { signal })
      try {
        let cursor = 0
        while (true) {
          const page = await reader.read(cursor, IMPORT_PAGE_SIZE, { signal })
          if (page.events.length === 0) break
          events.push(...page.events)
          cursor += page.events.length
          if (events.length > MAX_IMPORT_EVENTS) {
            throw new SourceFault('session-too-large', 'This conversation is too large to open in the normal viewer.')
          }
          if (page.events.length < IMPORT_PAGE_SIZE) break
        }
      } finally {
        await reader.close()
      }

      const external = snapshot.header
      const seeded = external.isSeeded === true
      const seedEnd = seeded ? events.find(event => event.type === 'session/end-seed') : undefined
      const inheritedEventCount = seedEnd !== undefined && Number.isSafeInteger(seedEnd.seq) ? seedEnd.seq + 1 : 0
      const header = {
        version: SESSION_FORMAT_VERSION,
        id: importedId,
        createdAt: Number.isSafeInteger(external.createdAt) && external.createdAt >= 0 ? external.createdAt : Date.now(),
        isSeeded: seeded,
      }
      if (typeof source.home === 'string') header.cwd = source.home
      if (typeof external.agentPreset === 'string') header.agentPreset = external.agentPreset

      let writer
      try {
        writer = await ctx.sessionPersistence.create(header, { inheritedEventCount })
        if (events.length > 0) await writer.append(events)
        await writer.flush()
      } catch (error) {
        if (isAlreadyExists(error)) return { sessionId: importedId, imported: false }
        warn(`import write failed: ${error?.stack ?? String(error)}`)
        throw new SourceFault('import-failed', 'This conversation could not be imported into the current DSH home.', { cause: error })
      } finally {
        if (writer !== undefined) await writer.close().catch(() => {})
      }
      return { sessionId: importedId, imported: true }
    })()

    imports.set(importedId, task)
    try {
      return await task
    } finally {
      imports.delete(importedId)
    }
  }

  function registerLabel(value) {
    if (value === undefined) return undefined
    if (typeof value !== 'string') throw new SourceFault('invalid-path', 'A home label must be text.')
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed.slice(0, MAX_LABEL_LENGTH)
  }

  async function registerHome(args) {
    if (!allowRegistration) {
      throw new SourceFault('registration-disabled', 'Registering homes is disabled in this profile configuration.')
    }

    const actual = await resolveHomeInput(args.path)
    const key = comparablePath(actual)

    return serialized(async () => {
      await syncSources()
      if (sourceById.has(key)) {
        throw new SourceFault('duplicate', 'That DSH home is already registered.')
      }
      if (registryEntries.length >= MAX_REGISTERED_HOMES) {
        throw new SourceFault('registry-full', `At most ${MAX_REGISTERED_HOMES} homes can be registered at runtime.`)
      }

      const label = registerLabel(args.label)

      let inspected
      try {
        inspected = await inspectSessionsTree(actual)
      } catch (error) {
        if (error?.code === 'home-missing') {
          throw new SourceFault('home-missing', 'That folder does not exist.')
        }
        throw error
      }

      if (inspected.state === 'missing' && await looksLikeSessionsRoot(actual)) {
        throw new SourceFault('sessions-root', 'That folder is a sessions directory. Register its parent DSH home instead.')
      }

      const result = await addRegistryEntry(registryFile, label === undefined ? { path: actual } : { path: actual, label })
      if (!result.added) throw new SourceFault('duplicate', 'That DSH home is already registered.')

      registryEntries = result.entries
      registryCorrupt = false
      registryError = undefined
      reconcileSources()

      const source = sourceById.get(key)
      return {
        source: source === undefined ? undefined : publicSource(source),
        sources: sources.map(publicSource),
        registration: registrationInfo(),
      }
    })
  }

  async function removeHome(args) {
    if (!allowRegistration) {
      throw new SourceFault('registration-disabled', 'Registering homes is disabled in this profile configuration.')
    }
    if (typeof args.sourceId !== 'string' || args.sourceId.length === 0 || args.sourceId.length > 4096) {
      throw new SourceFault('not-registered', 'That DSH home is not registered.')
    }

    return serialized(async () => {
      await syncSources()
      const source = sourceById.get(args.sourceId)
      if (source === undefined) throw new SourceFault('not-registered', 'That DSH home is not registered.')
      if (source.origin !== 'registry') {
        throw new SourceFault('configured', 'This home comes from the plugin configuration. Remove it from the profile patch instead.')
      }

      const result = await removeRegistryEntry(registryFile, source.id)
      if (!result.removed) throw new SourceFault('not-registered', 'That DSH home is not registered.')

      registryEntries = result.entries
      registryCorrupt = false
      registryError = undefined
      reconcileSources()
      return { sources: sources.map(publicSource), registration: registrationInfo() }
    })
  }

  async function dispatch(action, args, signal) {
    switch (action) {
      case 'list': return listAll(args, signal)
      case 'import': return importSession(args, signal)
      case 'register': return registerHome(args)
      case 'remove': return removeHome(args)
      default: throw new SourceFault('request', 'Unknown request action.')
    }
  }

  async function handleRequest(request) {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
    if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      return new Response('content type must be application/json', { status: 415 })
    }

    let payload
    try {
      payload = await request.json()
    } catch {
      return Response.json({ ok: false, error: { code: 'request', message: 'The request payload is invalid.' } }, { status: 400 })
    }
    if (!isRecord(payload)) {
      return Response.json({ ok: false, error: { code: 'request', message: 'The request payload is invalid.' } }, { status: 400 })
    }

    const action = payload.action
    const args = isRecord(payload.args) ? payload.args : {}
    try {
      const value = await dispatch(action, args, request.signal)
      return Response.json({ ok: true, value })
    } catch (error) {
      if (request.signal.aborted) {
        return Response.json({ ok: false, error: { code: 'aborted', message: 'The request was canceled.' } })
      }
      if (error instanceof SourceFault) {
        return Response.json({ ok: false, error: { code: error.code, message: error.message } })
      }
      warn(`request failed: ${error?.stack ?? String(error)}`)
      return Response.json({ ok: false, error: { code: 'read-failed', message: sourceFailureMessage(error) } })
    }
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: handleRequest,
  }), 'external-homes: API route')

  ctx.effect(() => async () => {
    const cached = [...sourceCache.values()]
    sourceCache.clear()
    await Promise.allSettled(cached.map(disposeSource))
  }, 'external-homes: isolated read contexts')
}
