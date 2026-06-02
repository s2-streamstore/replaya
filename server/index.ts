import dotenv from 'dotenv'
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import {
  AppendInput,
  AppendRecord,
  BatchTransform,
  Producer,
  S2,
  S2Endpoints,
  S2Environment,
  S2Error,
  FencingTokenMismatchError,
  type AppendRecord as S2AppendRecord,
  type ReadRecord as S2ReadRecord,
  type StreamConfig,
} from '@s2-dev/streamstore'
import { recorderScript, recorderTestPage } from './recorderScript.js'
import type {
  AppendEventsRequest,
  CreateSessionRequest,
  HeartbeatSessionRequest,
  HealthResponse,
  ListSessionsResponse,
  LiveSessionMessage,
  SessionIndexMessage,
  ReplayEvent,
  SessionDetail,
  SessionMetadata,
  SessionSummary,
  StopSessionRequest,
  StoredSessionRecord,
} from '../src/shared/session.js'

dotenv.config({ path: '.env.local', quiet: true })
dotenv.config({ quiet: true })

const PORT = Number(process.env.PORT ?? 8787)
const S2_ACCESS_TOKEN = process.env.S2_ACCESS_TOKEN
const S2_BASIN = process.env.S2_BASIN
const S2_ACCOUNT_ENDPOINT = process.env.S2_ACCOUNT_ENDPOINT
const S2_BASIN_ENDPOINT = process.env.S2_BASIN_ENDPOINT
const STREAM_ROOT = (process.env.S2_STREAM_PREFIX ?? 'sessions/').replace(/\/+$/, '') || 'sessions'
const NODE_ENV = process.env.NODE_ENV ?? 'development'
const IS_PRODUCTION = NODE_ENV === 'production'
const JSON_BODY_LIMIT = process.env.REPLAYA_JSON_BODY_LIMIT ?? '8mb'
const SESSION_STREAM_PREFIX = `${STREAM_ROOT}/`
const SESSION_INDEX_STREAM = `${STREAM_ROOT}.index/sessions`
const REVERSE_TIME_MAX_MS = 9_999_999_999_999
const REVERSE_TIME_WIDTH = String(REVERSE_TIME_MAX_MS).length
const DELETE_ON_EMPTY_MIN_AGE_SECS = 60 * 60 * 24
const RETENTION_AGE_SECS = 60 * 60 * 24 * 28
const ACTIVE_SESSION_LEASE_MS = Number(process.env.REPLAYA_ACTIVE_SESSION_LEASE_MS ?? 45_000)
const EVENT_CHUNK_BYTES = 512 * 1024
const RECORD_ENVELOPE_HEADER = 'replaya-envelope'
const INGEST_AUTH_REQUIRED = parseBooleanEnv(process.env.REPLAYA_INGEST_AUTH_REQUIRED, IS_PRODUCTION)
const PROJECT_KEYS = splitConfigList(process.env.REPLAYA_PROJECT_KEYS ?? process.env.REPLAYA_PROJECT_KEY)
const INGEST_AUTH_ENABLED = INGEST_AUTH_REQUIRED || PROJECT_KEYS.length > 0
const APPEND_TOKEN_SECRET_EXPLICIT = process.env.REPLAYA_APPEND_TOKEN_SECRET
const APPEND_TOKEN_SECRET = APPEND_TOKEN_SECRET_EXPLICIT ?? randomUUID()
const APPEND_TOKEN_TTL_MS = Number(process.env.REPLAYA_APPEND_TOKEN_TTL_MS ?? 1000 * 60 * 60 * 24)
const ALLOWED_CAPTURE_ORIGINS = splitConfigList(process.env.REPLAYA_ALLOWED_CAPTURE_ORIGINS ?? process.env.CORS_ORIGIN)
const ALLOW_ANY_CAPTURE_ORIGIN = ALLOWED_CAPTURE_ORIGINS.includes('*')
const ALLOW_ORIGINLESS_INGEST = parseBooleanEnv(process.env.REPLAYA_ALLOW_ORIGINLESS_INGEST, !IS_PRODUCTION)
const RECORDER_TEST_ENABLED = parseBooleanEnv(process.env.REPLAYA_ENABLE_RECORDER_TEST, !IS_PRODUCTION)
const TRUST_PROXY = parseBooleanEnv(process.env.REPLAYA_TRUST_PROXY, false)
const SESSION_CREATE_RATE_LIMIT = Number(process.env.REPLAYA_SESSION_CREATE_RATE_LIMIT ?? 60)
const SESSION_APPEND_RATE_LIMIT = Number(process.env.REPLAYA_SESSION_APPEND_RATE_LIMIT ?? 600)
const RATE_LIMIT_WINDOW_MS = Number(process.env.REPLAYA_RATE_LIMIT_WINDOW_MS ?? 60_000)
const MAX_EVENTS_PER_BATCH = Number(process.env.REPLAYA_MAX_EVENTS_PER_BATCH ?? 100)
const LOG_REQUESTS = parseBooleanEnv(process.env.REPLAYA_LOG_REQUESTS, !IS_PRODUCTION)
const SHUTDOWN_GRACE_MS = Number(process.env.REPLAYA_SHUTDOWN_GRACE_MS ?? 10_000)
const EVENT_CHUNK_GROUP_TTL_MS = Number(process.env.REPLAYA_EVENT_CHUNK_GROUP_TTL_MS ?? 60_000)
const MAX_PENDING_CHUNK_GROUPS = Number(process.env.REPLAYA_MAX_PENDING_CHUNK_GROUPS ?? 64)
const SESSION_ID_PATTERN = /^session-[a-z0-9-]+$/
const ACTIVE_FENCE_TOKEN = 'active'
const STOPPED_FENCE_TOKEN = 'stopped'
const SESSION_STREAM_CONFIG = {
  timestamping: {
    mode: 'client-require',
  },
  deleteOnEmpty: {
    minAgeSecs: DELETE_ON_EMPTY_MIN_AGE_SECS,
  },
  retentionPolicy: {
    ageSecs: RETENTION_AGE_SECS,
  },
} satisfies StreamConfig
const EFFECTIVE_S2_ACCOUNT_ENDPOINT = S2_ACCOUNT_ENDPOINT ?? 'default S2 Cloud endpoint'
const EFFECTIVE_S2_BASIN_ENDPOINT = S2_BASIN_ENDPOINT ?? 'default S2 Cloud endpoint'
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

interface RateLimitBucket {
  count: number
  resetAt: number
}

const rateLimitBuckets = new Map<string, RateLimitBucket>()

