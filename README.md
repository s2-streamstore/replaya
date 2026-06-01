# RePlaya

RePlaya is an OSS session capture and replay tool you host yourself. The only external storage/service dependency is [S2](https://s2.dev/), which can be S2 Cloud or a compatible self-hosted s2-lite deployment when you point the endpoints at it.

The architecture is intentionally small:

1. A page loads RePlaya's drop-in browser recorder from your deployment.
2. The browser posts rrweb event batches to your self-hosted RePlaya API.
3. The API writes and reads ordered session streams in S2.
4. The internal dashboard replays those streams with rrweb-player.

The browser never receives the S2 token. All S2 reads and writes are proxied through your RePlaya server.

## Run

```bash
npm install
npm run dev
```

The API runs on `http://localhost:8787` and Vite serves the app on `http://localhost:5173`.

For a production-style local run:

```bash
npm run build
npm start
```

Then open `http://localhost:8787`.

## Drop-in Recorder

```html
<script>
  !function(w,d,s,u){w.replaya=w.replaya||function(){(w.replaya.q=w.replaya.q||[]).push(arguments)};var e=d.createElement(s);e.async=1;e.src=u;d.head.appendChild(e)}(window,document,"script","http://localhost:8787/recorder.js");
  replaya("init", {
    apiHost: "http://localhost:8787",
    source: "web-app"
  });
</script>
```

Use `http://localhost:8787/recorder-test` for a local page that records through the same script.

`source` is optional metadata for grouping captures by app, site, environment, or tenant. `distinctId` and `userId` can be passed when the recorder should tag sessions with application identity.

By default, the recorder **masks all input, select, and textarea values** (rrweb `maskAllInputs`), so end-user keystrokes — passwords, emails, anything typed — are not sent to the server. To capture raw form control state on a page where that is acceptable (e.g. an internal admin UI), pass `maskAllInputs: false` to `replaya("init", ...)`, or add `data-mask-all-inputs="false"` to the recorder script tag.

Masking covers input values only; text the page renders into the DOM is still recorded. Wrap sensitive regions in the `replaya-block` class to omit them from the recording, or `replaya-ignore` to skip a subtree's changes.

## S2 Stream Policy

RePlaya uses basin defaults as the source of truth for new streams. Basin-level `createStreamOnAppend` is enabled, so the first append creates a session stream with the default stream config. `createStreamOnRead` remains disabled.

Session streams use:

- `timestamping.mode: client-require`
- `createStreamOnAppend: true`
- `createStreamOnRead: false`
- `deleteOnEmpty.minAgeSecs: 86400`
- `retentionPolicy.ageSecs: 2419200`

Every appended record is timestamped because `client-require` demands it. Event records use the rrweb capture timestamp. Create, stop, and heartbeat records use server wall-clock timestamps so S2 tail reads report durable liveness.

Replay events use S2 record timestamps as the scrub timeline. RePlaya writes the rrweb capture time into the S2 timestamp field, reads the S2 timestamp back, and passes that timestamp to rrweb-player.

Writes use the S2 Producer API, which batches event records over an append session and applies backpressure. RePlaya stores each replay in reverse-time stream names such as `sessions/8235/832/123/456/session-mpsphcyj-ffccffdbc1`. Because S2 stream listing is lexicographic ascending, the inverted timestamp path makes `streams.list({ prefix: "sessions/" })` return newest sessions first without a separate index stream.

Dashboard listing does not read full replay streams. It lists reverse-time stream names with cursor paging (`limit` plus `startAfter`), then parallel-reads the create metadata and a one-record tail window with `tailOffset: 1`. The tail read returns `batch.tail`, which RePlaya uses for the raw next sequence number and last timestamp; the last user record supplies display metadata and explicit stop detection.

New session discovery also writes a best-effort index record to the sidecar index stream, `sessions.index/sessions` by default, after the session stream is created. Each index record body is only the session stream name. The stream list remains authoritative; when the dashboard is viewing the newest page, it tails this index stream from the pre-list tail sequence number and resolves each new name back through the normal session summary path so the list updates in real time.

Session streams use S2 fencing to make stop terminal. Fence changes are command records appended to the stream, so they consume sequence numbers and affect raw tail positions. RePlaya creates the stream with an `active` fence command followed by active metadata, requires that fence for event and heartbeat appends, and stops with a single append containing a `stopped` fence command followed by stopped metadata as the final user-visible record. Reads set `ignoreCommandRecords` so replay and listing see metadata/events/heartbeats while raw tail positions still include fence records.

Active selected sessions are live-tailed with S2 read sessions. The dashboard opens `/api/sessions/:id/live` from the snapshot tail sequence number, the server bridges S2's streaming read to browser SSE, and new records are appended to the mounted rrweb player without a manual reload.

## Configuration

Server-only S2 configuration lives in `.env.local`.

```bash
S2_ACCESS_TOKEN=replace-with-an-s2-access-token
S2_BASIN=replaya-your-name
S2_STREAM_PREFIX=sessions/
PORT=8787
```

For a practical production deployment, put dashboard/read access behind your platform access layer and run RePlaya with scoped ingest enabled:

```bash
NODE_ENV=production
REPLAYA_PROJECT_KEY=pk_live_replace_with_public_write_key
REPLAYA_APPEND_TOKEN_SECRET=replace-with-a-long-random-secret
REPLAYA_ALLOWED_CAPTURE_ORIGINS=https://app.example.com,https://www.example.com
REPLAYA_TRUST_PROXY=true
```

Then pass the public project key in the recorder init:

```js
replaya("init", {
  apiHost: "https://collect.example.com",
  projectKey: "pk_live_replace_with_public_write_key",
  source: "web-app"
});
```

In production, RePlaya treats the collector as public write-only surface area and the dashboard/read APIs as private deployment surface area. The app does not implement dashboard auth for now; deploy the dashboard, session listing, replay reads, live tailing, and health endpoint behind your platform boundary, such as VPN, Tailscale, Cloudflare Access, oauth2-proxy, or a private network. Recorder ingest requires an allowed origin plus `REPLAYA_PROJECT_KEY`; session create returns a short-lived append token that the recorder sends with event, heartbeat, and stop writes. `REPLAYA_ENABLE_RECORDER_TEST` defaults off in production.

When ingest auth is enabled, `REPLAYA_APPEND_TOKEN_SECRET` is **required**: the server refuses to start in production without it (it no longer falls back to the S2 access token), so set it to a stable random value such as `openssl rand -hex 32`.

### Self-hosted deployment (single team)

The read side has no built-in authentication by design, so the deployment boundary *is* the access control. Concretely:

1. **Don't expose the read APIs to the internet.** Bind the app to a private interface/network and put the dashboard, `GET /api/sessions*`, live tailing, and `/api/health` behind your SSO/access layer (VPN, Tailscale, Cloudflare Access, oauth2-proxy).
2. **Expose only the collector publicly** — `GET /recorder.js`, `GET /vendor/*`, and the write endpoints (`POST /api/sessions`, `/events`, `/heartbeat`, `/stop`) — and lock those down with `REPLAYA_ALLOWED_CAPTURE_ORIGINS` + `REPLAYA_PROJECT_KEY`.
3. **Set `NODE_ENV=production`** so ingest auth is enforced, originless ingest is rejected, and the recorder test fixture is disabled.
4. **Set `REPLAYA_APPEND_TOKEN_SECRET`** to a stable secret (see above), and `REPLAYA_TRUST_PROXY=true` if you run behind a reverse proxy so per-client rate limits use the real client IP.

Useful security limits:

- `REPLAYA_SESSION_CREATE_RATE_LIMIT` default `60` per minute per client/project.
- `REPLAYA_SESSION_APPEND_RATE_LIMIT` default `600` per minute per client/session.
- `REPLAYA_MAX_EVENTS_PER_BATCH` default `100`.
- `REPLAYA_JSON_BODY_LIMIT` default `8mb`.
- `REPLAYA_APPEND_TOKEN_TTL_MS` default `86400000`.

Operational knobs:

- `REPLAYA_LOG_REQUESTS` — access log for every request. Defaults on in development, off in production (where high-volume ingest would flood logs); failed requests (4xx/5xx) are always logged.
- `REPLAYA_SHUTDOWN_GRACE_MS` default `10000`. On `SIGTERM`/`SIGINT` the server stops accepting connections and drains in-flight requests; lingering live-tail streams are dropped after ~3s so it can exit cleanly, with a hard exit at the grace deadline.

### Docker

```bash
docker build -t replaya .
docker run --rm -p 8787:8787 \
  -e NODE_ENV=production \
  -e S2_ACCESS_TOKEN=... -e S2_BASIN=... \
  -e REPLAYA_PROJECT_KEY=pk_live_... \
  -e REPLAYA_APPEND_TOKEN_SECRET="$(openssl rand -hex 32)" \
  -e REPLAYA_ALLOWED_CAPTURE_ORIGINS=https://app.example.com \
  replaya
```

The image runs the single compiled server (`node dist-server/server/index.js`) as a non-root user and includes a `HEALTHCHECK` against `/api/health`. Remember the access-boundary checklist above: only the collector and recorder routes should be publicly reachable.

> Pass secrets with `-e VAR=value` (or a secrets manager), not by reusing a local `.env`. `docker --env-file` does not strip surrounding quotes the way `dotenv` does, so a quoted value like `S2_ACCESS_TOKEN="..."` would be sent to the container with the quotes included.

By default, the SDK uses S2 Cloud. To target s2-lite or another compatible deployment, set the account and basin endpoints explicitly:

```bash
S2_ACCOUNT_ENDPOINT=http://localhost:7070
S2_BASIN_ENDPOINT=http://localhost:7070
```

The dashboard health endpoint reports the effective account and basin endpoints so you can confirm which S2 backend RePlaya is using.

## Scripts

- `npm run dev` starts the API and Vite.
- `npm run build` type-checks the client/server and builds the frontend.
- `npm run lint` runs ESLint.
- `npm test` runs the unit/smoke suite (recorder invariants + HTTP smoke). No S2 required.
- `npm run test:integration` runs the S2 round-trip tests against a real S2 API.
- `npm start` serves the built frontend and API from Express.

## Testing

`npm test` covers recorder invariants and an HTTP smoke of the server (recorder delivery, security headers, ingest-auth rejection) without needing S2.

The integration tests exercise the real create → append → replay → delete path against [`s2 lite`](https://github.com/s2-streamstore/s2), the in-memory S2 emulator. They are skipped unless `S2_TEST_ENDPOINT` is set:

```bash
docker run -d -p 8080:80 ghcr.io/s2-streamstore/s2 lite
S2_TEST_ENDPOINT=http://localhost:8080 npm run test:integration
```

CI runs both: a build/lint/unit-test job (Node 20 + 24) and an integration job that boots `s2 lite` and runs the round-trip suite.
