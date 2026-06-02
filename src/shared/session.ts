export type SessionStatus = 'active' | 'stopped'
export type SessionStopReason = 'explicit-stop' | 'lease-expired'

export type ReplayEvent = Record<string, unknown> & {
  timestamp?: number
  type?: number
}

export interface SessionMetadata {
  id: string
  title: string
  status: SessionStatus
  createdAt: string
  updatedAt: string
  lastSeenAt?: string
  stoppedAt?: string
  stopReason?: SessionStopReason
  eventCount: number
  url?: string
  source?: string
  distinctId?: string
  userId?: string
  sdk?: string
}

export interface SessionSummary extends SessionMetadata {
  streamName: string
  recordCount: number
  lastSeqNum: number
  firstEventAt?: string
  lastEventAt?: string
  durationMs: number
}

export interface SessionDetail extends SessionSummary {
  events: ReplayEvent[]
  metadataHistory: SessionMetadata[]
}

export interface ListSessionsResponse {
  sessions: SessionSummary[]
  hasMore: boolean
  nextStartAfter?: string
  latestPage: boolean
  indexTailSeqNum: number | null
}

export type LiveSessionMessage =
  | {
      type: 'ready'
      sessionId: string
      fromSeqNum: number
    }
  | {
      type: 'event'
      sessionId: string
      seqNum: number
      s2Timestamp: string
      capturedAt: string
      event: ReplayEvent
    }
  | {
      type: 'heartbeat'
      sessionId: string
      seqNum: number
      s2Timestamp: string
      lastSeenAt: string
    }
  | {
      type: 'metadata'
      sessionId: string
      seqNum: number
      s2Timestamp: string
      metadata: SessionMetadata
    }
  | {
      type: 'status'
      sessionId: string
      status: SessionStatus
      reason: SessionStopReason
      lastSeenAt?: string
      stoppedAt?: string
    }
  | {
      type: 'error'
      sessionId: string
      error: string
    }

export type SessionIndexMessage =
  | {
      type: 'ready'
      fromSeqNum: number
    }
  | {
      type: 'session'
      seqNum: number
      s2Timestamp: string
      streamName: string
      session: SessionSummary
    }
  | {
      type: 'error'
      error: string
    }

export type StoredSessionRecord =
  | {
      kind: 'metadata'
      sessionId: string
      capturedAt: string
      metadata: SessionMetadata
    }
  | {
      kind: 'heartbeat'
      sessionId: string
      capturedAt: string
      lastSeenAt: string
      eventCount?: number
    }
  | {
      kind: 'event'
      sessionId: string
      capturedAt: string
      event: ReplayEvent
      eventCount?: number
    }
  | {
      kind: 'event-chunk'
      sessionId: string
      capturedAt: string
      chunkId: string
      chunkIndex: number
      chunkCount: number
      eventTimestamp: number
      eventCount?: number
    }

export interface HealthResponse {
  ok: boolean
  configured: boolean
  basin: string | null
  streamPrefix: string
  activeSessionLeaseMs: number
  s2Status: 'ready' | 'error' | 'missing-config'
  s2Endpoints: {
    account: string
    basin: string
  }
  security: {
    ingestAuthRequired: boolean
    ingestAuthConfigured: boolean
    allowedCaptureOriginsConfigured: boolean
    recorderTestEnabled: boolean
  }
  error?: string
}

export interface CreateSessionRequest {
  title?: string
  url?: string
  source?: string
  distinctId?: string
  userId?: string
  sdk?: string
  projectKey?: string
}

export interface CreateSessionResponse {
  session: SessionDetail
  appendToken?: string
  appendTokenExpiresAt?: string
}

export interface AppendEventsRequest {
  events: ReplayEvent[]
  eventCount?: number
  sessionToken?: string
}

export interface HeartbeatSessionRequest {
  title?: string
  eventCount?: number
  sessionToken?: string
}

export interface StopSessionRequest {
  title?: string
  eventCount?: number
  sessionToken?: string
}