function parseBooleanEnv(value: string | undefined, fallback: boolean) {
  if (value === undefined || value.trim() === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function splitConfigList(value: string | undefined) {
  if (!value) return []
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function normalizeOrigin(origin: string) {
  try {
    return new URL(origin).origin
  } catch {
    return null
  }
}

function appendVary(response: Response, value: string) {
  const current = response.getHeader('Vary')
  if (!current) {
    response.setHeader('Vary', value)
    return
  }

  const values = String(current)
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
  if (!values.includes(value.toLowerCase())) {
    response.setHeader('Vary', `${current}, ${value}`)
  }
}

function isAllowedCaptureOrigin(origin: string) {
  if (ALLOW_ANY_CAPTURE_ORIGIN) return true
  const normalized = normalizeOrigin(origin)
  if (!normalized) return false
  return ALLOWED_CAPTURE_ORIGINS.some((allowedOrigin) => normalizeOrigin(allowedOrigin) === normalized)
}

function requestOrigin(request: Request) {
  const origin = request.get('origin')
  return origin ? normalizeOrigin(origin) : null
}

function clientAddress(request: Request) {
  return request.ip || request.socket.remoteAddress || 'unknown'
}

function checkRateLimit(request: Request, bucketName: string, limit: number, subject = 'global') {
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(RATE_LIMIT_WINDOW_MS) || RATE_LIMIT_WINDOW_MS <= 0) {
    return
  }

  const now = Date.now()
  const key = `${bucketName}:${clientAddress(request)}:${subject}`
  const existing = rateLimitBuckets.get(key)
  const bucket = existing && existing.resetAt > now ? existing : { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS }
  bucket.count += 1
  rateLimitBuckets.set(key, bucket)

  if (bucket.count > limit) {
    throw new HttpError(429, 'Rate limit exceeded.')
  }

  if (rateLimitBuckets.size > 10_000) {
    for (const [bucketKey, value] of rateLimitBuckets) {
      if (value.resetAt <= now) rateLimitBuckets.delete(bucketKey)
    }
  }
}

function securityHeaders(request: Request, response: Response, next: NextFunction) {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')

  if (IS_PRODUCTION && (request.secure || request.get('x-forwarded-proto') === 'https')) {
    response.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains')
  }

  next()
}

function corsMiddleware(request: Request, response: Response, next: NextFunction) {
  const origin = request.get('origin')

  if (origin && isAllowedCaptureOrigin(origin)) {
    response.setHeader('Access-Control-Allow-Origin', normalizeOrigin(origin) ?? origin)
    appendVary(response, 'Origin')
  } else if (origin && request.method === 'OPTIONS' && IS_PRODUCTION) {
    response.sendStatus(403)
    return
  } else if (!origin && !IS_PRODUCTION) {
    response.setHeader('Access-Control-Allow-Origin', '*')
  }

  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  response.setHeader(
    'Access-Control-Allow-Headers',
    'content-type,last-event-id,x-replaya-project-key,x-replaya-session-token',
  )

  if (request.method === 'OPTIONS') {
    response.sendStatus(204)
    return
  }

  next()
}

function ensureCaptureOrigin(request: Request) {
  const origin = requestOrigin(request)
  if (!origin) {
    if (ALLOW_ORIGINLESS_INGEST) return
    throw new HttpError(403, 'Capture origin is required.')
  }

  if (isAllowedCaptureOrigin(origin)) return

  if (!IS_PRODUCTION && ALLOWED_CAPTURE_ORIGINS.length === 0) return

  throw new HttpError(403, 'Capture origin is not allowed.')
}

function projectKeyFromRequest(request: Request, body: unknown) {
  const payload = isObject(body) ? body : {}
  const headerKey = request.get('x-replaya-project-key')
  const bodyKey = typeof payload.projectKey === 'string' ? payload.projectKey : undefined
  return headerKey ?? bodyKey
}

function requireProjectKey(request: Request, body: unknown) {
  if (!INGEST_AUTH_ENABLED) return undefined
  if (PROJECT_KEYS.length === 0) {
    throw new HttpError(503, 'REPLAYA_PROJECT_KEY or REPLAYA_PROJECT_KEYS must be configured for ingest auth.')
  }

  const projectKey = projectKeyFromRequest(request, body)
  if (!projectKey || !PROJECT_KEYS.some((allowedKey) => safeEqual(projectKey, allowedKey))) {
    throw new HttpError(401, 'Invalid project key.')
  }

  return projectKey
}

function sessionTokenSignature(sessionId: string, expiresAtMs: number) {
  return createHmac('sha256', APPEND_TOKEN_SECRET).update(`${sessionId}.${expiresAtMs}`).digest('base64url')
}

function createAppendToken(sessionId: string) {
  if (!INGEST_AUTH_ENABLED) return undefined

  const expiresAtMs = Date.now() + APPEND_TOKEN_TTL_MS
  const signature = sessionTokenSignature(sessionId, expiresAtMs)
  return Buffer.from(`${sessionId}.${expiresAtMs}.${signature}`).toString('base64url')
}

function appendTokenFromRequest(request: Request, body: unknown) {
  const payload = isObject(body) ? body : {}
  const headerToken = request.get('x-replaya-session-token')
  const bodyToken = typeof payload.sessionToken === 'string' ? payload.sessionToken : undefined
  return headerToken ?? bodyToken
}

function requireAppendToken(request: Request, sessionId: string, body: unknown) {
  if (!INGEST_AUTH_ENABLED) return

  const token = appendTokenFromRequest(request, body)
  if (!token) {
    throw new HttpError(401, 'Missing session append token.')
  }

  let decoded
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8')
  } catch {
    throw new HttpError(401, 'Invalid session append token.')
  }

  const [tokenSessionId, expiresAtValue, signature] = decoded.split('.')
  const expiresAtMs = Number(expiresAtValue)
  if (
    tokenSessionId !== sessionId ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= Date.now() ||
    !signature
  ) {
    throw new HttpError(401, 'Invalid session append token.')
  }

  const expectedSignature = sessionTokenSignature(sessionId, expiresAtMs)
  if (!safeEqual(signature, expectedSignature)) {
    throw new HttpError(401, 'Invalid session append token.')
  }
}

const requestLogger: RequestHandler = (request, response, next) => {
  const startedAt = Date.now()
  response.on('finish', () => {
    if (response.statusCode >= 400 || LOG_REQUESTS) {
      console.log(`[replaya] ${request.method} ${request.originalUrl} ${response.statusCode} ${Date.now() - startedAt}ms`)
    }
  })
  next()
}

const app = express()
app.disable('x-powered-by')
if (TRUST_PROXY) app.set('trust proxy', true)
app.use(requestLogger)
app.use(securityHeaders)
app.use(corsMiddleware)
app.use(express.json({ limit: JSON_BODY_LIMIT }))

const s2 = S2_ACCESS_TOKEN
  ? new S2({
      ...s2EnvironmentConfig(),
      accessToken: S2_ACCESS_TOKEN,
    })
  : null

let basinReady: Promise<void> | null = null

function s2EnvironmentConfig() {
  const config = S2Environment.parse()
  if (S2_ACCOUNT_ENDPOINT || S2_BASIN_ENDPOINT) {
    config.endpoints = new S2Endpoints({
      account: S2_ACCOUNT_ENDPOINT,
      basin: S2_BASIN_ENDPOINT,
    })
  }

  return config
}

function requireS2() {
  if (!s2 || !S2_BASIN) {
    throw new HttpError(500, 'S2_ACCESS_TOKEN and S2_BASIN must be configured on the server.')
  }

  return {
    client: s2,
    basinName: S2_BASIN,
    basin: s2.basin(S2_BASIN),
  }
}

function parseSessionId(value: string) {
  if (!SESSION_ID_PATTERN.test(value)) {
    throw new HttpError(400, 'Invalid session id.')
  }

  return value
}

function sessionCreatedAtMs(sessionId: string) {
  const encoded = sessionId.split('-')[1]
  const createdAtMs = Number.parseInt(encoded ?? '', 36)
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) {
    throw new HttpError(400, 'Invalid session id timestamp.')
  }

  return createdAtMs
}

function reverseTimeKey(createdAtMs: number) {
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0 || createdAtMs > REVERSE_TIME_MAX_MS) {
    throw new HttpError(400, 'Invalid session timestamp.')
  }

  return String(REVERSE_TIME_MAX_MS - createdAtMs).padStart(REVERSE_TIME_WIDTH, '0')
}

function reverseTimePath(createdAtMs: number) {
  const key = reverseTimeKey(createdAtMs)
  return `${key.slice(0, 4)}/${key.slice(4, 7)}/${key.slice(7, 10)}/${key.slice(10)}`
}

function sessionStreamName(sessionId: string) {
  return `${SESSION_STREAM_PREFIX}${reverseTimePath(sessionCreatedAtMs(sessionId))}/${sessionId}`
}

function sessionIdFromStreamName(streamName: string) {
  const sessionId = streamName.split('/').at(-1)
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) return null
  return sessionId
}

function isDigits(value: string, length: number) {
  return value.length === length && /^\d+$/.test(value)
}

function isCurrentSessionStreamName(streamName: string) {
  if (!streamName.startsWith(SESSION_STREAM_PREFIX)) return false

  const parts = streamName.slice(SESSION_STREAM_PREFIX.length).split('/')
  return (
    parts.length === 5 &&
    isDigits(parts[0] ?? '', 4) &&
    isDigits(parts[1] ?? '', 3) &&
    isDigits(parts[2] ?? '', 3) &&
    isDigits(parts[3] ?? '', 3) &&
    SESSION_ID_PATTERN.test(parts[4] ?? '')
  )
}

function parseSessionIndexStreamName(body: string) {
  const streamName = body.trim()
  return isCurrentSessionStreamName(streamName) ? streamName : null
}

function paramString(value: string | string[] | undefined) {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'Missing route parameter.')
  }

  return value
}

function createSessionId(createdAtMs = Date.now()) {
  const nonce = randomUUID().replaceAll('-', '').slice(0, 10)
  return `session-${createdAtMs.toString(36)}-${nonce}`
}

function defaultTitle() {
  return `Session ${new Date().toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })}`
}

