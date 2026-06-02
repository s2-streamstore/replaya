export function recorderScript() {
  return String.raw`
(function () {
  if (window.__replayaRecorderLoaded) return;
  window.__replayaRecorderLoaded = true;

  var script = document.currentScript;
  var scriptOrigin = script && script.src ? new URL(script.src).origin : window.location.origin;
  var previous = window.replaya;
  var queue = previous && Array.isArray(previous.q) ? previous.q.slice() : [];
  var config = {
    apiHost: scriptOrigin,
    title: document.title || window.location.hostname,
    source: script && script.dataset.source || window.location.hostname,
    distinctId: script && script.dataset.distinctId || "",
    userId: script && script.dataset.userId || "",
    projectKey: script && script.dataset.projectKey || "",
    autostart: !(script && script.dataset.autostart === "false"),
    maskAllInputs: !(script && script.dataset.maskAllInputs === "false"),
    blockClass: "replaya-block",
    ignoreClass: "replaya-ignore",
    flushEveryMs: 250,
    heartbeatEveryMs: 10000,
    flushAt: 20,
    flushBackoffMs: 1000,
    flushBackoffMaxMs: 30000,
    maxBufferEvents: 1000,
    beaconMaxBytes: 60000
  };

  var sessionId = null;
  var stopRecording = null;
  var buffer = [];
  var flushTimer = null;
  var heartbeatTimer = null;
  var sentEventCount = 0;
  var sessionToken = "";
  var flushing = false;
  var flushFailures = 0;
  var starting = null;
  var stopped = false;

  function merge(next) {
    if (!next) return;
    Object.keys(next).forEach(function (key) {
      if (next[key] !== undefined) config[key] = next[key];
    });
  }

  function apiUrl(path) {
    return config.apiHost.replace(/\/$/, "") + path;
  }

  function postJson(path, body, keepalive) {
    var payload = JSON.stringify(body);
    if (keepalive && navigator.sendBeacon) {
      var blob = new Blob([payload], { type: "application/json" });
      // sendBeacon silently drops payloads past ~64KB. Only use it when the
      // payload is comfortably small, and fall through to keepalive fetch if
      // the browser's beacon queue still rejects it.
      if (blob.size <= config.beaconMaxBytes && navigator.sendBeacon(apiUrl(path), blob)) {
        return true;
      }
    }

    return fetch(apiUrl(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      keepalive: Boolean(keepalive)
    }).then(function (response) {
      if (!response.ok) throw new Error("RePlaya request failed: " + response.status);
      return response.json();
    });
  }

  function loadRrweb() {
    if (window.rrweb && window.rrweb.record) return Promise.resolve();

    return new Promise(function (resolve, reject) {
      var rrwebScript = document.createElement("script");
      rrwebScript.async = true;
      rrwebScript.src = apiUrl("/vendor/rrweb.min.js");
      rrwebScript.onload = function () { resolve(); };
      rrwebScript.onerror = function () { reject(new Error("Unable to load rrweb")); };
      document.head.appendChild(rrwebScript);
    });
  }

  function createSession() {
    return postJson("/api/sessions", {
      title: config.title || document.title || window.location.hostname,
      url: window.location.href,
      source: config.source,
      distinctId: config.distinctId || undefined,
      userId: config.userId || undefined,
      projectKey: config.projectKey || undefined,
      sdk: "replaya-js"
    }).then(function (result) {
      sessionId = result.session.id;
      sessionToken = result.appendToken || "";
      window.replaya.sessionId = sessionId;
      return sessionId;
    });
  }

  function withSessionToken(body) {
    if (sessionToken) body.sessionToken = sessionToken;
    return body;
  }

  function scheduleFlush() {
    if (buffer.length >= config.flushAt) {
      flush();
      return;
    }

    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, config.flushEveryMs);
  }

  function sendHeartbeat() {
    if (!sessionId || stopped || flushing || buffer.length > 0) return Promise.resolve();

    return Promise.resolve(postJson("/api/sessions/" + sessionId + "/heartbeat", withSessionToken({
      title: config.title,
      eventCount: sentEventCount
    }))).catch(function () {});
  }

  function startHeartbeat() {
    clearInterval(heartbeatTimer);
    if (!config.heartbeatEveryMs) return;
    heartbeatTimer = setInterval(sendHeartbeat, config.heartbeatEveryMs);
  }

  function requeue(batch) {
    buffer = batch.concat(buffer);
    if (buffer.length > config.maxBufferEvents) {
      // Bound memory during a prolonged outage; keep the most recent events.
      buffer = buffer.slice(buffer.length - config.maxBufferEvents);
    }
  }

  function scheduleRetry() {
    clearTimeout(flushTimer);
    var delay = Math.min(config.flushBackoffMs * Math.pow(2, flushFailures), config.flushBackoffMaxMs);
    flushFailures++;
    flushTimer = setTimeout(flush, delay);
  }

  function flush(keepalive) {
    if (!sessionId || flushing || buffer.length === 0) return Promise.resolve();

    flushing = true;
    var batch = buffer.splice(0, Math.min(buffer.length, 100));
    var nextEventCount = sentEventCount + batch.length;

    return Promise.resolve(postJson("/api/sessions/" + sessionId + "/events", withSessionToken({
      events: batch,
      eventCount: nextEventCount
    }), keepalive))
      .then(function () {
        sentEventCount = Math.max(sentEventCount, nextEventCount);
        flushFailures = 0;
      })
      .catch(function () {
        // Page-unload (keepalive) flushes can't retry; drop rather than block unload.
        if (!keepalive) {
          requeue(batch);
          scheduleRetry();
        }
      })
      .then(function () {
        flushing = false;
        if (buffer.length > 0 && !keepalive && flushFailures === 0) scheduleFlush();
      });
  }

  function start(options) {
    merge(options);
    if (starting) return starting;
    if (stopRecording) return Promise.resolve(sessionId);
    stopped = false;

    starting = loadRrweb()
      .then(createSession)
      .then(function () {
        stopRecording = window.rrweb.record({
          emit: function (event) {
            if (stopped) return;
            buffer.push(event);
            scheduleFlush();
          },
          maskAllInputs: config.maskAllInputs,
          blockClass: config.blockClass,
          ignoreClass: config.ignoreClass,
          recordCanvas: Boolean(config.recordCanvas),
          sampling: {
            mousemove: 50,
            scroll: 150,
            media: 800
          }
        });
        startHeartbeat();
        return sessionId;
      })
      .catch(function (error) {
        // Recording must never break the host page: swallow start failures.
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[replaya] recorder failed to start", error);
        }
        return null;
      })
      .finally(function () {
        starting = null;
      });

    return starting;
  }

  function stop() {
    stopped = true;
    if (stopRecording) {
      stopRecording();
      stopRecording = null;
    }
    clearTimeout(flushTimer);
    clearInterval(heartbeatTimer);
    var currentSession = sessionId;
    return flush().then(function () {
      if (currentSession) {
        return postJson("/api/sessions/" + currentSession + "/stop", withSessionToken({
          title: config.title,
          eventCount: sentEventCount
        }));
      }
    }).catch(function () {});
  }

  function command(name, options) {
    if (name === "init") {
      merge(options);
      return config.autostart === false ? Promise.resolve() : start();
    }
    if (name === "start") return start(options);
    if (name === "stop") return stop();
    if (name === "identify") {
      merge({ distinctId: options && options.distinctId, userId: options && options.userId });
      return Promise.resolve();
    }
    if (name === "flush") return flush();
    return Promise.resolve();
  }

  window.replaya = function (name, options) {
    return command(name, options);
  };
  window.replaya.q = [];
  window.replaya.version = "0.1.0";
  window.replaya.config = config;

  queue.forEach(function (args) {
    command(args[0], args[1]);
  });

  if (config.autostart && queue.length === 0) start();

  window.addEventListener("pagehide", function () {
    if (!sessionId) return;
    clearTimeout(flushTimer);
    clearInterval(heartbeatTimer);
    var finalEventCount = sentEventCount + buffer.length;
    flush(true);
    postJson("/api/sessions/" + sessionId + "/stop", withSessionToken({ title: config.title, eventCount: finalEventCount }), true);
  });
})();`
}

