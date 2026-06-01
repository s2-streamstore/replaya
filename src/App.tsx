import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  Copy,
  Database,
  Download,
  ExternalLink,
  LoaderCircle,
  Play,
  RefreshCw,
  Search,
} from 'lucide-react'
import { api } from './api'
import { ReplayPlayer } from './ReplayPlayer'
import type { HealthResponse, LiveSessionMessage, SessionDetail, SessionSummary } from './shared/session'
import './App.css'

type LiveStatus = 'idle' | 'connecting' | 'live' | 'closed' | 'error'
type ViewMode = 'replay' | 'capture'

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
  const [view, setView] = useState<ViewMode>('replay')
  const selectedRef = useRef<SessionDetail | null>(null)

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

  const refreshSessions = useCallback(async () => {
    setLoadingSessions(true)
    try {
      const [{ sessions: nextSessions }, nextHealth] = await Promise.all([
        api.listSessions(),
        api.health(),
      ])
      setSessions(nextSessions)
      setHealth(nextHealth)
      setError(null)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to refresh sessions.')
    } finally {
      setLoadingSessions(false)
    }
  }, [])

  const loadSession = useCallback(async (id: string) => {
    setLoadingReplay(true)
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

  useEffect(() => {
    let cancelled = false

    async function boot() {
      try {
        const [nextHealth, list] = await Promise.all([api.health(), api.listSessions()])
        if (cancelled) return
        setHealth(nextHealth)
        setSessions(list.sessions)
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
  }, [loadSession])

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

  const selectedTitle = selected ? displaySessionTitle(selected) : 'Playback'

  return (
    <main className="workspace">
      <header className="topbar">
        <div className="product-mark">
          <span className="app-logo" aria-hidden="true">
            R
          </span>
          <div>
            <p className="eyebrow">RePlaya</p>
            <h1>Session Replay</h1>
          </div>
        </div>
        <nav className="view-tabs" aria-label="Workspace">
          <button
            type="button"
            className={view === 'replay' ? 'view-tab active' : 'view-tab'}
            onClick={() => setView('replay')}
          >
            <Play size={16} aria-hidden="true" />
            Replay
          </button>
          <button
            type="button"
            className={view === 'capture' ? 'view-tab active' : 'view-tab'}
            onClick={() => setView('capture')}
          >
            <Code2 size={16} aria-hidden="true" />
            Capture
          </button>
        </nav>
        <div className="status-cluster">
          <StatusPill health={health} />
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

      {view === 'replay' ? (
        <div className="app-grid">
          <aside className="sessions-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">S2 streams</p>
                <h2>Sessions</h2>
              </div>
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
          </aside>

          <section className="replay-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Replay</p>
                <h2>{selectedTitle}</h2>
                {selected && <code className="heading-code">{selected.streamName}</code>}
              </div>
              <div className="button-row">
                {selected && <span className={`live-pill ${liveStatus}`}>{liveStatusLabel(liveStatus, selected)}</span>}
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => selected && void loadSession(selected.id)}
                  title="Reload replay"
                  disabled={!selected}
                >
                  <RefreshCw size={18} aria-hidden="true" className={loadingReplay ? 'spin' : ''} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={exportSelected}
                  title="Export JSON"
                  disabled={!selected}
                >
                  <Download size={18} aria-hidden="true" />
                </button>
              </div>
            </div>

            {selected ? (
              <>
                <div className="replay-stats">
                  <Metric label="Events" value={selected.events.length} />
                  <Metric label="Records" value={selected.recordCount} />
                  <Metric label="Duration" value={formatDuration(selected.durationMs)} />
                  <Metric label="Timeline" value={selected.status === 'active' ? 'S2 live' : 'S2 record'} />
                </div>
                <SessionDetails session={selected} />
                <ReplayPlayer
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
                <span>Select a session from the stream list.</span>
              </div>
            )}
          </section>

          <aside className="inspector-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Selection</p>
                <h2>Stream</h2>
              </div>
            </div>

            {selected ? (
              <>
                <ConfigSection title="Selected Stream">
                  <ConfigRow label="Session" value={<code>{selected.id}</code>} />
                  <ConfigRow label="Stream" value={<code>{selected.streamName}</code>} />
                  <ConfigRow label="Source" value={selected.source ?? 'unknown'} />
                  <ConfigRow label="Status" value={selected.status} />
                  <ConfigRow label="Stop reason" value={selected.stopReason ?? 'n/a'} />
                  <ConfigRow label="Live tail" value={liveStatusLabel(liveStatus, selected)} />
                  <ConfigRow label="Last seq" value={selected.lastSeqNum} />
                  <ConfigRow label="Last seen" value={selected.lastSeenAt ? formatDate(selected.lastSeenAt) : 'n/a'} />
                  <ConfigRow label="Last event" value={selected.lastEventAt ? formatDate(selected.lastEventAt) : 'n/a'} />
                </ConfigSection>
                <ConfigSection title="Storage">
                  <ConfigRow label="Timeline" value={selected.timelineSource} />
                  <ConfigRow label="Basin" value={<code>{health?.basin ?? 'checking'}</code>} />
                  <ConfigRow label="Prefix" value={<code>{health?.streamPrefix ?? 'checking'}</code>} />
                </ConfigSection>
              </>
            ) : (
              <div className="empty-list">
                <Database size={18} aria-hidden="true" />
                <span>No stream selected</span>
              </div>
            )}
          </aside>
        </div>
      ) : (
        <div className="capture-grid">
          <section className="capture-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Capture</p>
                <h2>Recorder</h2>
              </div>
              <button type="button" className="ghost-button" onClick={() => window.open('/recorder-test', '_blank')}>
                <ExternalLink size={16} aria-hidden="true" />
                Fixture
              </button>
            </div>

            <div className="install-copy">
              <div className="copy-heading">
                <Code2 size={18} aria-hidden="true" />
                <span>Browser snippet</span>
              </div>
              <pre className="code-block">
                <code>{snippet}</code>
              </pre>
              <button type="button" className="primary-button" onClick={() => void copySnippet()}>
                {copied ? <CheckCircle2 size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </section>

          <aside className="capture-panel">
            <ConfigSection title="Endpoints">
              <ConfigRow label="Script" value={<code>{appOrigin}/recorder.js</code>} />
              <ConfigRow label="Ingest" value={<code>{appOrigin}/api/sessions/:id/events</code>} />
              <ConfigRow label="Streams" value={<code>{health?.streamPrefix ?? 'checking'}</code>} />
              <ConfigRow label="Account" value={<code>{health?.s2Endpoints.account ?? 'checking'}</code>} />
              <ConfigRow label="Basin" value={<code>{health?.s2Endpoints.basin ?? 'checking'}</code>} />
            </ConfigSection>

            <ConfigSection title="Stream Policy">
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
          </aside>
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

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
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

function SessionDetails({ session }: { session: SessionDetail }) {
  return (
    <div className="session-details">
      <div>
        <span>URL</span>
        <code>{session.url ?? 'unknown'}</code>
      </div>
      <div>
        <span>Source</span>
        <code>{session.source ?? 'unknown'}</code>
      </div>
      <div>
        <span>First event</span>
        <code>{session.firstEventAt ? formatDate(session.firstEventAt) : 'n/a'}</code>
      </div>
      <div>
        <span>Last event</span>
        <code>{session.lastEventAt ? formatDate(session.lastEventAt) : 'n/a'}</code>
      </div>
      <div>
        <span>Last seen</span>
        <code>{session.lastSeenAt ? formatDate(session.lastSeenAt) : 'n/a'}</code>
      </div>
    </div>
  )
}

export default App
