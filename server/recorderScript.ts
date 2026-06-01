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
      body { margin: 0; font: 15px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f4f6f8; color: #111827; }
      main { max-width: 980px; margin: 0 auto; padding: 32px 20px; }
      header, section { border: 1px solid #d8dee6; border-radius: 8px; background: #fff; padding: 18px; margin-bottom: 14px; }
      h1, h2, p { margin: 0; }
      h1 { font-size: 28px; }
      h2 { font-size: 18px; margin-bottom: 12px; }
      .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
      label { display: grid; gap: 6px; margin-bottom: 12px; color: #475467; font-size: 13px; font-weight: 700; }
      input, textarea, select, button { font: inherit; }
      input, textarea, select { border: 1px solid #d8dee6; border-radius: 8px; padding: 10px; }
      button { min-height: 38px; border: 0; border-radius: 8px; background: #2563eb; color: #fff; font-weight: 700; padding: 0 14px; }
      .replaya-block { border: 1px dashed #bfdbfe; background: #eff6ff; padding: 12px; border-radius: 8px; }
      @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main>
      <header>
        <p>RePlaya recorder fixture</p>
        <h1>Capture validation workspace</h1>
      </header>
      <div class="grid">
        <section>
          <h2>Form Controls</h2>
          <label>Contact <input placeholder="contact email" /></label>
          <label>Segment <select><option>Internal</option><option>Partner</option><option>Customer</option></select></label>
          <label>Notes <textarea rows="4" placeholder="session notes"></textarea></label>
          <button onclick="document.querySelector('#result').textContent = 'Saved at ' + new Date().toLocaleTimeString()">Save</button>
          <p id="result"></p>
        </section>
        <section>
          <h2>Interaction Events</h2>
          <button onclick="document.body.style.background = document.body.style.background === 'rgb(244, 246, 248)' ? '#eef6ff' : '#f4f6f8'">Toggle state</button>
          <button onclick="document.querySelector('#counter').textContent = Number(document.querySelector('#counter').textContent) + 1">Increment</button>
          <p>Counter: <strong id="counter">0</strong></p>
          <div class="replaya-block">Blocked capture region</div>
        </section>
      </div>
    </main>
    <script>
      !function(w,d,s,u){w.replaya=w.replaya||function(){(w.replaya.q=w.replaya.q||[]).push(arguments)};var e=d.createElement(s);e.async=1;e.src=u;d.head.appendChild(e)}(window,document,"script","/recorder.js");
      replaya("init", { apiHost: window.location.origin, source: "local-fixture", title: "Recorder fixture" });
    </script>
  </body>
</html>`
}