function normalizeTitle(title?: string) {
  const trimmed = title?.trim()
  if (!trimmed) return defaultTitle()
  return trimmed.slice(0, 120)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseBody<T>(value: unknown): T {
  if (!isObject(value)) {
    throw new HttpError(400, 'Request body must be a JSON object.')
  }

  return value as T
}

function parseEvents(value: unknown): ReplayEvent[] {
  if (!Array.isArray(value)) {
    throw new HttpError(400, 'events must be an array.')
  }

  if (value.length > MAX_EVENTS_PER_BATCH) {
    throw new HttpError(413, `events cannot contain more than ${MAX_EVENTS_PER_BATCH} records.`)
  }

  return value.map((event) => {
    if (!isObject(event)) {
      throw new HttpError(400, 'Each event must be a JSON object.')
    }

    return event as ReplayEvent
  })
}

function parseStoredRecord(body: string): StoredSessionRecord | null {
  try {
    const parsed = JSON.parse(body) as unknown
    if (!isObject(parsed) || typeof parsed.kind !== 'string' || typeof parsed.sessionId !== 'string') {
      return null
    }

    if (parsed.kind === 'metadata' && isObject(parsed.metadata)) {
      return parsed as StoredSessionRecord
    }

    if (parsed.kind === 'heartbeat' && typeof parsed.lastSeenAt === 'string') {
      return parsed as StoredSessionRecord
    }

    if (parsed.kind === 'event' && isObject(parsed.event)) {
      return parsed as StoredSessionRecord
    }

    const chunkIndex = parsed.chunkIndex
    const chunkCount = parsed.chunkCount
    const eventTimestamp = parsed.eventTimestamp
    if (
      parsed.kind === 'event-chunk' &&
      typeof parsed.chunkId === 'string' &&
      typeof chunkIndex === 'number' &&
      Number.isSafeInteger(chunkIndex) &&
      typeof chunkCount === 'number' &&
      Number.isSafeInteger(chunkCount) &&
      chunkIndex >= 0 &&
      chunkCount > 0 &&
      chunkIndex < chunkCount &&
      typeof eventTimestamp === 'number' &&
      Number.isFinite(eventTimestamp)
    ) {
      return parsed as StoredSessionRecord
    }
  } catch {
    return null
  }

  return null
}

type EventChunkEnvelope = Extract<StoredSessionRecord, { kind: 'event-chunk' }>
type StoredWriteRecord =
  | Exclude<StoredSessionRecord, { kind: 'event-chunk' }>
  | (EventChunkEnvelope & { body: Uint8Array })

function utf8Bytes(value: string) {
  return textEncoder.encode(value)
}

function utf8String(value: Uint8Array) {
  return textDecoder.decode(value)
}

function jsonBytes(value: unknown) {
  return utf8Bytes(JSON.stringify(value))
}

function bytesHeader(name: string, value: string): readonly [Uint8Array, Uint8Array] {
  return [utf8Bytes(name), utf8Bytes(value)]
}

function isChunkWriteRecord(record: StoredWriteRecord): record is EventChunkEnvelope & { body: Uint8Array } {
  return record.kind === 'event-chunk'
}

function envelopeFromBytesHeader(headers: ReadonlyArray<readonly [Uint8Array, Uint8Array]>) {
  for (const [name, value] of headers) {
    if (utf8String(name) === RECORD_ENVELOPE_HEADER) {
      return parseStoredRecord(utf8String(value))
    }
  }

  return null
}

function isS2Status(error: unknown, status: number) {
  return error instanceof S2Error && error.status === status
}

async function ensureBasin() {
  const { client, basinName } = requireS2()
  if (!basinReady) {
    basinReady = client.basins
      .ensure({
        basin: basinName,
        config: {
          createStreamOnAppend: true,
          createStreamOnRead: false,
          defaultStreamConfig: SESSION_STREAM_CONFIG,
        },
      })
      .then(() => undefined)
  }

  await basinReady
}

async function streamHandle(streamName: string) {
  await ensureBasin()
  const { basin } = requireS2()
  return basin.stream(streamName)
}

function toAppendRecords(records: StoredWriteRecord[]) {
  return records.map((record) => {
    if (isChunkWriteRecord(record)) {
      const { body, ...envelope } = record
      return AppendRecord.bytes({
        body,
        headers: [bytesHeader(RECORD_ENVELOPE_HEADER, JSON.stringify(envelope))],
        timestamp: timestampFromEnvelope(envelope),
      })
    }

    return AppendRecord.bytes({
      body: jsonBytes(record),
      timestamp: timestampFromEnvelope(record),
    })
  })
}

function fenceAppendRecord(fencingToken: string, timestamp?: number | Date) {
  return AppendRecord.bytes({
    body: utf8Bytes(fencingToken),
    headers: [bytesHeader('', 'fence')],
    timestamp,
  })
}

function timestampFromEnvelope(envelope: StoredSessionRecord) {
  if (envelope.kind === 'metadata') {
    const timestamp = Date.parse(envelope.metadata.stoppedAt ?? envelope.metadata.updatedAt ?? envelope.capturedAt)
    return Number.isFinite(timestamp) ? timestamp : 0
  }

  if (envelope.kind === 'heartbeat') {
    const timestamp = Date.parse(envelope.lastSeenAt)
    return Number.isFinite(timestamp) ? timestamp : 0
  }

  if (envelope.kind === 'event') {
    return timestampFromReplayEvent(envelope.event)
  }

  if (
    envelope.kind === 'event-chunk' &&
    typeof envelope.eventTimestamp === 'number' &&
    Number.isFinite(envelope.eventTimestamp)
  ) {
    return envelope.eventTimestamp
  }

  throw new HttpError(400, 'Session event records must include a valid timestamp.')
}

function timestampFromReplayEvent(event: ReplayEvent) {
  if (typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)) {
    return event.timestamp
  }

  throw new HttpError(400, 'Session event records must include a valid timestamp.')
}

interface StoredReadRecord {
  seqNum: number
  s2Timestamp: Date
  envelope: StoredSessionRecord
  body?: Uint8Array
}

type EventChunkReadRecord = StoredReadRecord & { envelope: EventChunkEnvelope; body: Uint8Array }

function storedReadRecordFromS2(record: S2ReadRecord<'bytes'>): StoredReadRecord | null {
  const parsed = envelopeFromBytesHeader(record.headers) ?? parseStoredRecord(utf8String(record.body))
  if (!parsed) return null

  const readRecord: StoredReadRecord = {
    seqNum: record.seqNum,
    s2Timestamp: record.timestamp,
    envelope: parsed,
  }
  if (parsed.kind === 'event-chunk') readRecord.body = record.body

  return readRecord
}

function isMetadataReadRecord(
  record: StoredReadRecord,
): record is StoredReadRecord & { envelope: Extract<StoredSessionRecord, { kind: 'metadata' }> } {
  return record.envelope.kind === 'metadata'
}

function isEventReadRecord(
  record: StoredReadRecord,
): record is StoredReadRecord & { envelope: Extract<StoredSessionRecord, { kind: 'event' }> } {
  return record.envelope.kind === 'event'
}

function isEventChunkReadRecord(
  record: StoredReadRecord,
): record is EventChunkReadRecord {
  return record.envelope.kind === 'event-chunk' && record.body instanceof Uint8Array
}

function isReplayEventLikeReadRecord(
  record: StoredReadRecord,
): record is StoredReadRecord & { envelope: Extract<StoredSessionRecord, { kind: 'event' | 'event-chunk' }> } {
  return isEventReadRecord(record) || isEventChunkReadRecord(record)
}

function isHeartbeatReadRecord(
  record: StoredReadRecord,
): record is StoredReadRecord & { envelope: Extract<StoredSessionRecord, { kind: 'heartbeat' }> } {
  return record.envelope.kind === 'heartbeat'
}

function storedRecordsForEvent(
  sessionId: string,
  capturedAt: string,
  event: ReplayEvent,
  eventCount?: number,
): StoredWriteRecord[] {
  const eventJson = JSON.stringify(event)
  const eventBytes = Buffer.from(eventJson, 'utf8')

  if (eventBytes.length <= EVENT_CHUNK_BYTES) {
    return [
      {
        kind: 'event',
        sessionId,
        capturedAt,
        event,
        eventCount,
      },
    ]
  }

  const eventTimestamp = timestampFromReplayEvent(event)
  const chunkId = randomUUID()
  const chunkCount = Math.ceil(eventBytes.length / EVENT_CHUNK_BYTES)
  const chunks: StoredWriteRecord[] = []

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
    const start = chunkIndex * EVENT_CHUNK_BYTES
    const end = Math.min(start + EVENT_CHUNK_BYTES, eventBytes.length)
    chunks.push({
      kind: 'event-chunk',
      sessionId,
      capturedAt,
      chunkId,
      chunkIndex,
      chunkCount,
      eventTimestamp,
      eventCount,
      body: eventBytes.subarray(start, end),
    })
  }

  return chunks
}