export function recorderTestPage() {
  return String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>RePlaya recorder fixture</title>
    <style>
      :root {
        --bg: #f5f7f9; --surface: #ffffff; --surface-2: #f2f4f7; --border: #e6e8ee;
        --text: #1a1d23; --muted: #6b7280; --accent: #0f766e; --accent-hover: #115e59;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0; min-height: 100vh;
        font: 15px/1.55 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        letter-spacing: -0.006em; background: var(--bg); color: var(--text);
        -webkit-font-smoothing: antialiased;
      }
      main { max-width: 1000px; margin: 0 auto; padding: 36px 20px 60px; }
      h1, h2, p { margin: 0; }
      .topbar { display: flex; align-items: center; gap: 13px; margin-bottom: 26px; }
      .logo {
        width: 36px; height: 36px; flex: none; border-radius: 9px;
        background: linear-gradient(180deg, #75d7e5 0 42%, #0f766e 43% 67%, #f2c76f 68% 100%);
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.22), 0 1px 2px rgba(15, 118, 110, 0.18);
      }
      .brand h1 { font-size: 19px; letter-spacing: -0.02em; }
      .brand p { color: var(--muted); font-size: 13px; }
      .pill {
        margin-left: auto; display: inline-flex; align-items: center; gap: 7px;
        padding: 7px 13px; border-radius: 999px; border: 1px solid var(--border);
        background: var(--surface); color: var(--muted); font-size: 12.5px; font-weight: 600;
      }
      .pill .dot { width: 8px; height: 8px; border-radius: 999px; background: #16a34a; animation: pulse 1.4s ease-in-out infinite; }
      .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
      .card {
        border: 1px solid var(--border); border-radius: 12px; background: var(--surface);
        padding: 22px; box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
      }
      .card h2 { font-size: 15px; letter-spacing: -0.01em; }
      .card .hint { margin: 4px 0 18px; color: var(--muted); font-size: 13px; }
      label { display: grid; gap: 6px; margin-bottom: 14px; color: var(--muted); font-size: 12.5px; font-weight: 600; }
      input, textarea, select {
        font: inherit; width: 100%; padding: 10px 12px; border: 1px solid var(--border);
        border-radius: 8px; background: var(--surface); color: var(--text);
      }
      input:focus, textarea:focus, select:focus {
        outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.16);
      }
      .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
      button { font: inherit; font-weight: 600; min-height: 38px; padding: 0 16px; border-radius: 8px; border: 1px solid transparent; cursor: pointer; }
      .btn-primary { background: var(--accent); color: #fff; }
      .btn-primary:hover { background: var(--accent-hover); }
      .btn-ghost { background: var(--surface); border-color: var(--border); color: var(--text); }
      .btn-ghost:hover { background: var(--surface-2); }
      .stat { display: flex; align-items: baseline; gap: 9px; margin: 4px 0 16px; }
      .stat b { font-size: 30px; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
      .stat span { color: var(--muted); font-size: 13px; }
      .meter { height: 8px; margin-top: 16px; border-radius: 999px; background: var(--surface-2); overflow: hidden; }
      .meter > i { display: block; height: 100%; width: 0; background: var(--accent); border-radius: 999px; transition: width 0.25s ease; }
      .toast { margin-top: 14px; min-height: 18px; color: var(--accent); font-size: 13px; font-weight: 600; }
      .replaya-block { margin-top: 18px; border: 1px dashed #c7d2e0; background: #eef5ff; border-radius: 8px; padding: 14px; color: #475467; font-size: 13px; }
      footer { margin-top: 26px; color: var(--muted); font-size: 12.5px; text-align: center; }
      code { font-family: ui-monospace, "SF Mono", Menlo, monospace; background: var(--surface-2); padding: 2px 6px; border-radius: 5px; font-size: 12px; }
      body.inverted { background: #0e1116; }
      body.inverted .card { background: #161a22; border-color: #262c38; }
      body.inverted .card h2, body.inverted .brand h1 { color: #f3f4f6; }
      body.inverted .card .hint, body.inverted .brand p, body.inverted label { color: #9aa3b2; }
      body.inverted input, body.inverted textarea, body.inverted select { background: #1d222c; border-color: #2c333f; color: #e6e8ec; }
      @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
      @media (prefers-reduced-motion: reduce) { .pill .dot { animation: none; } }
      @keyframes pulse { 0%, 100% { opacity: 0.5; transform: scale(0.85); } 50% { opacity: 1; transform: scale(1.1); } }
    </style>
  </head>
  <body>
    <main>
      <div class="topbar">
        <span class="logo" aria-hidden="true"></span>
        <div class="brand">
          <h1>RePlaya recorder fixture</h1>
          <p>Capture validation workspace — type, click, and watch it replay.</p>
        </div>
        <span class="pill"><span class="dot"></span>Recording</span>
      </div>
      <div class="grid">
        <section class="card">
          <h2>Account settings</h2>
          <p class="hint">Inputs are masked by default — your keystrokes never leave the page.</p>
          <label>Full name <input placeholder="Ada Lovelace" /></label>
          <label>Work email <input type="email" placeholder="ada@example.com" /></label>
          <label>Plan <select><option>Starter</option><option>Team</option><option>Enterprise</option></select></label>
          <label>Notes <textarea rows="3" placeholder="What are you testing today?"></textarea></label>
          <div class="row">
            <button class="btn-primary" onclick="document.getElementById('save-toast').textContent = 'Saved ' + new Date().toLocaleTimeString()">Save changes</button>
            <button class="btn-ghost" onclick="document.getElementById('save-toast').textContent = 'Changes reverted'">Cancel</button>
          </div>
          <p class="toast" id="save-toast"></p>
        </section>
        <section class="card">
          <h2>Interaction lab</h2>
          <p class="hint">Clicks and DOM mutations for the recorder to capture.</p>
          <div class="stat"><b id="counter">0</b><span>interactions logged</span></div>
          <div class="row">
            <button class="btn-primary" onclick="(function(){var c=document.getElementById('counter');var n=Number(c.textContent)+1;c.textContent=n;document.getElementById('meter-fill').style.width=Math.min(100,n*10)+'%';})()">Log interaction</button>
            <button class="btn-ghost" onclick="document.getElementById('counter').textContent='0';document.getElementById('meter-fill').style.width='0%'">Reset</button>
            <button class="btn-ghost" onclick="document.body.classList.toggle('inverted')">Toggle theme</button>
          </div>
          <div class="meter"><i id="meter-fill"></i></div>
          <div class="replaya-block">
            <strong>Blocked region (<code>replaya-block</code>)</strong><br />
            Anything inside this box is omitted from the recording.
          </div>
        </section>
      </div>
      <footer>RePlaya recorder fixture · source <code>local-fixture</code></footer>
    </main>
    <script>
      !function(w,d,s,u){w.replaya=w.replaya||function(){(w.replaya.q=w.replaya.q||[]).push(arguments)};var e=d.createElement(s);e.async=1;e.src=u;d.head.appendChild(e)}(window,document,"script","/recorder.js");
      replaya("init", { apiHost: window.location.origin, source: "local-fixture", title: "Recorder fixture" });
    </script>
  </body>
</html>`
}
