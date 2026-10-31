/** Display-safe projection of stored session metadata and titles. */

export function primitive(value, maxLength = 2_000) {
  if (typeof value === 'string') return value.slice(0, maxLength)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  return undefined
}

/** Keep only the stable, user-meaningful header fields on the wire. */
export function projectHeader(header) {
  const result = {}
  for (const key of [
    'id', 'version', 'createdAt', 'cwd', 'parentSession', 'origin',
    'delegationDepth', 'agentPreset', 'isSeeded',
  ]) {
    const value = primitive(header?.[key])
    if (value !== undefined) result[key] = value
  }
  return result
}

export function snapshotRecord(snapshot, source) {
  return {
    sourceId: source.id,
    sourceLabel: source.label,
    header: projectHeader(snapshot.header),
    eventCount: primitive(snapshot.eventCount),
    sizeBytes: primitive(snapshot.sizeBytes),
    formatStatus: snapshot.formatStatus === 'migration-required' ? 'migration-required' : 'current',
  }
}

export function timestampOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

export function pageInteger(value, fallback, max) {
  if (!Number.isSafeInteger(value) || value < 0) return fallback
  return Math.min(value, max)
}

/** One-line, display-safe title text from a stored `session/title` event. */
export function titleText(value) {
  if (typeof value !== 'string') return undefined
  const text = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text === '' ? undefined : text.slice(0, 120)
}