interface ChunkAssemblyGroup {
  chunkCount: number
  chunks: Map<number, EventChunkReadRecord>
  updatedAtMs: number
}

function logChunkAssemblyFailure(completedBy: EventChunkReadRecord, error: unknown) {
  console.error('[replaya] unable to assemble event chunks', {
    sessionId: completedBy.envelope.sessionId,
    chunkId: completedBy.envelope.chunkId,
    chunkCount: completedBy.envelope.chunkCount,
    seqNum: completedBy.seqNum,
    error: error instanceof Error ? error.message : String(error),
  })
}

function assembleChunkGroup(group: ChunkAssemblyGroup, completedBy: EventChunkReadRecord) {
  const orderedChunks: EventChunkReadRecord[] = []
  for (let index = 0; index < group.chunkCount; index++) {
    const chunk = group.chunks.get(index)
    if (!chunk) return null
    orderedChunks.push(chunk)
  }

  try {
    const eventJson = Buffer.concat(
      orderedChunks.map((chunk) => Buffer.from(chunk.body)),
    ).toString('utf8')
    const event = JSON.parse(eventJson) as unknown
    if (!isObject(event)) {
      logChunkAssemblyFailure(completedBy, 'assembled event was not a JSON object')
      return null
    }

    return {
      seqNum: completedBy.seqNum,
      s2Timestamp: completedBy.s2Timestamp,
      envelope: {
        kind: 'event',
        sessionId: completedBy.envelope.sessionId,
        capturedAt: completedBy.envelope.capturedAt,
        event: event as ReplayEvent,
        eventCount: completedBy.envelope.eventCount,
      },
    } satisfies StoredReadRecord
  } catch (error) {
    logChunkAssemblyFailure(completedBy, error)
    return null
  }
}

function createChunkAssembler() {
  const groups = new Map<string, ChunkAssemblyGroup>()

  const pruneGroups = (nowMs: number) => {
    for (const [chunkId, group] of groups) {
      if (nowMs - group.updatedAtMs > EVENT_CHUNK_GROUP_TTL_MS) {
        groups.delete(chunkId)
      }
    }

    while (groups.size > MAX_PENDING_CHUNK_GROUPS) {
      const oldestChunkId = groups.keys().next().value
      if (oldestChunkId === undefined) break
      groups.delete(oldestChunkId)
    }
  }

  return {
    push(record: StoredReadRecord) {
      const nowMs = Date.now()
      pruneGroups(nowMs)

      if (!isEventChunkReadRecord(record)) return record

      const { chunkId, chunkIndex, chunkCount } = record.envelope
      if (
        !Number.isSafeInteger(chunkIndex) ||
        !Number.isSafeInteger(chunkCount) ||
        chunkIndex < 0 ||
        chunkCount < 1 ||
        chunkIndex >= chunkCount
      ) {
        return null
      }

      const existing = groups.get(chunkId)
      if (!existing && chunkIndex !== 0) return null

      const group: ChunkAssemblyGroup = existing ?? { chunkCount, chunks: new Map(), updatedAtMs: nowMs }
      if (group.chunkCount !== chunkCount || group.chunks.has(chunkIndex)) {
        groups.delete(chunkId)
        return null
      }

      group.chunks.set(chunkIndex, record)
      group.updatedAtMs = nowMs
      groups.delete(chunkId)
      groups.set(chunkId, group)

      if (group.chunks.size < chunkCount) {
        pruneGroups(nowMs)
        return null
      }

      groups.delete(chunkId)
      return assembleChunkGroup(group, record)
    },
  }
}

function assembleChunkedEvents(records: StoredReadRecord[]) {
  const assembler = createChunkAssembler()
  const assembled: StoredReadRecord[] = []

  for (const record of records) {
    const next = assembler.push(record)
    if (next) assembled.push(next)
  }

  return assembled
}

async function appendStoredRecords(sessionId: string, records: StoredWriteRecord[]) {
  return appendRecordsToStream(sessionStreamName(sessionId), toAppendRecords(records), {
    fencingToken: ACTIVE_FENCE_TOKEN,
  })
}

async function appendStoredRecordsDirect(
  sessionId: string,
  records: StoredWriteRecord[],
  options?: { fencingToken?: string; matchSeqNum?: number },
) {
  return appendRecordsToStream(sessionStreamName(sessionId), toAppendRecords(records), {
    fencingToken: options?.fencingToken,
    matchSeqNum: options?.matchSeqNum,
    useProducer: false,
  })
}

async function appendRecordsToStream(
  streamName: string,
  records: S2AppendRecord[],
  options: { fencingToken?: string; matchSeqNum?: number; useProducer?: boolean } = {},
) {
  const stream = await streamHandle(streamName)

  if (records.length === 0) {
    return { appended: 0, tailSeqNum: null }
  }

  if (options.useProducer === false || options.matchSeqNum !== undefined) {
    const ack = await stream.append(
      AppendInput.create(records, {
        fencingToken: options.fencingToken,
        matchSeqNum: options.matchSeqNum,
      }),
    )

    return {
      appended: records.length,
      tailSeqNum: ack.tail.seqNum,
    }
  }

  const producer = new Producer(
    new BatchTransform({ fencingToken: options.fencingToken }),
    await stream.appendSession(),
    streamName,
  )
  const tickets = []

  try {
    for (const record of records) {
      tickets.push(await producer.submit(record))
    }

    const acks = []
    for (const ticket of tickets) {
      acks.push(await ticket.ack())
    }

    await producer.close()

    return {
      appended: records.length,
      tailSeqNum: acks.reduce((tailSeqNum, ack) => Math.max(tailSeqNum, ack.seqNum() + 1), 0),
    }
  } catch (error) {
    try {
      await producer.close()
    } catch {
      // Preserve the original append error.
    }
    throw error
  }
}

async function appendSessionIndexRecord(sessionId: string) {
  return appendRecordsToStream(
    SESSION_INDEX_STREAM,
    [
      AppendRecord.string({
        body: sessionStreamName(sessionId),
        timestamp: new Date(),
      }),
    ],
    { useProducer: false },
  )
}

function appendSessionIndexRecordBestEffort(sessionId: string) {
  void appendSessionIndexRecord(sessionId).catch((error) => {
    console.warn(
      `Unable to append session ${sessionId} to ${SESSION_INDEX_STREAM}:`,
      error instanceof Error ? error.message : error,
    )
  })
}

async function readStreamRecords(streamName: string) {
  const stream = await streamHandle(streamName)
  const records: StoredReadRecord[] = []
  let nextSeqNum = 0
  let tailSeqNum = Number.POSITIVE_INFINITY

  while (nextSeqNum < tailSeqNum) {
    let batch
    try {
      batch = await stream.read(
        {
          start: { from: { seqNum: nextSeqNum }, clamp: true },
          stop: { limits: { count: 1000 } },
          ignoreCommandRecords: true,
        },
        { as: 'bytes' },
      )
    } catch (error) {
      if (isS2Status(error, 416) && records.length > 0) break
      throw error
    }

    if (batch.tail) {
      tailSeqNum = batch.tail.seqNum
    }

    if (batch.records.length === 0) break

    for (const record of batch.records) {
      const parsed = storedReadRecordFromS2(record)
      if (parsed) records.push(parsed)
      nextSeqNum = record.seqNum + 1
    }
  }

  return { records: assembleChunkedEvents(records), tailSeqNum: Number.isFinite(tailSeqNum) ? tailSeqNum : nextSeqNum }
}

async function readStoredRecords(sessionId: string) {
  const streamName = sessionStreamName(sessionId)
  try {
    return {
      streamName,
      ...(await readStreamRecords(streamName)),
    }
  } catch (error) {
    if (isS2Status(error, 404)) throw new HttpError(404, 'Session stream not found.')
    throw error
  }
}

