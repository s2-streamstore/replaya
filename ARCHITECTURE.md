# RePlaya Architecture

RePlaya's backend is a single primitive: a durable, ordered S2 stream. There is no message bus, relational database, analytics store, cache, object store, or search index. Everything below follows from one idea — **a session recording is a log** — and from S2 exposing logs as a first-class, URI-addressable service.

The same architecture works against [S2 Cloud](https://s2.dev/) or [s2-lite](https://github.com/s2-streamstore/s2#s2-lite), the self-hostable server implementation in the `s2-streamstore/s2` repo. RePlaya only depends on S2-compatible account and basin endpoints, so the stream model below is the same in both deployments.

This document is the deep version of [the README's "How it works on S2"](README.md#how-it-works-on-s2).

## Data model: one stream per session

RePlaya uses **basin defaults as the source of truth** for new streams. Basin-level `createStreamOnAppend` is enabled, so the first append creates a session stream — inheriting the basin's `defaultStreamConfig` — without any explicit `streams.create` call; `createStreamOnRead` is disabled.

So the stream settings live in the **basin's `defaultStreamConfig`**, not in a per-stream override. RePlaya never creates a stream explicitly, so there's no creation call to attach a per-stream config to; the defaults are how every session stream gets its config for free. That `defaultStreamConfig` sets:

- `timestamping.mode: client-require`
- `deleteOnEmpty.minAgeSecs: 86400` (24h)
- `retentionPolicy.ageSecs: 2419200` (28d)

(One consequence of using basin defaults: the sidecar [index stream](#the-sidecar-index-stream--live-list-updates) inherits the same config. If you ever wanted, say, different retention for the index, *that* would be the reason to create it explicitly with its own per-stream config — but for a single dedicated basin, uniform defaults are sufficient.)

Each replay is stored under a reverse-time stream name such as `sessions/8219/832/978/212/session-mpsphcyj-ffccffdbc1`. The path segments encode an *inverted* creation timestamp (see [Newest-first listing](#newest-first-listing-without-a-database)). Streams that go empty are reaped after 24h; recordings are retained for 28d. Both are S2 stream policies, not cron jobs RePlaya runs.

## Timestamping & the replay timeline

Because the stream config is `client-require`, **every appended record is timestamped by the client**. RePlaya uses that field as semantic data, not just metadata:

- **Event records** carry the rrweb capture timestamp.
- **Create, stop, and heartbeat records** carry server wall-clock time, so liveness (last-seen) is recorded durably in the stream rather than tracked only in memory.

Replay events use the S2 record timestamp as the scrub timeline. RePlaya writes the rrweb capture time into the S2 timestamp field on append, reads that same S2 timestamp back on read, and passes it to rrweb-player. The ordering and timing the player needs are properties of the stream itself — there is no separate "events table" with its own clock to reconcile.

## Writes: the Producer API & backpressure

Writes use the **S2 Producer API**, which batches event records over an append session and applies backpressure. An append is acknowledged only once it is durable, and a record is readable as soon as its batch is acked — there is no server-side buffer-and-flush window between ingestion and storage.

The browser recorder batches client-side before posting (it flushes roughly every 250ms or every 20 events, with exponential backoff on failure and a bounded in-memory buffer during outages), so end-to-end there is a small, sub-second client batching delay — but nothing buffers on the server between the API and S2.

The browser **never receives the S2 token**. The recorder talks only to RePlaya's own HTTP API; all S2 reads and writes are proxied through the server.

## Newest-first listing without a database

S2 lists streams in **lexicographic ascending** order. RePlaya exploits this to get a newest-first index for free: stream names embed `REVERSE_TIME_MAX_MS - createdAtMs`, zero-padded and split into path segments. Because a newer session has a smaller inverted key, `streams.list({ prefix: "sessions/" })` returns the newest sessions first — no separate ordering index or database needed to keep that in sync. (The [sidecar index stream](#the-sidecar-index-stream--live-list-updates) below is for *live discovery* of new sessions, not for ordering — the namespace already handles order.)

Dashboard listing does **not** read full replay streams. It:

1. Lists reverse-time stream names with cursor paging (`limit` plus `startAfter`).
2. Parallel-reads, per session, the create metadata and a one-record tail window with `tailOffset: 1`.

The tail read returns `batch.tail`, which RePlaya uses for the raw next sequence number and last timestamp; the last user record supplies display metadata and explicit stop detection. This keeps listing cheap regardless of how long individual recordings are.

## The sidecar index stream & live list updates

New-session discovery also writes a best-effort record to a sidecar **index stream**, `sessions.index/sessions` by default, after the session stream is created. Each index record body is just the session stream name.

The stream list remains authoritative. But when the dashboard is viewing the newest page, it tails this index stream from the pre-list tail sequence number and resolves each new name back through the normal session-summary path. That's what makes new sessions appear in the list **in real time** as they start, without polling.

## Fencing tokens: making stop terminal

Session streams use **S2 fencing** to make "stopped" terminal. Fence changes are command records appended to the stream, so they consume sequence numbers and affect raw tail positions. RePlaya:

- Creates the stream with an `active` fence command, followed by active metadata.
- Requires that fence for event and heartbeat appends.
- Stops with a single append containing a `stopped` fence command, followed by stopped metadata as the final user-visible record.

Once a session is stopped, a late or duplicate writer fenced on `active` is rejected — concurrency control comes from the stream's own fencing rather than a separate lock service. Reads set `ignoreCommandRecords` so replay and listing see metadata/events/heartbeats, while raw tail positions still account for fence records.

## Live tail: S2 read sessions bridged to SSE

Active selected sessions are live-tailed with **S2 read sessions**:

1. The dashboard opens `GET /api/sessions/:id/live` from the snapshot tail sequence number.
2. The server starts an S2 read session at that position and **bridges S2's streaming read to browser Server-Sent Events**.
3. New records — events, heartbeats, metadata, and a terminal status — are pushed to the browser and appended to the mounted rrweb player without a manual reload.

The same stream serves both the historical scrub and the live edge, so "review what already happened" and "watch what's happening now" are the same read, just from different offsets.

Liveness is governed by a **lease**: the server schedules an expiration from the last-seen timestamp (refreshed by events and heartbeats). If the lease lapses, the live endpoint emits a terminal `stopped` status with reason `lease-expired`; an explicit stop emits `explicit-stop`. SSE comment heartbeats keep the connection warm, and on shutdown lingering live-tail streams are dropped after a short grace period.

## Security & request boundary

RePlaya has **no built-in dashboard/read authentication by design** — the deployment boundary is the access control. The model splits the surface area in two:

- **Public, write-only collector:** `GET /recorder.js`, `GET /vendor/rrweb.min.js`, and the write endpoints (`POST /api/sessions`, `/events`, `/heartbeat`, `/stop`). Locked down with `REPLAYA_ALLOWED_CAPTURE_ORIGINS` (an allow-list of origins) plus `REPLAYA_PROJECT_KEY`.
- **Private, read surface:** the dashboard, `GET /api/sessions*`, live tailing, and `/api/health` — deployed behind your own SSO/access layer (VPN, Tailscale, Cloudflare Access, oauth2-proxy, or a private network).

When ingest auth is enabled, session create issues a **short-lived append token** (an HMAC over the session id and expiry, signed with `REPLAYA_APPEND_TOKEN_SECRET`). The recorder sends that token with subsequent event, heartbeat, and stop writes; the server refuses to start in production without a stable secret, so tokens survive restarts and work across instances.

Other defenses: per-client/per-session rate limits on create and append, a JSON body limit, a max events-per-batch, `nosniff` / `no-referrer` / `Permissions-Policy` headers (plus HSTS over TLS in production), and rejection of originless ingest in production. With `NODE_ENV=production`, ingest auth is enforced and the recorder test fixture is disabled.

See [Configuration & deployment](README.md#configuration--deployment) in the README for the operational knobs.
