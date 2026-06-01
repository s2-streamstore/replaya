import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  Database,
  Download,
  ExternalLink,
  Keyboard,
  Layers,
  LoaderCircle,
  Maximize2,
  MousePointerClick,
  Navigation,
  Play,
  RefreshCw,
  Search,
  Terminal,
  Trash2,
  X,
  Zap,
} from 'lucide-react'
import { api } from './api'
import { ReplayPlayer, type ReplayPlayerHandle } from './ReplayPlayer'
import type {
  HealthResponse,
  ListSessionsResponse,
  LiveSessionMessage,
  ReplayEvent,
  SessionDetail,
  SessionIndexMessage,
  SessionSummary,
} from './shared/session'
import './App.css'

type LiveStatus = 'idle' | 'connecting' | 'live' | 'closed' | 'error'
type InspectorTab = 'activity' | 'details'
const SESSION_PAGE_LIMIT = 20

const dateFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return dateFormat.format(date)
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms} ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}

function timestampMs(value?: string) {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function durationMs(firstEventAt?: string, lastEventAt?: string) {
  const first = timestampMs(firstEventAt)
  const last = timestampMs(lastEventAt)
  return first !== undefined && last !== undefined ? Math.max(0, last - first) : 0
}

function sortSessions(sessions: SessionSummary[]) {
  return [...sessions].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

function mergeLiveEventIntoSummary<T extends SessionSummary>(session: T, message: Extract<LiveSessionMessage, { type: 'event' }>) {
  const firstEventAt = session.firstEventAt ?? message.s2Timestamp
  const messageTimestamp = timestampMs(message.s2Timestamp)
  const currentLastTimestamp = timestampMs(session.lastEventAt)
  const lastEventAt =
    messageTimestamp !== undefined && (currentLastTimestamp === undefined || messageTimestamp >= currentLastTimestamp)
      ? message.s2Timestamp
      : session.lastEventAt
  const lastSeenAt = message.capturedAt || message.s2Timestamp

  return {
    ...session,
    updatedAt: lastSeenAt,
    lastSeenAt,
    eventCount: session.eventCount + 1,
    recordCount: Math.max(session.recordCount, message.seqNum + 1),
    lastSeqNum: Math.max(session.lastSeqNum, message.seqNum),
    firstEventAt,
    lastEventAt,
    durationMs: durationMs(firstEventAt, lastEventAt),
  }
}

function mergeLiveHeartbeatIntoSummary<T extends SessionSummary>(
  session: T,
  message: Extract<LiveSessionMessage, { type: 'heartbeat' }>,
) {
  return {
    ...session,
    status: 'active' as const,
    updatedAt: message.lastSeenAt,
    lastSeenAt: message.lastSeenAt,
    recordCount: Math.max(session.recordCount, message.seqNum + 1),
    lastSeqNum: Math.max(session.lastSeqNum, message.seqNum),
  }
}

function mergeLiveMetadataIntoSummary<T extends SessionSummary>(
  session: T,
  message: Extract<LiveSessionMessage, { type: 'metadata' }>,
) {
  return {
    ...session,
    ...message.metadata,
    eventCount: Math.max(session.eventCount, message.metadata.eventCount),
    recordCount: Math.max(session.recordCount, message.seqNum + 1),
    lastSeqNum: Math.max(session.lastSeqNum, message.seqNum),
    durationMs: durationMs(session.firstEventAt, session.lastEventAt),
  }
}

function mergeLiveStatusIntoSummary<T extends SessionSummary>(
  session: T,
  message: Extract<LiveSessionMessage, { type: 'status' }>,
) {
  return {
    ...session,
    status: message.status,
    updatedAt: message.stoppedAt ?? message.lastSeenAt ?? session.updatedAt,
    lastSeenAt: message.lastSeenAt ?? session.lastSeenAt,
    stoppedAt: message.stoppedAt ?? session.stoppedAt,
    stopReason: message.reason,
  }
}

function liveStatusLabel(status: LiveStatus, selected: SessionDetail | null) {
  if (!selected) return 'Idle'
  if (selected.stopReason === 'lease-expired') return 'Lease expired'
  if (selected.status === 'stopped') return 'Snapshot'
  if (status === 'live') return 'S2 live tail'
  if (status === 'connecting') return 'Connecting'
  if (status === 'error') return 'Live error'
  return 'Live idle'
}

function displaySessionTitle(session: Pick<SessionSummary, 'title' | 'source'>) {
  if (session.title === 'Drop-in test page' && session.source === 'local-test') {
    return 'Recorder fixture'
  }

  return session.title
}

function formatOffset(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function prettyUrl(value: string) {
  try {
    const url = new URL(value)
    const path = `${url.pathname}${url.search}`
    return path.length > 1 ? path : url.host
  } catch {
    return value
  }
}

function identityLabel(session: Pick<SessionDetail, 'userId' | 'distinctId'>) {
  return session.userId ?? session.distinctId ?? 'Anonymous'
}

type ActivityKind = 'load' | 'nav' | 'click' | 'input' | 'resize' | 'event'
type ActivityFilter = 'all' | 'click' | 'input' | 'nav'

interface ActivityEntry {
  id: string
  offsetMs: number
  kind: ActivityKind
  label: string
  detail?: string
  count?: number
  inputNodeId?: number
}

const ACTIVITY_FILTERS: { id: ActivityFilter; label: string; kinds?: ActivityKind[] }[] = [
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

function readData(event: ReplayEvent): Record<string, unknown> | null {
  const data = (event as { data?: unknown }).data
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : null
}

function buildActivity(events: ReplayEvent[]): ActivityEntry[] {
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

const ACTIVITY_ICONS: Record<ActivityKind, typeof Play> = {
  load: Layers,
  nav: Navigation,
  click: MousePointerClick,
  input: Keyboard,
  resize: Maximize2,
  event: Zap,
}

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selected, setSelected] = useState<SessionDetail | null>(null)
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [loadingReplay, setLoadingReplay] = useState(false)
  const [copied, setCopied] = useState(false)
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('idle')
  const [showInstall, setShowInstall] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deletingSession, setDeletingSession] = useState(false)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('activity')
  const [seekedEntryId, setSeekedEntryId] = useState<string | null>(null)
  const [latestSessionPage, setLatestSessionPage] = useState(true)
  const [sessionIndexTailSeqNum, setSessionIndexTailSeqNum] = useState<number | null>(null)
  const [sessionPageIndex, setSessionPageIndex] = useState(0)
  const [sessionPageCursors, setSessionPageCursors] = useState<Array<string | undefined>>([undefined])
  const [sessionHasMore, setSessionHasMore] = useState(false)
  const [nextSessionPageCursor, setNextSessionPageCursor] = useState<string | undefined>()
  const selectedRef = useRef<SessionDetail | null>(null)
  const playerRef = useRef<ReplayPlayerHandle | null>(null)

  const appOrigin = typeof window === 'undefined' ? 'http://localhost:8787' : window.location.origin
  const selectedId = selected?.id ?? null
  const selectedStatus = selected?.status ?? null

  const snippet = useMemo(() => {
    const initOptions = [
      `  apiHost: "${appOrigin}"`,
      ...(health?.security.ingestAuthRequired || health?.security.ingestAuthConfigured
        ? ['  projectKey: "replace-with-public-project-key"']
        : []),
      '  source: "web-app"',
    ]

    return `!function(w,d,s,u){w.replaya=w.replaya||function(){(w.replaya.q=w.replaya.q||[]).push(arguments)};var e=d.createElement(s);e.async=1;e.src=u;d.head.appendChild(e)}(window,document,"script","${appOrigin}/recorder.js");
replaya("init", {
${initOptions.join(',\n')}
});`;
  }, [appOrigin, health?.security.ingestAuthConfigured, health?.security.ingestAuthRequired])

  useEffect(() => {
    selectedRef.current = selected
  }, [selected])

  const applySessionList = useCallback((list: ListSessionsResponse, pageIndex: number, startAfter?: string) => {
    setSessions(list.sessions)
    setLatestSessionPage(list.latestPage)
    setSessionIndexTailSeqNum(list.latestPage ? list.indexTailSeqNum : null)
    setSessionPageIndex(pageIndex)
    setSessionHasMore(list.hasMore)
    setNextSessionPageCursor(list.nextStartAfter)
    setSessionPageCursors((current) => {
      const next = current.slice(0, pageIndex + 1)
      next[pageIndex] = startAfter
      if (list.nextStartAfter) next[pageIndex + 1] = list.nextStartAfter
      return next
    })
  }, [])

  const loadSession = useCallback(async (id: string) => {
    setLoadingReplay(true)
    setSeekedEntryId(null)
    try {
      const { session } = await api.getSession(id)
      setSelected(session)
      setLiveStatus(session.status === 'active' ? 'connecting' : 'closed')
      setError(null)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to load replay.')
      setLiveStatus('error')
    } finally {
      setLoadingReplay(false)
    }
  }, [])

  const loadSessionsPage = useCallback(
    async (pageIndex: number, startAfter?: string, options: { selectFirst?: boolean; refreshHealth?: boolean } = {}) => {
      setLoadingSessions(true)
      try {
        const listPromise = api.listSessions({ limit: SESSION_PAGE_LIMIT, startAfter })
        const [list, nextHealth] = options.refreshHealth
          ? await Promise.all([listPromise, api.health()])
          : [await listPromise, null]

        applySessionList(list, pageIndex, startAfter)
        if (nextHealth) setHealth(nextHealth)
        if (options.selectFirst && list.sessions[0]) {
          await loadSession(list.sessions[0].id)
        }
        setError(null)
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : 'Unable to refresh sessions.')
      } finally {
        setLoadingSessions(false)
      }
    },
    [applySessionList, loadSession],
  )

  const refreshSessions = useCallback(async () => {
    const startAfter = sessionPageCursors[sessionPageIndex]
    await loadSessionsPage(sessionPageIndex, startAfter, { refreshHealth: true })
  }, [loadSessionsPage, sessionPageCursors, sessionPageIndex])

  const loadOlderSessionsPage = useCallback(async () => {
    if (!sessionHasMore || !nextSessionPageCursor) return
    await loadSessionsPage(sessionPageIndex + 1, nextSessionPageCursor, { selectFirst: true })
  }, [loadSessionsPage, nextSessionPageCursor, sessionHasMore, sessionPageIndex])

  const loadNewerSessionsPage = useCallback(async () => {
    if (sessionPageIndex <= 0) return
    const nextPageIndex = sessionPageIndex - 1
    await loadSessionsPage(nextPageIndex, sessionPageCursors[nextPageIndex], { selectFirst: true })
  }, [loadSessionsPage, sessionPageCursors, sessionPageIndex])

  const resetToLatestSessionsPage = useCallback(async () => {
    await loadSessionsPage(0, undefined, { selectFirst: true, refreshHealth: true })
  }, [loadSessionsPage])

  useEffect(() => {
    let cancelled = false

    async function boot() {
      try {
        const [nextHealth, list] = await Promise.all([
          api.health(),
          api.listSessions({ limit: SESSION_PAGE_LIMIT }),
        ])
        if (cancelled) return
        setHealth(nextHealth)
        applySessionList(list, 0, undefined)
        if (list.sessions[0]) {
          await loadSession(list.sessions[0].id)
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : 'Unable to connect to the API.')
        }
      }
    }

    void boot()

    return () => {
      cancelled = true
    }
  }, [applySessionList, loadSession])

  useEffect(() => {
    if (!latestSessionPage || sessionIndexTailSeqNum === null) return

    const source = new EventSource(api.liveSessionIndexUrl(sessionIndexTailSeqNum))

    const handleMessage = (event: MessageEvent<string>) => {
      try {
        const message = JSON.parse(event.data) as SessionIndexMessage
        if (message.type === 'session') {
          setSessions((currentSessions) => {
            const existing = currentSessions.some((session) => session.id === message.session.id)
            const nextSessions = existing
              ? currentSessions.map((session) => (session.id === message.session.id ? message.session : session))
              : [message.session, ...currentSessions]

            return sortSessions(nextSessions)
          })

          if (!selectedRef.current) {
            void loadSession(message.session.id)
          }
        }
      } catch {
        // The session index is only a live-listing hint. Ignore malformed records and keep the snapshot list.
      }
    }

    source.addEventListener('session-index-session', handleMessage)
    source.addEventListener('session-index-error', handleMessage)

    return () => {
      source.close()
    }
  }, [latestSessionPage, loadSession, sessionIndexTailSeqNum])

  useEffect(() => {
    if (!selectedId) {
      return
    }

    if (selectedStatus !== 'active') {
      return
    }

    const currentSelection = selectedRef.current
    if (!currentSelection || currentSelection.id !== selectedId) return

    let active = true
    const source = new EventSource(api.liveSessionUrl(selectedId, currentSelection.recordCount))

    const applyLiveEvent = (message: Extract<LiveSessionMessage, { type: 'event' }>) => {
      setSelected((current) => {
        if (!current || current.id !== message.sessionId) return current
        if (
          current.events.some((event) => {
            const replaya = event._replaya
            return typeof replaya === 'object' && replaya !== null && 's2SeqNum' in replaya && replaya.s2SeqNum === message.seqNum
          })
        ) {
          return current
        }

        const events = [...current.events, message.event].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
        return {
          ...mergeLiveEventIntoSummary(current, message),
          events,
          metadataHistory: current.metadataHistory,
        }
      })

      setSessions((currentSessions) =>
        sortSessions(
          currentSessions.map((session) =>
            session.id === message.sessionId && message.seqNum > session.lastSeqNum
              ? mergeLiveEventIntoSummary(session, message)
              : session,
          ),
        ),
      )
    }

    const applyLiveMetadata = (message: Extract<LiveSessionMessage, { type: 'metadata' }>) => {
      setSelected((current) => {
        if (!current || current.id !== message.sessionId || message.seqNum <= current.lastSeqNum) return current

        return {
          ...mergeLiveMetadataIntoSummary(current, message),
          events: current.events,
          metadataHistory: [...current.metadataHistory, message.metadata],
        }
      })

      setSessions((currentSessions) =>
        sortSessions(
          currentSessions.map((session) =>
            session.id === message.sessionId && message.seqNum > session.lastSeqNum
              ? mergeLiveMetadataIntoSummary(session, message)
              : session,
          ),
        ),
      )
    }

    const applyLiveHeartbeat = (message: Extract<LiveSessionMessage, { type: 'heartbeat' }>) => {
      setSelected((current) => {
        if (!current || current.id !== message.sessionId || message.seqNum <= current.lastSeqNum) return current
        return {
          ...mergeLiveHeartbeatIntoSummary(current, message),
          events: current.events,
          metadataHistory: current.metadataHistory,
        }
      })

      setSessions((currentSessions) =>
        sortSessions(
          currentSessions.map((session) =>
            session.id === message.sessionId && message.seqNum > session.lastSeqNum
              ? mergeLiveHeartbeatIntoSummary(session, message)
              : session,
          ),
        ),
      )
    }

    const applyLiveStatus = (message: Extract<LiveSessionMessage, { type: 'status' }>) => {
      setSelected((current) => {
        if (!current || current.id !== message.sessionId) return current
        return {
          ...mergeLiveStatusIntoSummary(current, message),
          events: current.events,
          metadataHistory: current.metadataHistory,
        }
      })

      setSessions((currentSessions) =>
        sortSessions(
          currentSessions.map((session) =>
            session.id === message.sessionId ? mergeLiveStatusIntoSummary(session, message) : session,
          ),
        ),
      )
    }

    const handleMessage = (event: MessageEvent<string>) => {
      try {
        const message = JSON.parse(event.data) as LiveSessionMessage
        if (message.sessionId !== selectedId) return

        if (message.type === 'event') {
          setLiveStatus('live')
          applyLiveEvent(message)
        } else if (message.type === 'heartbeat') {
          setLiveStatus('live')
          applyLiveHeartbeat(message)
        } else if (message.type === 'metadata') {
          setLiveStatus(message.metadata.status === 'stopped' ? 'closed' : 'live')
          applyLiveMetadata(message)
        } else if (message.type === 'status') {
          setLiveStatus('closed')
          applyLiveStatus(message)
        } else if (message.type === 'error') {
          setError(message.error)
          setLiveStatus('error')
        }
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : 'Unable to read live session update.')
        setLiveStatus('error')
      }
    }

    source.addEventListener('open', () => {
      if (active) setLiveStatus('live')
    })
    source.addEventListener('session-ready', () => {
      if (active) setLiveStatus('live')
    })
    source.addEventListener('session-event', handleMessage)
    source.addEventListener('session-heartbeat', handleMessage)
    source.addEventListener('session-metadata', handleMessage)
    source.addEventListener('session-status', handleMessage)
    source.addEventListener('session-error', handleMessage)
    source.onerror = () => {
      if (!active) return
      setLiveStatus(source.readyState === EventSource.CLOSED ? 'closed' : 'error')
    }

    return () => {
      active = false
      source.close()
    }
  }, [selectedId, selectedStatus])

  const filteredSessions = useMemo(() => {
    const query = filter.trim().toLowerCase()
    if (!query) return sessions

    return sessions.filter(
      (session) =>
        displaySessionTitle(session).toLowerCase().includes(query) ||
        session.title.toLowerCase().includes(query) ||
        session.id.toLowerCase().includes(query) ||
        session.streamName.toLowerCase().includes(query) ||
        session.url?.toLowerCase().includes(query) ||
        session.source?.toLowerCase().includes(query) ||
        session.distinctId?.toLowerCase().includes(query) ||
        session.userId?.toLowerCase().includes(query),
    )
  }, [filter, sessions])

  const copySnippet = useCallback(async () => {
    await navigator.clipboard.writeText(snippet)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }, [snippet])

  const exportSelected = useCallback(() => {
    if (!selected) return

    const blob = new Blob([JSON.stringify(selected, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${selected.id}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }, [selected])

  const copySessionId = useCallback(async () => {
    if (!selected) return
    await navigator.clipboard.writeText(selected.id)
  }, [selected])

  const deleteSelected = useCallback(async () => {
    if (!selected) return
    const id = selected.id
    setDeletingSession(true)
    try {
      await api.deleteSession(id)
      const remaining = sessions.filter((session) => session.id !== id)
      setSessions(remaining)
      setConfirmingDelete(false)
      setSelected(null)
      setLiveStatus('idle')
      setSeekedEntryId(null)
      setError(null)
      if (remaining[0]) {
        await loadSession(remaining[0].id)
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to delete session.')
    } finally {
      setDeletingSession(false)
    }
  }, [selected, sessions, loadSession])

  const activity = useMemo(() => (selected ? buildActivity(selected.events) : []), [selected])

  const seekToEntry = useCallback((entry: ActivityEntry) => {
    playerRef.current?.seek(entry.offsetMs)
    setSeekedEntryId(entry.id)
  }, [])

  const selectedTitle = selected ? displaySessionTitle(selected) : 'Playback'

  return (
    <main className="workspace">
      <header className="topbar">
        <div className="product-mark">
          <span className="app-logo" aria-hidden="true">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M9 7.5v9l7.5-4.5z" fill="currentColor" />
            </svg>
          </span>
          <div className="wordmark">
            <h1>RePlaya</h1>
            <span className="tagline">Session replay</span>
          </div>
        </div>
        <div className="status-cluster">
          <StatusPill health={health} />
          <button type="button" className="ghost-button" onClick={() => setShowInstall(true)}>
            <Code2 size={16} aria-hidden="true" />
            Install
          </button>
          <button type="button" className="icon-button" onClick={refreshSessions} title="Refresh sessions">
            <RefreshCw size={18} aria-hidden="true" className={loadingSessions ? 'spin' : ''} />
          </button>
        </div>
      </header>

      {error && (
        <div className="banner" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      <div className="app-grid">
          <aside className="sessions-panel">
            <div className="panel-heading">
              <h2>Sessions</h2>
              <span className="count-badge">{sessions.length}</span>
            </div>
            <label className="search-field">
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Search sessions"
              />
            </label>
            <div className="session-list">
              {filteredSessions.map((session) => (
                <button
                  type="button"
                  className={session.id === selectedId ? 'session-item active' : 'session-item'}
                  key={session.id}
                  onClick={() => void loadSession(session.id)}
                >
                  <span className="session-title-row">
                    <span className="session-title">{displaySessionTitle(session)}</span>
                    <span className={`status-badge ${session.status}`}>{session.status}</span>
                  </span>
                  <span className="session-meta">
                    {session.source ?? 'unknown'} · {session.eventCount} events ·{' '}
                    {formatDuration(session.durationMs)}
                  </span>
                  <span className="stream-name">
                    {session.streamName} · {formatDate(session.updatedAt)}
                  </span>
                </button>
              ))}
              {filteredSessions.length === 0 && (
                <div className="empty-list">
                  <Database size={18} aria-hidden="true" />
                  <span>No sessions</span>
                </div>
              )}
            </div>
            <div className="session-pagination">
              <div className="pagination-row">
                <button
                  type="button"
                  className="ghost-button pagination-button"
                  onClick={() => void loadNewerSessionsPage()}
                  disabled={loadingSessions || sessionPageIndex === 0}
                >
                  <ChevronLeft size={16} aria-hidden="true" />
                  Newer
                </button>
                <span className="pagination-status">
                  Page {sessionPageIndex + 1}
                  {latestSessionPage ? ' · live' : ''}
                </span>
                <button
                  type="button"
                  className="ghost-button pagination-button"
                  onClick={() => void loadOlderSessionsPage()}
                  disabled={loadingSessions || !sessionHasMore || !nextSessionPageCursor}
                >
                  Load older
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              </div>
              {sessionPageIndex > 0 && (
                <button
                  type="button"
                  className="ghost-button pagination-reset"
                  onClick={() => void resetToLatestSessionsPage()}
                  disabled={loadingSessions}
                >
                  Latest page
                </button>
              )}
            </div>
          </aside>

          <section className="stage-panel">
            {selected ? (
              <>
                <div className="stage-header">
                  <div className="stage-id">
                    <h2>{selectedTitle}</h2>
                    <div className="stage-meta">
                      {selected.url && (
                        <span className="stage-url" title={selected.url}>
                          {prettyUrl(selected.url)}
                        </span>
                      )}
                      <span>{selected.source ?? 'unknown source'}</span>
                      <span>{identityLabel(selected)}</span>
                      <span>{formatDuration(selected.durationMs)}</span>
                      <span>{formatDate(selected.firstEventAt ?? selected.createdAt)}</span>
                    </div>
                  </div>
                  <div className="button-row">
                    <span className={`live-pill ${liveStatus}`}>{liveStatusLabel(liveStatus, selected)}</span>
                    <button type="button" className="icon-button" onClick={() => void copySessionId()} title="Copy session ID">
                      <Copy size={17} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => void loadSession(selected.id)}
                      title="Reload replay"
                    >
                      <RefreshCw size={17} aria-hidden="true" className={loadingReplay ? 'spin' : ''} />
                    </button>
                    <button type="button" className="icon-button" onClick={exportSelected} title="Export JSON">
                      <Download size={17} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="icon-button danger"
                      onClick={() => setConfirmingDelete(true)}
                      title="Delete session"
                    >
                      <Trash2 size={17} aria-hidden="true" />
                    </button>
                  </div>
                </div>
                <ReplayPlayer
                  ref={playerRef}
                  sessionId={selected.id}
                  events={selected.events}
                  live={selected.status === 'active'}
                  lastSeqNum={selected.lastSeqNum}
                />
              </>
            ) : (
              <div className="empty-state">
                <Play size={22} aria-hidden="true" />
                <strong>No session selected</strong>
                <span>Pick a session on the left to replay it.</span>
              </div>
            )}
          </section>

          <aside className="inspector-panel">
            <div className="inspector-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={inspectorTab === 'activity'}
                className={inspectorTab === 'activity' ? 'inspector-tab active' : 'inspector-tab'}
                onClick={() => setInspectorTab('activity')}
              >
                Activity
                {selected && activity.length > 0 && <span className="tab-count">{activity.length}</span>}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={inspectorTab === 'details'}
                className={inspectorTab === 'details' ? 'inspector-tab active' : 'inspector-tab'}
                onClick={() => setInspectorTab('details')}
              >
                Details
              </button>
            </div>

            {selected ? (
              inspectorTab === 'activity' ? (
                <ActivityList entries={activity} activeId={seekedEntryId} onSeek={seekToEntry} />
              ) : (
                <DetailsPanel session={selected} liveStatus={liveStatus} health={health} />
              )
            ) : (
              <div className="empty-list">
                <Database size={18} aria-hidden="true" />
                <span>No session selected</span>
              </div>
            )}
          </aside>
        </div>

      {showInstall && (
        <InstallDialog
          snippet={snippet}
          copied={copied}
          appOrigin={appOrigin}
          health={health}
          onCopy={() => void copySnippet()}
          onClose={() => setShowInstall(false)}
        />
      )}

      {confirmingDelete && selected && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => {
            if (!deletingSession) setConfirmingDelete(false)
          }}
        >
          <div
            className="modal confirm"
            role="dialog"
            aria-modal="true"
            aria-label="Delete session"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <div>
                <h2>Delete session</h2>
                <p className="modal-sub">
                  Deletes <code>{displaySessionTitle(selected)}</code> from S2. This can&rsquo;t be undone.
                </p>
              </div>
            </div>
            <div className="modal-foot">
              <button
                type="button"
                className="ghost-button"
                onClick={() => setConfirmingDelete(false)}
                disabled={deletingSession}
              >
                Cancel
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => void deleteSelected()}
                disabled={deletingSession}
              >
                {deletingSession ? (
                  <LoaderCircle size={15} aria-hidden="true" className="spin" />
                ) : (
                  <Trash2 size={15} aria-hidden="true" />
                )}
                {deletingSession ? 'Deleting' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

function StatusPill({ health }: { health: HealthResponse | null }) {
  if (!health) {
    return (
      <div className="status-pill neutral">
        <LoaderCircle size={15} aria-hidden="true" className="spin" />
        <span>Checking S2</span>
      </div>
    )
  }

  return (
    <div className={health.ok ? 'status-pill ready' : 'status-pill error'}>
      {health.ok ? <Database size={15} aria-hidden="true" /> : <AlertTriangle size={15} aria-hidden="true" />}
      <span>{health.ok ? health.basin : health.s2Status}</span>
    </div>
  )
}

function ActivityList({
  entries,
  activeId,
  onSeek,
}: {
  entries: ActivityEntry[]
  activeId: string | null
  onSeek: (entry: ActivityEntry) => void
}) {
  const [filter, setFilter] = useState<ActivityFilter>('all')

  if (entries.length === 0) {
    return (
      <div className="empty-list">
        <Zap size={18} aria-hidden="true" />
        <span>No interactions yet</span>
      </div>
    )
  }

  const activeFilter = ACTIVITY_FILTERS.find((option) => option.id === filter) ?? ACTIVITY_FILTERS[0]
  const shown = activeFilter.kinds
    ? entries.filter((entry) => activeFilter.kinds!.includes(entry.kind))
    : entries

  return (
    <div className="activity-wrap">
      <div className="activity-filter" role="tablist" aria-label="Filter activity">
        {ACTIVITY_FILTERS.map((option) => {
          const count = option.kinds ? entries.filter((entry) => option.kinds!.includes(entry.kind)).length : entries.length
          return (
            <button
              type="button"
              key={option.id}
              role="tab"
              aria-selected={option.id === filter}
              className={option.id === filter ? 'activity-chip active' : 'activity-chip'}
              onClick={() => setFilter(option.id)}
            >
              {option.label}
              <span className="chip-count">{count}</span>
            </button>
          )
        })}
      </div>
      {shown.length === 0 ? (
        <div className="empty-list">
          <span>No {activeFilter.label.toLowerCase()} in this session</span>
        </div>
      ) : (
        <ol className="activity-list">
          {shown.map((entry) => {
            const Icon = ACTIVITY_ICONS[entry.kind]
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  className={`activity-item ${entry.kind}${entry.id === activeId ? ' active' : ''}`}
                  onClick={() => onSeek(entry)}
                  title={`Seek to ${formatOffset(entry.offsetMs)}`}
                >
                  <span className="activity-time">{formatOffset(entry.offsetMs)}</span>
                  <span className="activity-icon" aria-hidden="true">
                    <Icon size={14} />
                  </span>
                  <span className="activity-body">
                    <span className="activity-label">{entry.label}</span>
                    {entry.detail && <span className="activity-detail">{entry.detail}</span>}
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

function DetailsPanel({
  session,
  liveStatus,
  health,
}: {
  session: SessionDetail
  liveStatus: LiveStatus
  health: HealthResponse | null
}) {
  return (
    <div className="details-scroll">
      <ConfigSection title="Session">
        <ConfigRow label="ID" value={<code>{session.id}</code>} />
        <ConfigRow label="Source" value={session.source ?? 'unknown'} />
        <ConfigRow label="User" value={session.userId ?? session.distinctId ?? 'anonymous'} />
        <ConfigRow label="Status" value={session.status} />
        <ConfigRow label="Live tail" value={liveStatusLabel(liveStatus, session)} />
        {session.stopReason && <ConfigRow label="Stopped" value={session.stopReason} />}
      </ConfigSection>
      <ConfigSection title="Timeline">
        <ConfigRow label="Events" value={session.events.length} />
        <ConfigRow label="First event" value={session.firstEventAt ? formatDate(session.firstEventAt) : 'n/a'} />
        <ConfigRow label="Last event" value={session.lastEventAt ? formatDate(session.lastEventAt) : 'n/a'} />
        <ConfigRow label="Last seen" value={session.lastSeenAt ? formatDate(session.lastSeenAt) : 'n/a'} />
        <ConfigRow label="Duration" value={formatDuration(session.durationMs)} />
      </ConfigSection>
      <ConfigSection title="Storage">
        <ConfigRow label="Stream" value={<code>{session.streamName}</code>} />
        <ConfigRow label="Records" value={session.recordCount} />
        <ConfigRow label="Tail seq" value={session.lastSeqNum} />
        <ConfigRow label="Basin" value={<code>{health?.basin ?? 'checking'}</code>} />
      </ConfigSection>
    </div>
  )
}

function InstallDialog({
  snippet,
  copied,
  appOrigin,
  health,
  onCopy,
  onClose,
}: {
  snippet: string
  copied: boolean
  appOrigin: string
  health: HealthResponse | null
  onCopy: () => void
  onClose: () => void
}) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Install RePlaya"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2>Install</h2>
            <p className="modal-sub">Drop this snippet into your page to start recording sessions.</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} title="Close">
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="modal-body">
          <div className="install-copy">
            <div className="copy-heading">
              <Terminal size={16} aria-hidden="true" />
              <span>Browser snippet</span>
              <button type="button" className="ghost-button copy-inline" onClick={onCopy}>
                {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre className="code-block">
              <code>{snippet}</code>
            </pre>
            <button type="button" className="ghost-button fixture-link" onClick={() => window.open('/recorder-test', '_blank')}>
              <ExternalLink size={15} aria-hidden="true" />
              Open recorder fixture
            </button>
          </div>

          <div className="modal-config">
            <ConfigSection title="Endpoints">
              <ConfigRow label="Script" value={<code>{appOrigin}/recorder.js</code>} />
              <ConfigRow label="Ingest" value={<code>{appOrigin}/api/sessions/:id/events</code>} />
              <ConfigRow label="Streams" value={<code>{health?.streamPrefix ?? 'checking'}</code>} />
              <ConfigRow label="Account" value={<code>{health?.s2Endpoints.account ?? 'checking'}</code>} />
              <ConfigRow label="Basin" value={<code>{health?.s2Endpoints.basin ?? 'checking'}</code>} />
            </ConfigSection>

            <ConfigSection title="Stream policy">
              <ConfigRow label="Timestamping" value="client-require" />
              <ConfigRow label="Create on append" value="enabled" />
              <ConfigRow label="Active lease" value={health ? formatDuration(health.activeSessionLeaseMs) : '45s'} />
              <ConfigRow label="Delete empty" value="24h" />
              <ConfigRow label="Retention" value="28d" />
            </ConfigSection>

            <ConfigSection title="Security">
              <ConfigRow label="Ingest auth" value={health?.security.ingestAuthRequired ? 'required' : 'dev/open'} />
              <ConfigRow
                label="Capture origins"
                value={health?.security.allowedCaptureOriginsConfigured ? 'restricted' : 'not configured'}
              />
              <ConfigRow label="Fixture" value={health?.security.recorderTestEnabled ? 'enabled' : 'disabled'} />
            </ConfigSection>
          </div>
        </div>
      </div>
    </div>
  )
}

function ConfigSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="config-section">
      <h3>{title}</h3>
      <div className="config-list">{children}</div>
    </section>
  )
}

function ConfigRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="config-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

export default App