function summarizeSession(
  sessionId: string,
  streamName: string,
  tailSeqNum: number,
  records: StoredReadRecord[],
  options: { deriveStatus?: boolean } = {},
): SessionSummary {
  const metadata = records.filter(isMetadataReadRecord).at(-1)?.envelope.metadata

  const eventRecords = records.filter(isEventReadRecord)
  const firstEventTimestamp = eventRecords.at(0)?.s2Timestamp
  const lastEventTimestamp = eventRecords.at(-1)?.s2Timestamp
  const fallbackTime = new Date().toISOString()
  const lastSeenAt = sessionLastSeenAt(records, metadata) ?? fallbackTime
  const updatedAt = newestIso(metadata?.updatedAt, lastSeenAt, lastEventTimestamp?.toISOString()) ?? fallbackTime

  const summary: SessionSummary = {
    id: sessionId,
    title: metadata?.title ?? sessionId,
    status: metadata?.status ?? 'active',
    createdAt: metadata?.createdAt ?? fallbackTime,
    updatedAt,
    lastSeenAt,
    stoppedAt: metadata?.stoppedAt,
    stopReason: metadata?.stopReason,
    eventCount: Math.max(metadata?.eventCount ?? 0, eventRecords.length),
    url: metadata?.url,
    source: metadata?.source,
    distinctId: metadata?.distinctId,
    userId: metadata?.userId,
    sdk: metadata?.sdk,
    streamName,
    recordCount: tailSeqNum,
    lastSeqNum: Math.max(0, tailSeqNum - 1),
    timelineSource: 's2-record-timestamp',
    firstEventAt: firstEventTimestamp?.toISOString(),
    lastEventAt: lastEventTimestamp?.toISOString(),
    durationMs:
      firstEventTimestamp && lastEventTimestamp
        ? Math.max(0, lastEventTimestamp.getTime() - firstEventTimestamp.getTime())
        : 0,
  }

  return options.deriveStatus === false ? summary : deriveSessionStatus(summary)
}

function eventWithS2Timestamp(record: StoredReadRecord): ReplayEvent | null {
  if (!isEventReadRecord(record)) return null

  const originalTimestamp =
    typeof record.envelope.event.timestamp === 'number' ? record.envelope.event.timestamp : undefined
  const s2TimestampMs = record.s2Timestamp.getTime()

  return {
    ...record.envelope.event,
    timestamp: s2TimestampMs,
    _replaya: {
      originalTimestamp,
      s2SeqNum: record.seqNum,
      s2Timestamp: record.s2Timestamp.toISOString(),
      timelineSource: 's2-record-timestamp',
    },
  }
}

async function loadSessionDetail(
  sessionId: string,
  options: { deriveStatus?: boolean } = {},
): Promise<SessionDetail> {
  const { streamName, records, tailSeqNum } = await readStoredRecords(sessionId)
  const summary = summarizeSession(sessionId, streamName, tailSeqNum, records, options)
  return sessionDetailFromSummaryAndRecords(summary, records)
}

function sessionDetailFromSummaryAndRecords(summary: SessionSummary, records: StoredReadRecord[]): SessionDetail {
  const metadataHistory = records
    .filter(isMetadataReadRecord)
    .map((record) => record.envelope.metadata)
  const events = records.map(eventWithS2Timestamp).filter((event): event is ReplayEvent => event !== null)

  return {
    ...summary,
    eventCount: events.length,
    events,
    metadataHistory,
  }
}

function parseDateMs(value?: string) {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function newestIso(...values: Array<string | undefined>) {
  const newest = values.reduce<number | null>((latest, value) => {
    const parsed = parseDateMs(value)
    if (parsed === null) return latest
    return latest === null ? parsed : Math.max(latest, parsed)
  }, null)

  return newest === null ? undefined : new Date(newest).toISOString()
}

function leaseExpiresAtMs(lastSeenAt?: string) {
  const lastSeenMs = parseDateMs(lastSeenAt)
  if (lastSeenMs === null || !Number.isFinite(ACTIVE_SESSION_LEASE_MS) || ACTIVE_SESSION_LEASE_MS <= 0) {
    return null
  }

  return lastSeenMs + ACTIVE_SESSION_LEASE_MS
}

function deriveSessionStatus<T extends SessionSummary>(summary: T, nowMs = Date.now()): T {
  if (summary.status === 'stopped') return summary

  const expiresAt = leaseExpiresAtMs(summary.lastSeenAt ?? summary.updatedAt)
  if (expiresAt === null || nowMs <= expiresAt) return summary

  return {
    ...summary,
    status: 'stopped',
    stoppedAt: new Date(expiresAt).toISOString(),
    stopReason: 'lease-expired',
  }
}

function sessionLastSeenAt(records: StoredReadRecord[], metadata?: SessionMetadata) {
  const eventCapturedAt = newestIso(
    ...records.filter(isEventReadRecord).map((record) => record.envelope.capturedAt),
  )
  const heartbeatAt = newestIso(
    ...records
      .filter(isHeartbeatReadRecord)
      .map((record) => record.envelope.lastSeenAt ?? record.envelope.capturedAt),
  )

  return newestIso(metadata?.lastSeenAt, metadata?.updatedAt, eventCapturedAt, heartbeatAt)
}

async function readStreamWindow(
  stream: Awaited<ReturnType<typeof streamHandle>>,
  startSeqNum: number,
  count: number,
) {
  if (count <= 0) return []

  let batch
  try {
    batch = await stream.read(
      {
        start: { from: { seqNum: startSeqNum }, clamp: true },
        stop: { limits: { count } },
        ignoreCommandRecords: true,
      },
      { as: 'bytes' },
    )
  } catch (error) {
    if (isS2Status(error, 416)) return []
    throw error
  }

  return batch.records
    .map(storedReadRecordFromS2)
    .filter((record): record is StoredReadRecord => record !== null)
}

async function readTailWindow(stream: Awaited<ReturnType<typeof streamHandle>>, count: number) {
  if (count <= 0) return { records: [], tail: undefined }

  let batch
  try {
    batch = await stream.read(
      {
        start: { from: { tailOffset: count }, clamp: true },
        stop: { limits: { count } },
        ignoreCommandRecords: true,
      },
      { as: 'bytes' },
    )
  } catch (error) {
    if (isS2Status(error, 416)) return { records: [], tail: undefined }
    throw error
  }

  return {
    records: batch.records
      .map(storedReadRecordFromS2)
      .filter((record): record is StoredReadRecord => record !== null),
    tail: batch.tail,
  }
}

async function readStreamSnapshot(streamName: string, tailReadLimit = 1) {
  const stream = await streamHandle(streamName)
  const [firstRecords, tailRecords] = await Promise.all([
    readStreamWindow(stream, 0, 2),
    readTailWindow(stream, tailReadLimit),
  ])
  const tailRecord = tailRecords.records.at(-1)
  const lastRecord = tailRecord ?? firstRecords.at(-1)

  return {
    streamName,
    tailSeqNum: tailRecords.tail?.seqNum ?? (lastRecord ? lastRecord.seqNum + 1 : 0),
    tailTimestamp: tailRecords.tail?.timestamp ?? lastRecord?.s2Timestamp ?? new Date(0),
    firstRecords,
    tailRecords: tailRecords.records,
  }
}

function latestRecordOfKind<K extends StoredSessionRecord['kind']>(
  records: StoredReadRecord[],
  kind: K,
): (StoredReadRecord & { envelope: Extract<StoredSessionRecord, { kind: K }> }) | undefined {
  return records
    .filter((record): record is StoredReadRecord & { envelope: Extract<StoredSessionRecord, { kind: K }> } => {
      return record.envelope.kind === kind
    })
    .at(-1)
}

function latestReplayEventLikeRecord(records: StoredReadRecord[]) {
  return records.filter(isReplayEventLikeReadRecord).at(-1)
}

function eventCountFromRecord(record?: StoredReadRecord) {
  if (!record || !isReplayEventLikeReadRecord(record)) return undefined
  return record.envelope.eventCount
}

function summaryFromStreamSnapshot(snapshot: Awaited<ReturnType<typeof readStreamSnapshot>>): SessionSummary | null {
  const sessionId = sessionIdFromStreamName(snapshot.streamName)
  if (!sessionId) return null

  const firstMetadata = snapshot.firstRecords.find(isMetadataReadRecord)?.envelope.metadata
  const firstEvent = snapshot.firstRecords.find(isReplayEventLikeReadRecord)
  const latestStopMetadata = snapshot.tailRecords
    .filter(isMetadataReadRecord)
    .filter((record) => record.envelope.metadata.status === 'stopped')
    .at(-1)?.envelope.metadata
  const latestMetadata = latestStopMetadata ?? firstMetadata
  const latestHeartbeat = latestRecordOfKind(snapshot.tailRecords, 'heartbeat')?.envelope
  const latestEventRecord = latestReplayEventLikeRecord(snapshot.tailRecords)
  const fallbackTime = new Date(sessionCreatedAtMs(sessionId)).toISOString()
  const lastSeenAt = snapshot.tailTimestamp.toISOString()
  const firstEventAt = firstEvent?.s2Timestamp.toISOString()
  const lastEventAt = latestEventRecord?.s2Timestamp.toISOString()
  const eventCount =
    latestStopMetadata?.eventCount ??
    latestHeartbeat?.eventCount ??
    eventCountFromRecord(latestEventRecord) ??
    firstMetadata?.eventCount ??
    0

  const summary: SessionSummary = {
    id: sessionId,
    title: latestMetadata?.title ?? sessionId,
    status: latestStopMetadata ? 'stopped' : 'active',
    createdAt: latestMetadata?.createdAt ?? fallbackTime,
    updatedAt: latestStopMetadata?.updatedAt ?? lastSeenAt,
    lastSeenAt,
    stoppedAt: latestStopMetadata?.stoppedAt,
    stopReason: latestStopMetadata?.stopReason,
    eventCount,
    url: latestMetadata?.url,
    source: latestMetadata?.source,
    distinctId: latestMetadata?.distinctId,
    userId: latestMetadata?.userId,
    sdk: latestMetadata?.sdk,
    streamName: snapshot.streamName,
    recordCount: snapshot.tailSeqNum,
    lastSeqNum: Math.max(0, snapshot.tailSeqNum - 1),
    timelineSource: 's2-record-timestamp',
    firstEventAt,
    lastEventAt,
    durationMs:
      firstEventAt && lastEventAt ? Math.max(0, Date.parse(lastEventAt) - Date.parse(firstEventAt)) : 0,
  }

  return deriveSessionStatus(summary)
}

async function loadSessionSummary(sessionId: string) {
  try {
    const summary = summaryFromStreamSnapshot(await readStreamSnapshot(sessionStreamName(sessionId)))
    if (summary) return summary
  } catch (error) {
    if (isS2Status(error, 404)) throw new HttpError(404, 'Session stream not found.')
    throw error
  }

  throw new HttpError(404, 'Session stream not found.')
}

async function loadSessionSummaryByStreamName(streamName: string) {
  if (!isCurrentSessionStreamName(streamName)) {
    throw new HttpError(400, 'Invalid session stream name.')
  }

  try {
    const summary = summaryFromStreamSnapshot(await readStreamSnapshot(streamName))
    if (summary) return summary
  } catch (error) {
    if (isS2Status(error, 404)) throw new HttpError(404, 'Session stream not found.')
    throw error
  }

  throw new HttpError(404, 'Session stream not found.')
}

async function readSessionIndexTailSeqNum() {
  const stream = await streamHandle(SESSION_INDEX_STREAM)
  try {
    return (await stream.checkTail()).tail.seqNum
  } catch (error) {
    if (isS2Status(error, 404)) return 0
    throw error
  }
}

async function listSessionSummaries(limit: number, startAfter?: string) {
  await ensureBasin()
  const { basin } = requireS2()
  const latestPage = startAfter === undefined
  const indexTailSeqNum = latestPage ? await readSessionIndexTailSeqNum() : null
  const page = await basin.streams.list({
    prefix: SESSION_STREAM_PREFIX,
    startAfter,
    limit,
  })
  const summaries = (
    await Promise.all(
      page.streams
        .filter((streamInfo) => !streamInfo.deletedAt && isCurrentSessionStreamName(streamInfo.name))
        .map(async (streamInfo) => {
          try {
            return summaryFromStreamSnapshot(await readStreamSnapshot(streamInfo.name))
          } catch (error) {
            if (isS2Status(error, 404) || isS2Status(error, 409)) return null
            throw error
          }
        }),
    )
  ).filter((summary): summary is SessionSummary => summary !== null)

  return {
    summaries,
    hasMore: page.hasMore,
    nextStartAfter: page.streams.at(-1)?.name,
    latestPage,
    indexTailSeqNum,
  }
}

function asyncRoute(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<void>,
) {
  return (request: Request, response: Response, next: NextFunction) => {
    handler(request, response, next).catch(next)
  }
}

function parseSeqNum(value: unknown, fallback: number) {
  if (typeof value !== 'string' || value.trim() === '') return fallback

  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new HttpError(400, 'Sequence number must be a non-negative integer.')
  }

  return parsed
}

