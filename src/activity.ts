import type { ReplayEvent } from './shared/session'

export type ActivityKind = 'load' | 'nav' | 'click' | 'input' | 'resize' | 'event'
export type ActivityFilter = 'all' | 'click' | 'input' | 'nav'

export interface ActivityEntry {
  id: string
  offsetMs: number
  kind: ActivityKind
  label: string
  detail?: string
  count?: number
  inputNodeId?: number
}

export const ACTIVITY_FILTERS: { id: ActivityFilter; label: string; kinds?: ActivityKind[] }[] = [
  { id: 'all', label: 'All' },
  { id: 'click', label: 'Clicks', kinds: ['click'] },
  { id: 'input', label: 'Inputs', kinds: ['input'] },
  { id: 'nav', label: 'Pages', kinds: ['nav', 'load'] },
]

const MOUSE_INTERACTION_LABELS: Record<number, string> = {
  2: 'Click',
  3: 'Right click',
  4: 'Double click',
}

export function formatOffset(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export function prettyUrl(value: string) {
  try {
    const url = new URL(value)
    const path = `${url.pathname}${url.search}`
    return path.length > 1 ? path : url.host
  } catch {
    return value
  }
}

function readData(event: ReplayEvent): Record<string, unknown> | null {
  const data = (event as { data?: unknown }).data
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null
}

export function buildActivity(events: ReplayEvent[]): ActivityEntry[] {
  if (events.length === 0) return []

  const base = events.reduce(
    (min, event) => (typeof event.timestamp === 'number' ? Math.min(min, event.timestamp) : min),
    Number.POSITIVE_INFINITY,
  )
  if (!Number.isFinite(base)) return []

  const entries: ActivityEntry[] = []

  events.forEach((event, index) => {
    if (typeof event.timestamp !== 'number') return
    const offsetMs = Math.max(0, event.timestamp - base)
    const id = `${index}`
    const data = readData(event)

    if (event.type === 2) {
      entries.push({ id, offsetMs, kind: 'load', label: 'Page snapshot' })
    } else if (event.type === 1) {
      entries.push({ id, offsetMs, kind: 'load', label: 'Page load' })
    } else if (event.type === 4 && data) {
      const href = typeof data.href === 'string' ? data.href : undefined
      entries.push({ id, offsetMs, kind: 'nav', label: 'Navigation', detail: href ? prettyUrl(href) : undefined })
    } else if (event.type === 5) {
      const tag = data && typeof data.tag === 'string' ? data.tag : 'Custom event'
      entries.push({ id, offsetMs, kind: 'event', label: tag })
    } else if (event.type === 3 && data) {
      const source = data.source
      if (source === 2) {
        const label = MOUSE_INTERACTION_LABELS[data.type as number]
        if (!label) return
        const detail =
          typeof data.x === 'number' && typeof data.y === 'number'
            ? `${Math.round(data.x as number)}, ${Math.round(data.y as number)}`
            : undefined
        entries.push({ id, offsetMs, kind: 'click', label, detail })
      } else if (source === 5) {
        entries.push({
          id,
          offsetMs,
          kind: 'input',
          label: 'Input',
          inputNodeId: typeof data.id === 'number' ? (data.id as number) : undefined,
        })
      } else if (source === 4) {
        const detail =
          typeof data.width === 'number' && typeof data.height === 'number'
            ? `${data.width as number}×${data.height as number}`
            : undefined
        entries.push({ id, offsetMs, kind: 'resize', label: 'Viewport resize', detail })
      }
    }
  })

  // Collapse runs of keystroke-level inputs on the same field into a single entry.
  const collapsed: ActivityEntry[] = []
  for (const entry of entries) {
    const previous = collapsed[collapsed.length - 1]
    if (entry.kind === 'input' && previous && previous.kind === 'input' && previous.inputNodeId === entry.inputNodeId) {
      previous.count = (previous.count ?? 1) + 1
      previous.detail = `${previous.count} changes`
      continue
    }
    collapsed.push({ ...entry })
  }

  return collapsed
}