function parseListLimit(value: unknown) {
  if (typeof value !== 'string' || value.trim() === '') return 100

  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1000) {
    throw new HttpError(400, 'limit must be an integer between 1 and 1000.')
  }

  return parsed
}

function writeSse(response: Response, event: string, payload: LiveSessionMessage | SessionIndexMessage, id?: number) {
  if (id !== undefined) response.write(`id: ${id}\n`)
  response.write(`event: ${event}\n`)
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function writeSseComment(response: Response, comment: string) {
  response.write(`: ${comment}\n\n`)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

app.get(
  '/api/health',
  asyncRoute(async (_request, response) => {
    const payload: HealthResponse = {
      ok: false,
      configured: Boolean(S2_ACCESS_TOKEN && S2_BASIN),
      basin: S2_BASIN ?? null,
      streamPrefix: SESSION_STREAM_PREFIX,
      activeSessionLeaseMs: ACTIVE_SESSION_LEASE_MS,
      s2Status: S2_ACCESS_TOKEN && S2_BASIN ? 'error' : 'missing-config',
      recorderScriptPath: '/recorder.js',
      s2Endpoints: {
        account: EFFECTIVE_S2_ACCOUNT_ENDPOINT,
        basin: EFFECTIVE_S2_BASIN_ENDPOINT,
      },
      security: {
        ingestAuthRequired: INGEST_AUTH_REQUIRED,
        ingestAuthConfigured: PROJECT_KEYS.length > 0,
        allowedCaptureOriginsConfigured: ALLOW_ANY_CAPTURE_ORIGIN || ALLOWED_CAPTURE_ORIGINS.length > 0,
        recorderTestEnabled: RECORDER_TEST_ENABLED,
      },
    }

    if (payload.configured) {
      try {
        await ensureBasin()
        payload.ok = true
        payload.s2Status = 'ready'
      } catch (error) {
        payload.error = error instanceof Error ? error.message : 'S2 health check failed.'
      }
    }

    response.json(payload)
  }),
)

app.get(
  '/api/sessions',
  asyncRoute(async (request, response) => {
    const limit = parseListLimit(request.query.limit)
    const startAfter = typeof request.query.startAfter === 'string' ? request.query.startAfter : undefined
    const { summaries, hasMore, nextStartAfter, latestPage, indexTailSeqNum } = await listSessionSummaries(
      limit,
      startAfter,
    )

    const payload: ListSessionsResponse = {
      sessions: summaries,
      hasMore,
      nextStartAfter,
      latestPage,
      indexTailSeqNum,
    }
    response.json(payload)
  }),
)

app.post(
  '/api/sessions',
  asyncRoute(async (request, response) => {
    const body = parseBody<CreateSessionRequest>(request.body)
    ensureCaptureOrigin(request)
    const projectKey = requireProjectKey(request, body)
    checkRateLimit(request, 'session-create', SESSION_CREATE_RATE_LIMIT, projectKey ?? 'open')

    const createdAtMs = Date.now()
    const id = createSessionId(createdAtMs)
    const now = new Date(createdAtMs).toISOString()
    const metadata: SessionMetadata = {
      id,
      title: normalizeTitle(body.title),
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      eventCount: 0,
      url: typeof body.url === 'string' ? body.url.slice(0, 500) : undefined,
      source: typeof body.source === 'string' ? body.source.slice(0, 120) : undefined,
      distinctId: typeof body.distinctId === 'string' ? body.distinctId.slice(0, 240) : undefined,
      userId: typeof body.userId === 'string' ? body.userId.slice(0, 240) : undefined,
      sdk: typeof body.sdk === 'string' ? body.sdk.slice(0, 80) : undefined,
    }

    const result = await appendRecordsToStream(
      sessionStreamName(id),
      [
        fenceAppendRecord(ACTIVE_FENCE_TOKEN, new Date(now)),
        ...toAppendRecords([
          {
            kind: 'metadata',
            sessionId: id,
            capturedAt: now,
            metadata,
          },
        ]),
      ],
      { useProducer: false },
    )
    void result
    appendSessionIndexRecordBestEffort(id)

    const appendToken = createAppendToken(id)
    response.status(201).json({
      session: await loadSessionDetail(id),
      appendToken,
      appendTokenExpiresAt: appendToken ? new Date(Date.now() + APPEND_TOKEN_TTL_MS).toISOString() : undefined,
    })
  }),
)

app.get(
  '/api/sessions/index/live',
  asyncRoute(async (request, response) => {
    const requestedFromSeqNum = parseSeqNum(request.query.fromSeqNum, 0)
    const lastEventSeqNum = parseSeqNum(request.get('last-event-id'), -1)
    let fromSeqNum = Math.max(requestedFromSeqNum, lastEventSeqNum + 1)

    let closed = false
    let cancelReadSession: ((reason: string) => Promise<unknown>) | null = null

    const heartbeat = setInterval(() => {
      if (!closed) writeSseComment(response, 'session-index-live')
    }, 15_000)

    const close = () => {
      closed = true
      clearInterval(heartbeat)
      void cancelReadSession?.('client disconnected').catch(() => undefined)
      if (!response.writableEnded) response.end()
    }

    request.socket.setTimeout(0)
    response.status(200)
    response.setHeader('Content-Type', 'text/event-stream')
    response.setHeader('Cache-Control', 'no-cache, no-transform')
    response.setHeader('Connection', 'keep-alive')
    response.setHeader('X-Accel-Buffering', 'no')
    response.flushHeaders()

    request.on('close', close)

    writeSse(response, 'session-index-ready', {
      type: 'ready',
      fromSeqNum,
    })

    try {
      while (!closed) {
        try {
          const stream = await streamHandle(SESSION_INDEX_STREAM)
          const readSession = await stream.readSession({
            start: { from: { seqNum: fromSeqNum }, clamp: true },
            ignoreCommandRecords: true,
          })
          cancelReadSession = (reason: string) => readSession.cancel(reason)

          for await (const record of readSession) {
            if (closed) break
            fromSeqNum = record.seqNum + 1

            const streamName = parseSessionIndexStreamName(record.body)
            if (!streamName) continue

            let summary
            try {
              summary = await loadSessionSummaryByStreamName(streamName)
            } catch (error) {
              if (
                isS2Status(error, 404) ||
                isS2Status(error, 409) ||
                (error instanceof HttpError && (error.status === 404 || error.status === 409))
              ) {
                continue
              }
              throw error
            }

            writeSse(
              response,
              'session-index-session',
              {
                type: 'session',
                seqNum: record.seqNum,
                s2Timestamp: record.timestamp.toISOString(),
                streamName,
                session: summary,
              },
              record.seqNum,
            )
          }

          cancelReadSession = null
          if (!closed) await sleep(500)
        } catch (error) {
          cancelReadSession = null
          if (closed) break

          if (isS2Status(error, 404) || isS2Status(error, 416)) {
            await sleep(1_000)
            continue
          }

          writeSse(response, 'session-index-error', {
            type: 'error',
            error: error instanceof Error ? error.message : 'S2 session index tail failed.',
          })
          break
        }
      }
    } finally {
      close()
    }
  }),
)

app.get(
  '/api/sessions/:id/live',
  asyncRoute(async (request, response) => {
    const sessionId = parseSessionId(paramString(request.params.id))
    const requestedFromSeqNum = parseSeqNum(request.query.fromSeqNum, 0)
    const lastEventSeqNum = parseSeqNum(request.get('last-event-id'), -1)
    const fromSeqNum = Math.max(requestedFromSeqNum, lastEventSeqNum + 1)
    const rawSummary = await loadSessionSummary(sessionId)

    let closed = false
    let latestLastSeenAt = rawSummary.lastSeenAt ?? rawSummary.updatedAt
    let latestStoppedAt = rawSummary.stoppedAt
    let leaseTimer: ReturnType<typeof setTimeout> | null = null
    let cancelReadSession: ((reason: string) => Promise<unknown>) | null = null

    const heartbeat = setInterval(() => {
      if (!closed) writeSseComment(response, 'live')
    }, 15_000)

    const clearTimers = () => {
      clearInterval(heartbeat)
      if (leaseTimer) clearTimeout(leaseTimer)
    }

    const closeWithStatus = (reason: 'explicit-stop' | 'lease-expired') => {
      if (closed) return

      const stoppedAt =
        reason === 'lease-expired'
          ? new Date(leaseExpiresAtMs(latestLastSeenAt) ?? Date.now()).toISOString()
          : (latestStoppedAt ?? new Date().toISOString())

      writeSse(response, 'session-status', {
        type: 'status',
        sessionId,
        status: 'stopped',
        reason,
        lastSeenAt: latestLastSeenAt,
        stoppedAt,
      })
      closed = true
      clearTimers()
      void cancelReadSession?.(`session ${reason}`).catch(() => undefined)
      if (!response.writableEnded) response.end()
    }

    const scheduleLeaseExpiration = (lastSeenAt?: string) => {
      if (lastSeenAt) latestLastSeenAt = lastSeenAt
      if (leaseTimer) clearTimeout(leaseTimer)

      const expiresAt = leaseExpiresAtMs(latestLastSeenAt)
      if (expiresAt === null) return

      leaseTimer = setTimeout(
        () => closeWithStatus('lease-expired'),
        Math.max(0, expiresAt - Date.now()),
      )
    }

    request.socket.setTimeout(0)
    response.status(200)
    response.setHeader('Content-Type', 'text/event-stream')
    response.setHeader('Cache-Control', 'no-cache, no-transform')
    response.setHeader('Connection', 'keep-alive')
    response.setHeader('X-Accel-Buffering', 'no')
    response.flushHeaders()

    request.on('close', () => {
      closed = true
      clearTimers()
      void cancelReadSession?.('client disconnected').catch(() => undefined)
    })

    writeSse(response, 'session-ready', {
      type: 'ready',
      sessionId,
      fromSeqNum,
    })

    const derivedSummary = deriveSessionStatus(rawSummary)
    if (derivedSummary.status === 'stopped') {
      closeWithStatus(derivedSummary.stopReason === 'lease-expired' ? 'lease-expired' : 'explicit-stop')
      return
    }

    scheduleLeaseExpiration(latestLastSeenAt)

    try {
      const stream = await streamHandle(rawSummary.streamName)
      const readSession = await stream.readSession(
        {
          start: { from: { seqNum: fromSeqNum }, clamp: true },
          ignoreCommandRecords: true,
        },
        { as: 'bytes' },
      )
      cancelReadSession = (reason: string) => readSession.cancel(reason)
      const chunkAssembler = createChunkAssembler()

      for await (const record of readSession) {
        if (closed) break

        const parsed = storedReadRecordFromS2(record)
        if (!parsed) continue
        const assembled = chunkAssembler.push(parsed)
        if (!assembled) continue

        if (isEventReadRecord(assembled)) {
          const event = eventWithS2Timestamp(assembled)
          if (!event) continue

          writeSse(
            response,
            'session-event',
            {
              type: 'event',
              sessionId,
              seqNum: assembled.seqNum,
              s2Timestamp: assembled.s2Timestamp.toISOString(),
              capturedAt: assembled.envelope.capturedAt,
              event,
            },
            assembled.seqNum,
          )
          scheduleLeaseExpiration(assembled.envelope.capturedAt)
        } else if (isHeartbeatReadRecord(assembled)) {
          scheduleLeaseExpiration(assembled.envelope.lastSeenAt)
          writeSse(
            response,
            'session-heartbeat',
            {
              type: 'heartbeat',
              sessionId,
              seqNum: assembled.seqNum,
              s2Timestamp: assembled.s2Timestamp.toISOString(),
              lastSeenAt: assembled.envelope.lastSeenAt,
            },
            assembled.seqNum,
          )
        } else if (isMetadataReadRecord(assembled)) {
          writeSse(
            response,
            'session-metadata',
            {
              type: 'metadata',
              sessionId,
              seqNum: assembled.seqNum,
              s2Timestamp: assembled.s2Timestamp.toISOString(),
              metadata: assembled.envelope.metadata,
            },
            assembled.seqNum,
          )

          if (assembled.envelope.metadata.status === 'stopped') {
            latestLastSeenAt = assembled.envelope.metadata.lastSeenAt ?? assembled.envelope.metadata.updatedAt
            latestStoppedAt = assembled.envelope.metadata.stoppedAt ?? assembled.envelope.metadata.updatedAt
            closeWithStatus('explicit-stop')
            break
          }

          scheduleLeaseExpiration(assembled.envelope.metadata.lastSeenAt ?? assembled.envelope.metadata.updatedAt)
        }
      }
    } catch (error) {
      if (!closed) {
        writeSse(response, 'session-error', {
          type: 'error',
          sessionId,
          error: error instanceof Error ? error.message : 'S2 live read failed.',
        })
      }
    } finally {
      closed = true
      clearTimers()
      if (!response.writableEnded) response.end()
    }
  }),
)

app.get(
  '/api/sessions/:id',
  asyncRoute(async (request, response) => {
    const sessionId = parseSessionId(paramString(request.params.id))
    response.json({ session: await loadSessionDetail(sessionId) })
  }),
)

// Admin/read-side surface (deploy behind your access boundary): purge a
// session's stream on demand instead of waiting out retention. Idempotent.
app.delete(
  '/api/sessions/:id',
  asyncRoute(async (request, response) => {
    const sessionId = parseSessionId(paramString(request.params.id))
    const { basin } = requireS2()
    try {
      await basin.streams.delete({ stream: sessionStreamName(sessionId) })
    } catch (error) {
      if (!isS2Status(error, 404)) throw error
    }
    response.json({ deleted: sessionId })
  }),
)

app.post(
  '/api/sessions/:id/events',
  asyncRoute(async (request, response) => {
    const sessionId = parseSessionId(paramString(request.params.id))
    const body = parseBody<AppendEventsRequest>(request.body)
    ensureCaptureOrigin(request)
    requireAppendToken(request, sessionId, body)
    checkRateLimit(request, 'session-append', SESSION_APPEND_RATE_LIMIT, sessionId)

    const events = parseEvents(body.events)
    const now = new Date().toISOString()
    const reportedEventCount =
      typeof body.eventCount === 'number' && Number.isFinite(body.eventCount) && body.eventCount >= events.length
        ? Math.floor(body.eventCount)
        : undefined
    const firstEventCount =
      reportedEventCount === undefined ? undefined : Math.max(1, reportedEventCount - events.length + 1)
    const records = events.flatMap((event, index) =>
      storedRecordsForEvent(
        sessionId,
        now,
        event,
        firstEventCount === undefined ? undefined : firstEventCount + index,
      ),
    )

    let result
    try {
      result = await appendStoredRecords(sessionId, records)
    } catch (error) {
      if (!(error instanceof FencingTokenMismatchError)) throw error
      result = { appended: 0, tailSeqNum: null }
    }

    // appendStoredRecords reports physical S2 records; expose logical rrweb events only after all records land.
    if (result.appended !== 0 && result.appended !== records.length) {
      throw new HttpError(502, 'Partial event append failed.')
    }

    response.json({ ...result, appended: result.appended === 0 ? 0 : events.length })
  }),
)

app.post(
  '/api/sessions/:id/heartbeat',
  asyncRoute(async (request, response) => {
    const sessionId = parseSessionId(paramString(request.params.id))
    const body = parseBody<HeartbeatSessionRequest>(request.body)
    ensureCaptureOrigin(request)
    requireAppendToken(request, sessionId, body)
    checkRateLimit(request, 'session-heartbeat', SESSION_APPEND_RATE_LIMIT, sessionId)

    const eventCount =
      typeof body.eventCount === 'number' && Number.isFinite(body.eventCount) && body.eventCount >= 0
        ? Math.floor(body.eventCount)
        : undefined
    const now = new Date().toISOString()
    let result
    try {
      result = await appendStoredRecordsDirect(
        sessionId,
        [
          {
            kind: 'heartbeat',
            sessionId,
            capturedAt: now,
            lastSeenAt: now,
            eventCount,
          },
        ],
        { fencingToken: ACTIVE_FENCE_TOKEN },
      )
    } catch (error) {
      if (!(error instanceof FencingTokenMismatchError)) throw error
      result = { appended: 0, tailSeqNum: null }
    }

    response.json(result)
  }),
)

app.post(
  '/api/sessions/:id/stop',
  asyncRoute(async (request, response) => {
    const sessionId = parseSessionId(paramString(request.params.id))
    const body = parseBody<StopSessionRequest>(request.body)
    ensureCaptureOrigin(request)
    requireAppendToken(request, sessionId, body)
    checkRateLimit(request, 'session-stop', SESSION_APPEND_RATE_LIMIT, sessionId)

    const existing = await loadSessionSummary(sessionId)

    if (existing.status === 'stopped') {
      response.json({ session: await loadSessionDetail(sessionId) })
      return
    }

    const now = new Date().toISOString()
    const metadata: SessionMetadata = {
      id: sessionId,
      title: normalizeTitle(body.title ?? existing.title),
      status: 'stopped',
      createdAt: existing.createdAt,
      updatedAt: now,
      lastSeenAt: now,
      stoppedAt: now,
      stopReason: 'explicit-stop',
      eventCount: Math.max(existing.eventCount, body.eventCount ?? 0),
      url: existing.url,
      source: existing.source,
      distinctId: existing.distinctId,
      userId: existing.userId,
      sdk: existing.sdk,
    }

    try {
      const result = await appendRecordsToStream(
        sessionStreamName(sessionId),
        [
          fenceAppendRecord(STOPPED_FENCE_TOKEN, new Date(now)),
          ...toAppendRecords([
            {
              kind: 'metadata',
              sessionId,
              capturedAt: now,
              metadata,
            },
          ]),
        ],
        {
          fencingToken: ACTIVE_FENCE_TOKEN,
          useProducer: false,
        },
      )
      void result
    } catch (error) {
      if (!(error instanceof FencingTokenMismatchError)) throw error
    }

    response.json({ session: await loadSessionDetail(sessionId) })
  }),
)

app.get('/recorder.js', (_request, response) => {
  response.type('application/javascript').send(recorderScript())
})

app.get('/vendor/rrweb.min.js', (_request, response) => {
  response.type('application/javascript')
  response.sendFile(path.join(process.cwd(), 'node_modules/rrweb/dist/rrweb.min.js'))
})

app.get('/recorder-test', (_request, response) => {
  if (!RECORDER_TEST_ENABLED) {
    response.status(404).send('Not found')
    return
  }

  response.type('html').send(recorderTestPage())
})

const distPath = path.join(process.cwd(), 'dist')
if (existsSync(distPath)) {
  app.use(express.static(distPath))
  app.get(/.*/, (_request, response) => {
    response.sendFile(path.join(distPath, 'index.html'))
  })
}

const errorHandler: ErrorRequestHandler = (error, _request, response, next) => {
  void next
  const status =
    error instanceof HttpError ? error.status : error instanceof S2Error && error.status > 0 ? error.status : 500
  const message = error instanceof Error ? error.message : 'Unexpected server error.'

  if (status >= 500) {
    console.error(error)
  }

  response.status(status).json({ error: message })
}

app.use(errorHandler)

function assertStartupConfig() {
  if (INGEST_AUTH_ENABLED && !APPEND_TOKEN_SECRET_EXPLICIT) {
    const message =
      'Ingest auth is enabled but REPLAYA_APPEND_TOKEN_SECRET is not set. Set it to a stable, random, secret value (e.g. `openssl rand -hex 32`).'
    if (IS_PRODUCTION) {
      console.error(`[replaya] ${message} Refusing to start.`)
      process.exit(1)
    }
    console.warn(
      `[replaya] ${message} Falling back to an ephemeral per-process secret — append tokens will not survive a restart or work across instances.`,
    )
  }
}

export function startServer() {
  assertStartupConfig()

  const server = app.listen(PORT, () => {
    console.log(`RePlaya API listening on http://localhost:${PORT}`)
  })

  const openSockets = new Set<import('node:net').Socket>()
  server.on('connection', (socket) => {
    openSockets.add(socket)
    socket.on('close', () => openSockets.delete(socket))
  })

  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[replaya] ${signal} received — shutting down (grace ${SHUTDOWN_GRACE_MS}ms).`)

    server.close((error) => {
      if (error) {
        console.error('[replaya] error while closing server', error)
        process.exit(1)
      }
      console.log('[replaya] closed cleanly.')
      process.exit(0)
    })

    // Let in-flight requests drain briefly, then drop lingering sockets
    // (live-tail SSE streams never end on their own) so server.close() can finish.
    setTimeout(() => {
      for (const socket of openSockets) socket.destroy()
    }, Math.min(3_000, SHUTDOWN_GRACE_MS)).unref()

    // Hard cap so a stuck close can't wedge the process.
    setTimeout(() => {
      console.error('[replaya] forced exit after shutdown grace period.')
      process.exit(1)
    }, SHUTDOWN_GRACE_MS).unref()
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  return server
}

export { app }

// Start only when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer()
}
