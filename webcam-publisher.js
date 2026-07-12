// webcam-publisher.js — Webcam Publisher
// A dependency-free custom element that publishes this browser's camera and microphone to a WebRTC
// server over WHIP. Works in any web page and, as a bonus, as a Home Assistant Lovelace card. The
// recommended receiver is Frigate, fed through go2rtc (the WHIP ingest); any WHIP server works.
//
// Use in any HTML page:
//   <script type="module" src="webcam-publisher.js"></script>
//   <webcam-publisher go2rtc="https://go2rtc-server:1984" stream="webcam" enabled></webcam-publisher>
//   Attributes seed the FIRST run only; after that, settings live per browser in localStorage and are
//   edited in the element's gear panel. (Attributes: server-type, go2rtc, stream, whip-url,
//   bearer-token, ice, enabled.)
//
// Use in Home Assistant (Lovelace):
//   type: custom:webcam-publisher
//   # optional first-run defaults: serverType, stream, go2rtc, whipUrl, bearerToken, ice, enabled
//
// Architecture: a window-scoped Core singleton owns all publishing state, independent of the DOM; the
// element is a thin controller/preview UI over it. The Core survives the element being moved or
// re-inserted; elements attach to and detach from it.
//
// Guarantees:
// - The camera and microphone are not touched until publishing is enabled, and are fully released
//   whenever publishing stops.
// - One active publish per page: starting a stream stops any other.
// - Settings live per browser in localStorage (a single key). Every instance follows it, and a headless
//   autostart resumes publishing after a reload.
// - Reconnection is single-flight and serialized: exponential backoff, a watchdog that verifies outbound
//   bytes keep flowing, and grace periods for transient drops. It retries forever.
// - Standard WHIP: POST an SDP offer (application/sdp), read the answer and Location, DELETE to end.
//   Server type "go2rtc" builds go2rtc's publish endpoint (base + /api/webrtc?dst=stream); server type
//   "whip" uses an explicit endpoint URL plus an optional Bearer token — any WHIP server.
// - "Load template" prompts for a URL (prefilled with the default) and applies only shared connection
//   fields, never per-browser device choices.
//
// Cooperating with the camera
//   This element is an always-on holder: while enabled it continuously publishes the camera and
//   microphone. A temporary acquirer — a call, intercom, doorbell talk-back, push-to-talk — borrows
//   the camera for a while and hands it back, using two window events. This element releases the device
//   while any claim is outstanding and resumes when the last claim is released:
//
//     // before getUserMedia — ask current holders to release the camera:
//     const claim = new CustomEvent("camera:claim", { detail: { id: "my-card", willRelease: false } });
//     window.dispatchEvent(claim);
//     if (claim.detail.willRelease) { /* a holder is releasing; wait for the device to free (~0.8s) */ }
//
//     // when finished with the camera — let holders resume:
//     window.dispatchEvent(new CustomEvent("camera:release", { detail: { id: "my-card" } }));
//
//   Use the same `id` for a claim and its matching release. Claims are reference-counted, so several
//   callers can hold the camera at once; this element resumes only after every claim has been released.

(() => {
  // Define once, even if the script is loaded twice.
  if (window.WebcamPublisherCore) return;

  const VERSION = "1.0.0";
  const TAG = "webcam-publisher";
  const SETTINGS_KEY = "webcam-publisher:settings";

  // Timeouts (ms)
  const TIMEOUT_MEDIA          = 12000; // getUserMedia can hang if the camera is held elsewhere
  const TIMEOUT_ICE_GATHER     = 4000;  // proceed with the candidates gathered so far
  const TIMEOUT_WHIP_POST      = 10000; // a hung POST must not stall reconnection
  const TIMEOUT_WHIP_DELETE    = 5000;
  const TIMEOUT_TEMPLATE_FETCH = 8000;

  // Reconnection behavior (ms)
  const WATCHDOG_INTERVAL   = 15000; // liveness check cadence
  const MEDIA_STALL_LIMIT   = 30000; // outbound bytes must advance within this window
  const DISCONNECT_GRACE    = 5000;  // 'disconnected' is often transient; wait before acting
  const STABLE_CONNECT_HOLD = 30000; // reset backoff only after this long connected

  // UI
  const LOG_MAX_LINES = 200; // cap the on-card log

  const DEFAULTS = {
    enabled: false,
    serverType: "go2rtc", // "go2rtc" (base URL + stream) | "whip" (explicit endpoint URL)
    go2rtc: "https://go2rtc-server:1984",
    stream: "webcam",
    whipUrl: "",         // full WHIP endpoint URL; used when serverType === "whip"
    bearerToken: "",     // optional Authorization: Bearer for WHIP POST/DELETE
    iceServers: '[{"urls":"stun:stun.l.google.com:19302"}]', // stored as STRING
    deviceId: "",        // video deviceId  (kiosk-local)
    micDeviceId: "",     // audioinput deviceId (kiosk-local)
    audioEnabled: true,  // include microphone (kiosk-local)
    _initialized: false
  };

  // -------------------- Shared helpers --------------------

  // ICE servers are stored as a JSON string and used as an array.
  const toIceArray = (v) => {
    if (Array.isArray(v)) return v;
    if (typeof v === "string") {
      try {
        const a = JSON.parse(v || "[]");
        return Array.isArray(a) ? a : [];
      } catch {
        return [];
      }
    }
    return [];
  };

  const iceToString = (v) => {
    if (Array.isArray(v)) {
      try { return JSON.stringify(v); } catch { return "[]"; }
    }
    if (typeof v === "string") return v;
    return "[]";
  };

  const deepEqual = (a, b) => {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  };

  // Keep keystrokes inside the card: Home Assistant has global hotkeys (c, e, …) on document, so a
  // keypress that bubbles out while you type in a field would open the quick bar / edit mode. Our own
  // key handlers run first (during bubbling inside the shadow root), so stopping here is safe.
  const keepKeysInside = (root) => {
    const stop = (e) => e.stopPropagation();
    root.addEventListener("keydown", stop);
    root.addEventListener("keyup", stop);
    root.addEventListener("keypress", stop);
  };

  // Map stored settings to the Session.start() argument shape.
  // (Session normalizes iceServers string→array itself.)
  const toStartSettings = (s) => ({
    serverType: s.serverType || "go2rtc",
    go2rtc: s.go2rtc,
    whipUrl: s.whipUrl || "",
    bearerToken: s.bearerToken || "",
    deviceId: s.deviceId || "",
    micDeviceId: s.micDeviceId || "",
    audioEnabled: !!s.audioEnabled,
    iceServers: s.iceServers,
  });

  // -------------------- Global Core (singleton) --------------------
  window.WebcamPublisherCore = (function () {
    const sessions = new Map(); // Map<stream, Session>

    class Session {
      constructor(stream) {
        this.streamName = stream;
        this.media = null;
        this.pc = null;
        this.resourceURL = null;
        // Normalized copy of the settings for the active publish (iceServers as an array):
        // {go2rtc, whipUrl, bearerToken, deviceId, micDeviceId, audioEnabled, iceServers}.
        this.settings = null;

        this.running = false;
        this.stopping = false;

        this.baseBackoff = 1000;
        this.maxBackoff = 20000;
        this.backoff = 0;

        // single-flight reconcile machinery
        this._busy = false;            // a reconcile loop is executing
        this._again = false;           // coalesce concurrent (re)connect requests
        this._kickTimer = null;        // delayed entry into reconcile
        this._watchdog = null;         // periodic liveness check
        this._disconnectGrace = null;  // grace before reconnecting on 'disconnected'
        this._stableTimer = null;      // resets backoff after a stable period
        this._lastBytesSent = 0;
        this._lastBytesAt = 0;

        this.subs = new Set();      // status subs
        this.mediaSubs = new Set(); // preview subs

        this._ac = new AbortController(); // owns global listeners → removable on destroy
        this._bindGlobalListeners();
      }

      // ---- subscriptions ----
      onStatus(cb) {
        this.subs.add(cb);
        // Replay the current status to a new subscriber so a card that attaches to an already-
        // running session (view switch, re-add) immediately reflects "streaming" instead of idle.
        if (this._lastStatus !== undefined) { try { cb(this._lastStatus, this._lastStatusOk); } catch {} }
        return () => this.subs.delete(cb);
      }
      _emit(m, ok = true) {
        this._lastStatus = m;
        this._lastStatusOk = ok;
        this.subs.forEach(cb => { try { cb(m, ok); } catch {} });
      }

      onMedia(cb) {
        this.mediaSubs.add(cb);
        if (this.media) { try { cb(this.media); } catch {} }
        return () => this.mediaSubs.delete(cb);
      }

      _emitMedia() {
        this.mediaSubs.forEach(cb => { try { cb(this.media); } catch {} });
      }

      _bindGlobalListeners() {
        const signal = this._ac.signal;
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible" && this.running && !this._isConnected()) this._kick(250);
        }, { signal });
        window.addEventListener("online", () => {
          if (this.running && !this._isConnected()) this._kick(250);
        }, { signal });
        window.addEventListener("offline", () => this._emit("offline", false), { signal });
        // Only react to a device change if we're NOT currently connected — some Android WebViews
        // fire devicechange on every wake, which would otherwise churn a perfectly healthy stream.
        // A device that actually disappears is caught by the track 'onended' handler instead.
        navigator.mediaDevices?.addEventListener?.("devicechange", () => {
          if (this.running && !this._isConnected()) this._kick(500);
        }, { signal });
      }

      // ---- media constraints (relaxed / capability-aware) ----
      _audioConstraints() {
        if (!this.settings.audioEnabled) return false;
        const sup = navigator.mediaDevices?.getSupportedConstraints?.() || {};
        const c = {};
        const ideal = (k, val) => { if (sup[k]) c[k] = { ideal: val }; };
        ideal("echoCancellation", true);
        ideal("noiseSuppression", true);
        ideal("autoGainControl", true);
        if (sup.channelCount) c.channelCount = { ideal: 1 };
        if (sup.sampleRate)   c.sampleRate   = { ideal: 48000 };
        if (sup.sampleSize)   c.sampleSize   = { ideal: 16 };
        if (this.settings.micDeviceId) {
          if (sup.deviceId) c.deviceId = { ideal: this.settings.micDeviceId };
          else c.deviceId = this.settings.micDeviceId;
        }
        return Object.keys(c).length ? c : true;
      }

      _videoConstraints() {
        const sup = navigator.mediaDevices?.getSupportedConstraints?.() || {};
        const v = {};
        const preferredDeviceId = this.settings.deviceId || "";
        if (preferredDeviceId) {
          if (sup.deviceId) v.deviceId = { ideal: preferredDeviceId };
          else v.deviceId = preferredDeviceId;
        } else if (sup.facingMode) {
          v.facingMode = { ideal: "environment" };
        }
        if (sup.width)        v.width       = { ideal: 1280 };
        if (sup.height)       v.height      = { ideal: 720 };
        if (sup.frameRate)    v.frameRate   = { ideal: 30 };
        if (sup.aspectRatio)  v.aspectRatio = { ideal: 16 / 9 };
        return Object.keys(v).length ? v : true;
      }

      async _gum(constraints, timeoutMs) {
        // getUserMedia can hang on some Android WebViews when the camera is held by another
        // process (e.g. after sleep/wake), which would stall the reconcile loop forever. Time it
        // out so the loop retries; stop any stream that resolves after we've already timed out.
        let timer;
        let timedOut = false;
        const p = navigator.mediaDevices.getUserMedia(constraints);
        p.then(s => {
          if (timedOut) { try { s.getTracks().forEach(t => t.stop()); } catch {} }
        }).catch(() => {});
        const timeout = new Promise((_, rej) => {
          timer = setTimeout(() => {
            timedOut = true;
            rej(new Error("getUserMedia timeout"));
          }, timeoutMs);
        });
        try { return await Promise.race([p, timeout]); }
        finally { clearTimeout(timer); }
      }

      // Return a live stream matching the settings, reusing the current one when it still fits.
      async _ensureMedia() {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("getUserMedia unsupported");

        if (this.media) {
          const vLive = this.media.getVideoTracks().some(t => t.readyState === "live");
          const aLive = this.media.getAudioTracks().some(t => t.readyState === "live");
          const vOk = !this.settings.deviceId ||
            this.media.getVideoTracks()[0]?.getSettings?.().deviceId === this.settings.deviceId;
          const aOk = !this.settings.audioEnabled || !this.settings.micDeviceId ||
            this.media.getAudioTracks()[0]?.getSettings?.().deviceId === this.settings.micDeviceId;
          if (vLive && vOk && (!this.settings.audioEnabled || aLive) && aOk) return this.media;
          try { this.media.getTracks().forEach(t => t.stop()); } catch {}
          this.media = null;
        }

        const constraints = { video: this._videoConstraints(), audio: this._audioConstraints() };
        this.media = await this._gum(constraints, TIMEOUT_MEDIA);

        const reconnectOnEnd = (kind) => () => {
          this._emit(kind + " track ended; reconnecting…", false);
          if (this.running) this._kick(0);
        };
        this.media.getVideoTracks().forEach(t => { t.onended = reconnectOnEnd("video"); });
        this.media.getAudioTracks().forEach(t => { t.onended = reconnectOnEnd("audio"); });

        this._emitMedia();
        return this.media;
      }

      // ---- helpers ----
      _whipUrl() {
        // serverType "whip" = an explicit endpoint (any spec-compliant server); "go2rtc" = the
        // base URL + /api/webrtc?dst=stream convention.
        if (this.settings.serverType === "whip" && this.settings.whipUrl) return this.settings.whipUrl;
        const u = new URL(this.settings.go2rtc.replace(/\/$/, "") + "/api/webrtc");
        u.searchParams.set("dst", this.streamName);
        return u.toString();
      }
      _authHeaders() {
        const t = this.settings?.bearerToken;
        return t ? { "Authorization": "Bearer " + t } : {};
      }
      _jitter(ms) { return Math.floor(ms * (1 + Math.random() * 0.25)); }
      _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

      // True once the peer connection (or its ICE) has reached a connected state.
      _isConnected() {
        const pc = this.pc;
        if (!pc) return false;
        const cs = pc.connectionState, is = pc.iceConnectionState;
        return cs === "connected" || is === "connected" || is === "completed";
      }

      async _fetch(url, opts, timeoutMs) {
        // fetch with a hard timeout so a hung request can never stall reconnection.
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), timeoutMs);
        try { return await fetch(url, { ...opts, signal: ac.signal }); }
        finally { clearTimeout(to); }
      }

      async _gatherIce(pc, timeoutMs) {
        // Wait for ICE gathering to complete, but ALWAYS proceed after a timeout
        // (non-trickle WHIP works fine with the candidates gathered so far).
        if (pc.iceGatheringState === "complete") return;
        await new Promise(res => {
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(to);
            try { pc.removeEventListener("icegatheringstatechange", onchg); } catch {}
            res();
          };
          const onchg = () => { if (pc.iceGatheringState === "complete") done(); };
          const to = setTimeout(done, timeoutMs);
          pc.addEventListener("icegatheringstatechange", onchg);
        });
      }

      // React to peer/ICE state changes: reconnect on failure, ride out brief drops, note stability.
      _onState(pc) {
        if (pc !== this.pc || !this.running) { this._abortAttempt(pc); return; } // ignore events from a superseded peer
        const cs = pc.connectionState, is = pc.iceConnectionState;

        if (cs === "failed" || cs === "closed" || is === "failed" || is === "closed") {
          if (this.running && !this.stopping) this._kick(0);
          return;
        }
        if (cs === "disconnected" || is === "disconnected") {
          // transient most of the time — only reconnect if it doesn't recover.
          if (this.running && !this.stopping && !this._disconnectGrace) {
            this._disconnectGrace = setTimeout(() => {
              this._disconnectGrace = null;
              if (this.running && !this._isConnected()) this._kick(0);
            }, DISCONNECT_GRACE);
          }
          return;
        }
        if (this._isConnected()) {
          if (this._disconnectGrace) { clearTimeout(this._disconnectGrace); this._disconnectGrace = null; }
          this._armStableTimer(); // reset backoff only after a sustained connection
        }
      }

      // Clear the backoff only after staying connected a while, so a flapping link keeps backing off.
      _armStableTimer() {
        if (this._stableTimer) return;
        this._stableTimer = setTimeout(() => {
          this._stableTimer = null;
          if (this._isConnected()) this.backoff = 0;
        }, STABLE_CONNECT_HOLD);
      }

      // While publishing, poll _checkHealth() to catch a silently-dead stream.
      _startWatchdog() {
        if (this._watchdog) return;
        this._lastBytesSent = 0;
        this._lastBytesAt = Date.now();
        this._watchdog = setInterval(() => { this._checkHealth(); }, WATCHDOG_INTERVAL);
      }
      _stopWatchdog() { if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; } }

      async _checkHealth() {
        if (!this.running) { this._stopWatchdog(); return; }
        const pc = this.pc;
        if (!pc || !this._isConnected()) { this._kick(0); return; }
        // Detect a silently-dead publish (e.g. go2rtc restarted) where state stays 'connected'
        // but no media flows: outbound bytes must keep advancing.
        try {
          const stats = await pc.getStats();
          let bytes = 0;
          stats.forEach(r => { if (r.type === "outbound-rtp") bytes += (r.bytesSent || 0); });
          const now = Date.now();
          if (bytes > this._lastBytesSent) {
            this._lastBytesSent = bytes;
            this._lastBytesAt = now;
            this._emit(`streaming → ${this.streamName}`); // bytes are flowing → authoritatively "streaming"
          }
          else if ((now - this._lastBytesAt) >= MEDIA_STALL_LIMIT) {
            this._emit("no outbound media; reconnecting…", false);
            this._kick(0);
          }
        } catch {}
      }

      // Close the local peer and tell the server to drop the WHIP resource (DELETE).
      async _teardownPeer() {
        const pc = this.pc;
        const res = this.resourceURL;
        this.pc = null;
        this.resourceURL = null;
        if (pc) {
          try { pc.oniceconnectionstatechange = null; pc.onconnectionstatechange = null; } catch {}
          try { pc.close(); } catch {}
        }
        if (res) {
          try {
            await this._fetch(res, { method: "DELETE", headers: this._authHeaders() }, TIMEOUT_WHIP_DELETE)
              .catch(() => {});
          } catch {}
        }
      }

      // Bail out of an in-flight attempt: close the peer we created locally, and — if the session
      // was stopped while we were awaiting (getUserMedia / offer / ICE / WHIP POST) — release the
      // camera/mic we may have just (re)acquired. Without this, a stop() that races an in-flight
      // attempt can leave the device held and a peer publishing with no running loop to clean it up.
      _abortAttempt(pc) {
        if (pc) {
          try { pc.oniceconnectionstatechange = null; pc.onconnectionstatechange = null; } catch {}
          try { pc.close(); } catch {}
        }
        if (this.pc === pc) this.pc = null;
        if (!this.running && this.media) {
          try { this.media.getTracks().forEach(t => t.stop()); } catch {}
          this.media = null;
          this._emitMedia();
        }
      }

      // One full publish attempt: teardown prior → media → peer → offer → WHIP POST → answer.
      // Captures the peer locally and bails if superseded, so a concurrent stop/reconnect
      // can never operate on the wrong/closed peer.
      async _attempt() {
        await this._teardownPeer(); // always release prior local peer AND server resource first
        if (!this.running) return;

        await this._ensureMedia();
        if (!this.running) { this._abortAttempt(null); return; } // stop() raced us → release re-acquired media

        const pc = new RTCPeerConnection({ iceServers: this.settings.iceServers || [] });
        this.pc = pc;
        pc.oniceconnectionstatechange = () => this._onState(pc);
        pc.onconnectionstatechange = () => this._onState(pc);

        const addSendOnly = (t) => {
          try { pc.addTransceiver(t, { direction: "sendonly", streams: [this.media] }); }
          catch { try { pc.addTrack(t, this.media); } catch {} }
        };
        this.media.getVideoTracks().forEach(addSendOnly);
        if (this.settings.audioEnabled) this.media.getAudioTracks().forEach(addSendOnly);

        const offer = await pc.createOffer();
        if (pc !== this.pc || !this.running) { this._abortAttempt(pc); return; }
        await pc.setLocalDescription(offer);
        await this._gatherIce(pc, TIMEOUT_ICE_GATHER);
        if (pc !== this.pc || !this.running) { this._abortAttempt(pc); return; }

        const url = this._whipUrl();
        const resp = await this._fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/sdp", ...this._authHeaders() },
          body: pc.localDescription.sdp
        }, TIMEOUT_WHIP_POST);
        if (pc !== this.pc || !this.running) { this._abortAttempt(pc); return; }
        if (!resp.ok) throw new Error("WHIP POST failed: " + resp.status);

        const answer = await resp.text();
        if (pc !== this.pc || !this.running) { this._abortAttempt(pc); return; }
        await pc.setRemoteDescription({ type: "answer", sdp: answer });

        // Resolve the (possibly relative) Location against the WHIP POST URL → correct go2rtc origin.
        const loc = resp.headers.get("Location") || resp.headers.get("location");
        this.resourceURL = loc ? new URL(loc, url).toString() : null;

        this._lastBytesSent = 0;
        this._lastBytesAt = Date.now();
      }

      // Request a (re)connect; coalesces with any running reconcile so only one loop is ever active.
      _kick(delay = 0) {
        if (!this.running) return;
        if (this._busy) { this._again = true; return; } // a reconcile is running; it will loop again
        if (this._kickTimer) { clearTimeout(this._kickTimer); this._kickTimer = null; }
        this._kickTimer = setTimeout(() => { this._kickTimer = null; this._reconcile(); }, Math.max(0, delay));
      }

      // Single-flight, serialized connect/reconnect loop with exponential backoff.
      async _reconcile() {
        if (this._busy || !this.running) return;
        this._busy = true;
        this._stopWatchdog();
        try {
          while (this.running) {
            this._again = false;

            if (this.backoff > 0) {
              const sleep = this._jitter(this.backoff);
              this._emit(`retry in ~${sleep}ms`, false);
              await this._sleep(sleep);
              if (!this.running) break;
            }
            // grow backoff for the NEXT attempt; reset to 0 happens only after a stable connect.
            this.backoff = this.backoff ? Math.min(this.maxBackoff, this.backoff * 2) : this.baseBackoff;

            try {
              await this._attempt();
              if (!this.running) break;
              this._emit(`streaming → ${this.streamName}`);
              // Connected. Always break — do NOT re-tear-down on a spurious kick (devicechange /
              // visibilitychange / online) that may have fired during the attempt. Real failures
              // are driven by _onState (immediate) and the watchdog (byte-stall within 15s).
              break;
            } catch (e) {
              this._emit("stream error: " + e, false);
              // fall through → loop will back off and retry (forever)
            }
          }
        } finally {
          this._busy = false;
          if (this.running) this._startWatchdog();
        }
      }

      // Begin (or update) publishing; the reconcile loop then keeps it alive until stop().
      async start(nextSettings) {
        const s = {
          serverType: nextSettings.serverType === "whip" ? "whip" : "go2rtc",
          go2rtc: nextSettings.go2rtc,
          whipUrl: (nextSettings.whipUrl || "").trim(),
          bearerToken: (nextSettings.bearerToken || "").trim(),
          deviceId: nextSettings.deviceId || "",
          micDeviceId: nextSettings.audioEnabled ? (nextSettings.micDeviceId || "") : "",
          audioEnabled: !!nextSettings.audioEnabled,
          iceServers: toIceArray(nextSettings.iceServers)
        };
        if (this.running && this.settings && deepEqual(this.settings, s)) {
          this._emit("already streaming");
          return "already_running";
        }
        this.settings = s;
        const httpsOK = location.protocol === "https:" || location.hostname === "localhost";
        if (!httpsOK) this._emit("Camera/mic usually require HTTPS; current: " + location.protocol, false);

        this.running = true; this.stopping = false;
        this.backoff = 0;   // fresh intent → fast first attempt
        this._kick(0);      // serialized reconcile does media+peer+publish, retrying forever on failure
        return "started";
      }

      _clearTimers() {
        if (this._kickTimer) { clearTimeout(this._kickTimer); this._kickTimer = null; }
        if (this._disconnectGrace) { clearTimeout(this._disconnectGrace); this._disconnectGrace = null; }
        if (this._stableTimer) { clearTimeout(this._stableTimer); this._stableTimer = null; }
        this._stopWatchdog();
      }

      // Stop publishing and release the camera/mic. Can be started again later.
      async stop() {
        this.stopping = true; this.running = false;
        this._clearTimers();
        try { await this._teardownPeer(); } catch {}
        // Release the camera/mic whenever we're not publishing — never hold the devices (or the
        // camera-in-use indicator) while stopped. They are re-acquired on the next start.
        try { this.media?.getTracks?.().forEach(t => t.stop()); } catch {}
        this.media = null;
        this._emitMedia();
        this._emit("stopped");
      }

      // Stop for good and drop global listeners so the session can be garbage-collected.
      async destroy() {
        await this.stop();
        try { this.media?.getTracks?.().forEach(t => t.stop()); } catch {}
        this.media = null;
        this._emitMedia();
        try { this._ac.abort(); } catch {} // remove global listeners so the Session can be GC'd
      }

      getPreviewStream() { return this.media || null; }
    }

    const Core = {
      activeStream: null,

      getOrCreateSession(stream) {
        if (!stream) throw new Error("Stream required");
        if (!sessions.has(stream)) sessions.set(stream, new Session(stream));
        return sessions.get(stream);
      },
      hasSession(stream) { return sessions.has(stream); },

      // Single active publisher per browser session: starting one stream stops/destroys all others.
      async startStream(stream, settings) {
        if (!stream) throw new Error("Stream required");
        for (const [name, sess] of [...sessions]) {
          if (name !== stream) { try { await sess.destroy(); } catch {} sessions.delete(name); }
        }
        this.activeStream = stream;
        const sess = this.getOrCreateSession(stream);
        return await sess.start({ ...settings });
      },
      async stopStream(stream) {
        const sess = sessions.get(stream);
        if (sess) await sess.stop();
        if (this.activeStream === stream) this.activeStream = null;
      },
      async destroyStream(stream) {
        const sess = sessions.get(stream);
        if (sess) { await sess.destroy(); sessions.delete(stream); }
        if (this.activeStream === stream) this.activeStream = null;
      },
      async stopAll() {
        for (const [name, sess] of [...sessions]) { try { await sess.destroy(); } catch {} sessions.delete(name); }
        this.activeStream = null;
      },
      // Mirror a session's local media into a <video>; returns an unsubscribe function.
      attachPreview(stream, videoEl) {
        const sess = sessions.get(stream);
        if (!sess || !videoEl) return () => {};
        const setSrc = (ms) => {
          videoEl.srcObject = ms || null;
          videoEl.style.display = ms ? "block" : "none"; // hide the preview entirely when nothing is acquired
          if (ms) {
            try {
              videoEl.muted = true;
              videoEl.play?.().catch(() => {});
            } catch {}
          }
        };
        setSrc(sess.getPreviewStream());
        return sess.onMedia(setSrc);
      },
      onStatus(stream, cb) {
        const sess = sessions.get(stream);
        if (!sess) return () => {};
        return sess.onStatus(cb);
      },
    };

    // Start (or resume) publishing from the saved settings, if enabled. Used by
    // the headless autostart below and by the camera hand-off resume.
    const startFromSaved = () => {
      try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw) || {};
        const s = { ...DEFAULTS, ...saved };
        // Saves from before "Server type" existed: infer it from whether a WHIP URL was set.
        if (saved.serverType == null) s.serverType = (saved.whipUrl || "").trim() ? "whip" : "go2rtc";
        if (s.enabled && s.stream) Core.startStream(s.stream, toStartSettings(s));
      } catch {}
    };

    // Headless autostart: resume a previously-enabled publish on page load.
    // No device access happens unless the saved settings say enabled.
    startFromSaved();

    // Cooperative camera sharing (see the header). Track outstanding claims by id; release the camera
    // while any is held and resume once the last one clears. Falls back to `by` then "anonymous" so a
    // claimer that omits an id still works (its release must omit it too).
    const claimKey = (e) => (e && e.detail && (e.detail.id ?? e.detail.by)) ?? "anonymous";
    const activeClaims = new Set();
    window.addEventListener("camera:claim", (e) => {
      activeClaims.add(claimKey(e));
      const held = Core.activeStream; // we hold the camera only while publishing
      if (held) {
        if (e && e.detail) e.detail.willRelease = true; // tell the claimer to wait for the device
        Core.stopStream(held).catch(() => {});
      }
    });
    window.addEventListener("camera:release", (e) => {
      if (!activeClaims.delete(claimKey(e))) return; // ignore a release we never recorded
      if (activeClaims.size === 0) startFromSaved();
    });

    return Core;
  })();

  // -------------------- Element (controller/preview UI) --------------------
  class WebcamPublisher extends HTMLElement {
    setConfig(config) { this._config = config || {}; }
    set hass(h) { this._hass = h; if (!this._booted) this._boot(); }
    connectedCallback() {
      if (!this._booted) { this._boot(); return; }
      // Re-attach after being removed/re-added to the DOM (HA view switches).
      this._attachPreview();
      this._bindWindowListeners();
    }
    disconnectedCallback() {
      // Release subscriptions/listeners so detached cards don't leak into the singleton Session.
      try { this._unsubscribePreview?.(); } catch {}
      try { this._unsubscribeStatus?.(); } catch {}
      this._unsubscribePreview = this._unsubscribeStatus = null;
      this._unbindWindowListeners();
    }
    constructor() {
      super();
      this._onStorage = (e) => this._handleStorage(e);
      this._winBound = false;
    }

    _$(id) { return this.shadowRoot.getElementById(id); }

    _render() {
      const css = `
:host { display: block }
* { box-sizing: border-box }
.wrap {
  font: 14px system-ui,sans-serif;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dot {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: #9e9e9e;
  flex: 0 0 auto;
  box-shadow: 0 0 0 2px rgba(0,0,0,.12);
  transition: background .25s;
}
.title {
  font-weight: 600;
  font-size: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.grow {
  flex: 1 1 0;
  min-width: 8px;
}
.enrow {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  width: 100%;
  cursor: pointer;
  user-select: none;
  font-weight: 600;
}
.enrow input {
  margin: 0;
  width: 18px;
  height: 18px;
  accent-color: var(--success-color,#1db954);
}
.vfoot {
  font-size: 11px;
  opacity: .5;
  text-align: center;
  margin-top: 2px;
}
#preview {
  display: none;
  width: 100%;
  max-height: 240px;
  background: #000;
  object-fit: cover;
  border-radius: 12px;
}
.statusline {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  opacity: .85;
  min-height: 16px;
  cursor: pointer;
  user-select: none;
}
.statusline:hover { opacity: 1 }
.statusline .txt {
  flex: 1 1 auto;
  min-width: 0;
}
.logcaret {
  opacity: .55;
  transition: transform .15s ease;
}
.statusline[aria-expanded="true"] .logcaret { transform: rotate(180deg) }
.icon {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 1px solid var(--divider-color,#888);
  background: transparent;
  color: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  flex: 0 0 auto;
}
.icon:hover { background: var(--secondary-background-color,#8881) }
.icon[aria-expanded="true"] {
  border-color: var(--primary-color,#03a9f4);
  color: var(--primary-color,#03a9f4);
}
.btns.end { justify-content: flex-end }
.config {
  display: flex;
  flex-direction: column;
  gap: 14px;
  border-top: 1px solid var(--divider-color,#8883);
  padding-top: 14px;
}
.section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.section>h4 {
  margin: 0;
  font-size: 11px;
  letter-spacing: .05em;
  text-transform: uppercase;
  opacity: .6;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.field>label {
  font-size: 12px;
  opacity: .8;
}
input[type="text"],
textarea,
select {
  padding: 9px 10px;
  border-radius: 10px;
  border: 1px solid var(--divider-color,#888);
  background: var(--card-background-color,transparent);
  color: inherit;
  font: inherit;
  width: 100%;
}
textarea {
  min-height: 60px;
  resize: vertical;
  font-family: ui-monospace,Menlo,monospace;
  font-size: 12px;
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.btns {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
button.act {
  padding: 9px 14px;
  border-radius: 10px;
  border: 1px solid var(--divider-color,#888);
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
}
button.act:hover { background: var(--secondary-background-color,#8881) }
button.act.sm {
  padding: 6px 12px;
  font-size: 13px;
}
button.primary {
  background: var(--primary-color,#03a9f4);
  color: #fff;
  border-color: transparent;
}
.btns.minor button.act {
  font-size: 13px;
  padding: 7px 11px;
  opacity: .9;
}
small {
  opacity: .65;
  font-size: 11px;
}
#log {
  margin: 0;
  max-height: 120px;
  overflow: auto;
  white-space: pre-wrap;
  font-size: 11px;
  opacity: .75;
  background: var(--secondary-background-color,#0000000d);
  border-radius: 8px;
  padding: 8px;
}
.ok { color: var(--success-color,green) }
.err { color: var(--error-color,#b00) }
.muted { opacity: .75 }
.wp-card {
  display: block;
  overflow: hidden;
  color: var(--primary-text-color, inherit);
  background: var(--ha-card-background, var(--card-background-color, #fff));
  border-radius: var(--ha-card-border-radius, 12px);
  box-shadow: var(--ha-card-box-shadow, 0 2px 8px rgba(0,0,0,.15));
}
.hidden { display: none!important }
`;
      // A plain themed container (not <ha-card>) so the element is portable to any page; inside Home
      // Assistant the CSS variables above resolve to the active theme, elsewhere to the fallbacks.
      this.shadowRoot.innerHTML = `
<style>${css}</style>
<div class="wp-card">
<div class="wrap">
  <div class="head">
    <span class="dot" id="dot"></span>
    <span class="title" id="title">Browser camera</span>
    <span class="grow"></span>
    <button class="icon" id="settingsBtn" title="Settings" aria-label="Settings" aria-expanded="false">
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path fill="currentColor" d="M12,15.5A3.5,3.5 0 0,1 8.5,12A3.5,3.5 0 0,1 12,8.5A3.5,3.5 0 0,1 15.5,12A3.5,3.5 0 0,1 12,15.5M19.43,12.97C19.47,12.65 19.5,12.33 19.5,12C19.5,11.67 19.47,11.34 19.43,11L21.54,9.37C21.73,9.22 21.78,8.95 21.66,8.73L19.66,5.27C19.54,5.05 19.27,4.96 19.05,5.05L16.56,6.05C16.04,5.66 15.5,5.32 14.87,5.07L14.5,2.42C14.46,2.18 14.25,2 14,2H10C9.75,2 9.54,2.18 9.5,2.42L9.13,5.07C8.5,5.32 7.96,5.66 7.44,6.05L4.95,5.05C4.73,4.96 4.46,5.05 4.34,5.27L2.34,8.73C2.21,8.95 2.27,9.22 2.46,9.37L4.57,11C4.53,11.34 4.5,11.67 4.5,12C4.5,12.33 4.53,12.65 4.57,12.97L2.46,14.63C2.27,14.78 2.21,15.05 2.34,15.27L4.34,18.73C4.46,18.95 4.73,19.03 4.95,18.95L7.44,17.94C7.96,18.34 8.5,18.68 9.13,18.93L9.5,21.58C9.54,21.82 9.75,22 10,22H14C14.25,22 14.46,21.82 14.5,21.58L14.87,18.93C15.5,18.67 16.04,18.34 16.56,17.94L19.05,18.95C19.27,19.03 19.54,18.95 19.66,18.73L21.66,15.27C21.78,15.05 21.73,14.78 21.54,14.63L19.43,12.97Z"/>
      </svg>
    </button>
  </div>

  <video id="preview" autoplay playsinline muted></video>
  <div class="statusline" id="statusline" role="button" tabindex="0" title="Show / hide log">
    <span class="txt">Status: <span id="status" class="muted">idle</span></span>
    <span class="logcaret" aria-hidden="true">&#9662;</span>
  </div>
  <pre id="log" class="muted hidden"></pre>

  <div class="config hidden" id="config">

    <div class="section">
      <label class="enrow" title="Enable this camera / microphone">
        <input type="checkbox" id="enabled"><span>Enabled</span>
      </label>
      <small>
        Turning this on starts streaming immediately and is saved right away, so it auto-resumes
        after a reboot. Cancel reverts it; Apply saves the other fields.
      </small>
    </div>

    <div class="section">
      <div class="field">
        <label>Server type</label>
        <select id="serverType">
          <option value="go2rtc">go2rtc (base URL + stream)</option>
          <option value="whip">Generic WHIP (endpoint URL)</option>
        </select>
      </div>
      <div class="field">
        <label>Stream name</label>
        <input type="text" id="stream" placeholder="webcam">
      </div>
      <div class="field" data-server="go2rtc">
        <label>go2rtc base URL</label>
        <input type="text" id="go2rtc" placeholder="https://go2rtc-server:1984">
        <small>The card publishes to <code>&lt;base&gt;/api/webrtc?dst=&lt;stream&gt;</code>.</small>
      </div>
      <div class="field" data-server="whip">
        <label>WHIP endpoint URL</label>
        <input type="text" id="whipUrl" placeholder="https://mediamtx-server:8889/webcam/whip">
        <small>Full endpoint of any WHIP server. The stream name still labels this session.</small>
      </div>
      <div class="field" data-server="whip">
        <label>Bearer token (optional)</label>
        <input type="text" id="bearer" placeholder="">
        <small>Sent as "Authorization: Bearer …" on WHIP requests, if your server requires auth.</small>
      </div>
      <div class="field">
        <label>ICE servers (JSON)</label>
        <textarea id="ice">[]</textarea>
        <small>Example: [{"urls":"stun:stun.l.google.com:19302"}]</small>
      </div>
      <small>Edit fields, then press Apply (below) to save your changes.</small>
    </div>

    <div class="section">
      <div class="field">
        <label>Camera</label>
        <select id="camera"></select>
      </div>
      <label class="check"><input type="checkbox" id="audioEnabled"> Include microphone</label>
      <div class="field">
        <label>Microphone</label>
        <select id="mic"></select>
      </div>
      <div class="btns"><button class="act sm" id="refresh">Rescan device</button></div>
      <small>
        Device labels appear after you grant camera/mic permission on first enable.
        Echo cancel / AGC / noise suppression are on.
      </small>
    </div>

    <div class="section">
      <h4>Configuration</h4>
      <small>
        Import / Export back up or restore all settings as a JSON file. Load template fetches the
        shared connection settings (stream, URLs, ICE) from a URL — you'll be prompted, prefilled
        with a relative (same-origin) default path so it won't hit CORS.
      </small>
      <div class="btns">
        <button class="act" id="import">Import</button>
        <button class="act" id="export">Export</button>
        <button class="act" id="serverLoad">Load template</button>
      </div>
      <input type="file" id="file" accept=".json,application/json" class="hidden" />
    </div>

    <div class="btns end">
      <button class="act" id="cancel">Cancel</button>
      <button class="act primary" id="apply">Apply</button>
    </div>
    <div class="vfoot">webcam-publisher <span id="ver">v?</span></div>
  </div>
</div>
</div>`;
    }

    // One-time setup: build the shadow DOM, load settings, wire the controls, start if enabled.
    async _boot() {
      this._booted = true;
      this.attachShadow({ mode: "open" });
      keepKeysInside(this.shadowRoot);
      this._render();
      const _ver = this._$("ver"); if (_ver) _ver.textContent = "v" + VERSION;

      // Initial defaults: from the Lovelace card config (preferred) or HTML attributes (fallback).
      // These only seed a browser with no saved settings yet; everyday config lives in localStorage.
      const cfg = this._config || {};
      const attrDefaults = {
        go2rtc: cfg.go2rtc || this.getAttribute("go2rtc") || "",
        stream: cfg.stream || this.getAttribute("stream") || "",
        whipUrl: cfg.whipUrl || this.getAttribute("whip-url") || "",
        bearerToken: cfg.bearerToken || this.getAttribute("bearer-token") || "",
        serverType: cfg.serverType || this.getAttribute("server-type") || "",
        iceServers: cfg.ice || cfg.iceServers || this.getAttribute("ice") || "",
        enabled: (typeof cfg.enabled === "boolean") ? cfg.enabled
                 : (this.hasAttribute("enabled") ? this.getAttribute("enabled") !== "false" : undefined)
      };

      this._settings = await this._loadSettings(attrDefaults);
      this._reflectSettingsToUI();

      // Settings panel: collapsed by default so the editable config can't be touched by accident.
      // The gear stays a gear (it never relabels); it just highlights while the panel is open.
      const setConfigOpen = (open) => {
        this._$("config").classList.toggle("hidden", !open);
        this._$("settingsBtn").setAttribute("aria-expanded", String(open));
      };
      // Opening snapshots the saved settings so Cancel (or closing via the gear) can fully revert —
      // including undoing a live "Enabled" test that wasn't there before the panel was opened.
      const openEdit = () => {
        this._snapshot = JSON.parse(JSON.stringify(this._settings));
        this._reflectSettingsToUI();
        setConfigOpen(true);
      };
      const cancelEdit = async () => {
        if (this._snapshot) this._settings = this._snapshot;
        this._snapshot = null;
        this._persist();   // un-save a live-test Enable: restore the persisted state from when we opened
        this._reflectSettingsToUI();
        this._attachPreview();
        if (this._settings.enabled) this._startCore(); else await this._stopCore();
        setConfigOpen(false);
      };
      this._$("settingsBtn").addEventListener("click", () => {
        // The gear just toggles the panel's visibility. Opening snapshots the settings; clicking it
        // again only closes — it does NOT apply and does NOT revert (that's what Apply / Cancel are
        // for). Unsaved field edits are discarded on the next open; a live "Enabled" test is left as is.
        if (this._$("config").classList.contains("hidden")) {
          openEdit();
        } else {
          this._snapshot = null;
          setConfigOpen(false);
        }
      });

      // Clicking the status line shows/hides the log — kept separate from the gear so you can
      // check status without opening (and risk editing) the configuration.
      const statusline = this._$("statusline");
      statusline.addEventListener("click", () => {
        const log = this._$("log");
        const show = log.classList.contains("hidden");
        log.classList.toggle("hidden", !show);
        statusline.setAttribute("aria-expanded", String(show));
      });
      statusline.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); statusline.click(); }
      });

      this._$("refresh").addEventListener("click", () => this._listDevices());

      // Server type toggles which connection fields are shown (go2rtc base URL vs WHIP endpoint).
      this._$("serverType").addEventListener("change", (e) => this._applyServerType(e.target.value));

      // Enabled is a LIVE test: toggling it starts/stops publishing immediately using the current
      // (unsaved) form values. The Enabled flag ITSELF is persisted right away (so an always-on
      // device auto-resumes after a reboot); the other edited fields still wait for Apply.
      this._$("enabled").addEventListener("change", async (e) => {
        this._readFromUI();                          // live test uses the current (unsaved) form values
        this._persistEnabledOnly(e.target.checked);  // but save Enabled itself NOW so it survives a reboot
        if (e.target.checked) this._startCore(); else await this._stopCore();
        this._attachPreview();
      });

      // Apply = Save: persist the current form (including the Enabled state), reconcile the stream,
      // and close. The live test simply becomes permanent.
      this._$("apply").addEventListener("click", async () => {
        await this._saveFromUI();
        this._snapshot = null;
        this._reflectSettingsToUI();
        this._attachPreview();
        if (this._settings.enabled) this._startCore(); else await this._stopCore();
        this._log("Configuration saved.");
        setConfigOpen(false);
      });

      // Cancel: revert everything to the snapshot taken when the panel opened (form + run state),
      // so a live test started during this session is torn back down if it wasn't on before.
      this._$("cancel").addEventListener("click", cancelEdit);

      // Export / Import / Load (server)
      this._$("export").addEventListener("click", () => this._exportConfig());
      this._$("import").addEventListener("click", () => this._$("file").click());
      this._$("file").addEventListener("change", (e) => this._loadFromFile(e.target.files?.[0] || null));

      // "Load template": prompt for a template URL — prefilled with the default location as a
      // relative, SAME-ORIGIN path so it never trips a CORS preflight; any URL may be typed instead.
      this._$("serverLoad").addEventListener("click", async () => {
        const s = (this._$("stream").value || this._settings.stream || "").trim();
        const def = this._defaultTemplateUrl(s);
        const entered = prompt("Load template from URL:", def);
        if (entered == null || !entered.trim()) { this._log("Template load cancelled."); return; }
        const ok = await this._loadFromUrl(entered.trim());
        if (ok) {
          this._log("Template applied.");
          this._attachPreview();
          if (this._settings.enabled) this._startCore();
        }
      });

      this._attachPreview();
      this._bindWindowListeners();
      await this._listDevices();

      if (this._settings.enabled) this._startCore();
    }

    _bindWindowListeners() {
      if (this._winBound) return; this._winBound = true;
      window.addEventListener("storage", this._onStorage);
    }
    _unbindWindowListeners() {
      if (!this._winBound) return; this._winBound = false;
      window.removeEventListener("storage", this._onStorage);
    }

    // Keep multiple open card UIs unified: another card/tab changed the single config.
    _handleStorage(e) {
      if (e.key !== SETTINGS_KEY) return;
      // Never overwrite an in-progress edit (the snapshot that Cancel restores) with a change from
      // another context. Single-tab kiosks never receive this event; this only guards multi-tab /
      // companion-app use, where it would otherwise corrupt the open editor's working set.
      if (this._snapshot) return;
      try {
        const s = JSON.parse(e.newValue || "null");
        if (!s) return;
        this._settings = { ...DEFAULTS, ...s };
        this._reflectSettingsToUI();
        this._attachPreview();
      } catch {}
    }

    // Push the in-memory settings into the form controls.
    _reflectSettingsToUI() {
      if (!this.shadowRoot) return;
      this._$("enabled").checked      = !!this._settings.enabled;
      this._$("serverType").value     = this._settings.serverType || "go2rtc";
      this._$("go2rtc").value         = this._settings.go2rtc || "";
      this._$("stream").value         = this._settings.stream || "";
      this._$("whipUrl").value        = this._settings.whipUrl || "";
      this._$("bearer").value         = this._settings.bearerToken || "";
      this._$("ice").value            = iceToString(this._settings.iceServers);
      this._$("audioEnabled").checked = !!this._settings.audioEnabled;
      this._applyServerType(this._settings.serverType || "go2rtc");
      const title = this._$("title");
      if (title) title.textContent = this._settings.stream || "Browser camera";
    }

    // Show only the fields for the chosen server type: go2rtc base URL, or the WHIP endpoint +
    // bearer token. Stream name and ICE servers apply to both and stay visible.
    _applyServerType(type) {
      if (!this.shadowRoot) return;
      this.shadowRoot.querySelectorAll(".field[data-server]").forEach((el) => {
        el.classList.toggle("hidden", el.getAttribute("data-server") !== type);
      });
    }

    // ---- UI helpers ----
    _status(s, ok = true) {
      const pill = this._$("status");
      if (pill) {
        pill.textContent = s;
        pill.className = ok ? "muted" : "err";
      }
      const dot = this._$("dot");
      if (dot) {
        const t = String(s || "").toLowerCase();
        let color = "#9e9e9e"; // idle / stopped
        if (!ok || /error|fail/.test(t)) color = "var(--error-color,#b00)";
        else if (/stream/.test(t)) color = "var(--success-color,#1db954)";
        else if (/reconnect|retry|connect|offline|waiting|stale|start/.test(t)) color = "var(--warning-color,#e6a700)";
        dot.style.background = color;
      }
    }
    _log(msg, ok = true) {
      const log = this._$("log");
      if (log) {
        const line = document.createElement("div");
        line.textContent = (typeof msg === "string") ? msg : JSON.stringify(msg);
        line.className = ok ? "ok" : "err";
        log.appendChild(line);
        while (log.childElementCount > LOG_MAX_LINES) log.removeChild(log.firstChild); // bounded
      }
      this._status((typeof msg === "string") ? msg : "…", ok);
    }

    // Core status updates: always reflect the latest in the pill, but only append to the log when
    // the message actually changes — so the watchdog's periodic "streaming" renewal (every 15s while
    // bytes flow) keeps the pill green without flooding the log.
    _onCoreStatus(m, ok = true) {
      if (m === this._lastCoreStatus) { this._status(m, ok); return; }
      this._lastCoreStatus = m;
      this._log(m, ok);
    }

    // Fill the camera/mic dropdowns. No getUserMedia here, so labels stay blank until permission.
    async _listDevices() {
      const camSel = this._$("camera");
      const micSel = this._$("mic");
      camSel.innerHTML = "";
      micSel.innerHTML = "";

      const addOption = (sel, value, label) => {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label;
        sel.appendChild(opt);
      };

      if (!navigator.mediaDevices?.enumerateDevices) {
        addOption(camSel, "", "Media devices API not available");
        addOption(micSel, "", "Media devices API not available");
        this._log("enumerateDevices not supported in this browser.", false);
        return;
      }

      try {
        // DO NOT call getUserMedia here — avoid permission prompts/capture until enabled/started.
        const devs = await navigator.mediaDevices.enumerateDevices();
        const cams = devs.filter(d => d.kind === "videoinput");
        const mics = devs.filter(d => d.kind === "audioinput");

        if (!cams.length) {
          addOption(camSel, "", "No cameras");
        } else {
          cams.forEach((d, i) => addOption(camSel, d.deviceId || "", d.label || `Camera ${i + 1}`));
          // Only reflect the saved id if it is actually present. NEVER overwrite the saved
          // selection when ids are blank (pre-permission) — that would wipe config on boot.
          if (this._settings.deviceId && cams.some(d => d.deviceId === this._settings.deviceId)) {
            camSel.value = this._settings.deviceId;
          }
        }

        if (!mics.length) {
          addOption(micSel, "", "No microphones");
        } else {
          mics.forEach((d, i) => addOption(micSel, d.deviceId || "", d.label || `Mic ${i + 1}`));
          if (this._settings.micDeviceId && mics.some(d => d.deviceId === this._settings.micDeviceId)) {
            micSel.value = this._settings.micDeviceId;
          }
        }

        if (devs.length && !devs.some(d => d.label)) {
          this._log("Device labels will appear after you grant camera/mic permission on first Start.");
        }
      } catch (e) {
        this._log("enumerateDevices failed: " + e, false);
      }
    }

    // ---- Core control (global) ----
    _unsubscribeStatus = null;
    _unsubscribePreview = null;

    // (Re)subscribe this card's preview and status to the Core session for the current stream.
    _attachPreview() {
      if (this._unsubscribePreview) { try { this._unsubscribePreview(); } catch {} this._unsubscribePreview = null; }
      if (this._unsubscribeStatus)  { try { this._unsubscribeStatus();  } catch {} this._unsubscribeStatus  = null; }

      const stream = (this._$("stream").value || this._settings.stream || "").trim();
      if (!stream) return;

      const video = this._$("preview");
      this._unsubscribePreview = window.WebcamPublisherCore.attachPreview(stream, video);

      if (window.WebcamPublisherCore.hasSession(stream)) {
        this._unsubscribeStatus = window.WebcamPublisherCore.onStatus(stream, (m, ok) => this._onCoreStatus(m, ok));
      }
    }

    // Start the Core publishing this card's configured stream.
    async _startCore() {
      const stream = (this._$("stream").value || this._settings.stream || "").trim();
      if (!stream) { this._log("Stream name required.", false); return; }

      await window.WebcamPublisherCore.startStream(stream, toStartSettings(this._settings));

      this._attachPreview();
      this._log(`Requested start → ${stream}`);
    }

    // Stop the Core session for this card's stream.
    async _stopCore() {
      const stream = (this._$("stream").value || this._settings.stream || "").trim();
      if (!stream) return;
      await window.WebcamPublisherCore.stopStream(stream);
      this._log("Requested stop.");
    }

    // ---- Settings IO (localStorage + import/export + server template) ----
    async _loadSettings(attrDefaults) {
      let raw; try { raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"); } catch { raw = null; }
      let s = { ...DEFAULTS, ...(raw || {}) };
      // Migrate saves from before "Server type" existed: infer it from whether a WHIP URL was set.
      if (raw && raw.serverType == null) s.serverType = (raw.whipUrl || "").trim() ? "whip" : "go2rtc";
      s.iceServers = iceToString(s.iceServers); // keep canonical string form
      if (attrDefaults && !s._initialized) {
        if (attrDefaults.go2rtc) s.go2rtc = attrDefaults.go2rtc;
        if (attrDefaults.stream) s.stream = attrDefaults.stream;
        if (attrDefaults.whipUrl) s.whipUrl = attrDefaults.whipUrl;
        if (attrDefaults.bearerToken) s.bearerToken = attrDefaults.bearerToken;
        if (attrDefaults.iceServers) s.iceServers = iceToString(attrDefaults.iceServers);
        if (typeof attrDefaults.enabled === "boolean") s.enabled = attrDefaults.enabled;
        // Server type: an explicit seed wins; otherwise a seeded WHIP URL implies the WHIP type.
        if (attrDefaults.serverType) s.serverType = attrDefaults.serverType;
        else if (attrDefaults.whipUrl) s.serverType = "whip";
      }
      s._initialized = true;
      this._settings = s;
      this._persist();
      return s;
    }

    _persist() {
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this._settings)); } catch {}
    }

    // Persist ONLY the enabled flag (merged onto the last-saved settings) without committing the
    // other in-progress form edits — those still wait for Apply. Enabled is authoritative for an
    // always-on device, so it must survive a reboot the instant it is toggled.
    _persistEnabledOnly(enabled) {
      this._settings.enabled = enabled;
      try {
        const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null") || {};
        saved.enabled = enabled;
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved));
      } catch {}
    }

    // Read the form into the in-memory working settings WITHOUT persisting. Used by the live
    // "Enabled" test, where changes must take effect immediately but not be saved until Apply.
    _readFromUI() {
      this._settings.enabled      = this._$("enabled").checked;
      this._settings.serverType   = this._$("serverType").value || "go2rtc";
      this._settings.go2rtc       = this._$("go2rtc").value.trim();
      this._settings.stream       = (this._$("stream").value || "").trim() || this._settings.stream;
      this._settings.whipUrl      = this._$("whipUrl").value.trim();
      this._settings.bearerToken  = this._$("bearer").value.trim();
      this._settings.iceServers   = iceToString(this._$("ice").value.trim());
      this._settings.deviceId     = this._$("camera").value || this._settings.deviceId || "";
      this._settings.micDeviceId  = this._$("mic").value || this._settings.micDeviceId || "";
      this._settings.audioEnabled = this._$("audioEnabled").checked;
    }

    async _saveFromUI() { this._readFromUI(); this._persist(); }

    // Download the current settings as a JSON file.
    _exportConfig() {
      const cfg = { ...this._settings };
      delete cfg._initialized;
      cfg.iceServers = iceToString(cfg.iceServers);
      const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      const name = (this._settings.stream || "webcam") + ".json";
      a.download = name;
      document.body.appendChild(a);
      a.click();
      URL.revokeObjectURL(a.href);
      a.remove();
      this._log(`Config exported as ${name}.`);
    }

    // Import a full settings file the user picked.
    async _loadFromFile(file) {
      // Import (explicit user file): apply full config but normalize iceServers.
      if (!file) return;
      try {
        const text = await file.text();
        const cfg = JSON.parse(text);
        await this._applyConfig(cfg);
        this._log("Config imported from file.");
        this._attachPreview();
        if (this._settings.enabled) this._startCore();
      } catch (e) {
        this._log("Failed to parse config file: " + e, false);
      } finally {
        this._$("file").value = "";
      }
    }

    // The default template location as a same-origin path: <script dir>/webcam-publisher/<stream>.json,
    // shown in the prompt so it's obvious any reachable URL may be substituted.
    _defaultTemplateUrl(stream) {
      // Return a RELATIVE path (no scheme/host) so the prompt default stays same-origin as the
      // dashboard — a relative URL never triggers a CORS preflight. Derived from wherever
      // webcam-publisher.js was loaded (…/local/… on HA, …/hacsfiles/… on HACS, or anywhere else),
      // falling back to a page-relative ./webcam-publisher/ so no host root (e.g. HA's /local/) is baked in.
      let basePath = "./webcam-publisher/";
      try {
        const scripts = document.querySelectorAll('script[src]');
        for (const s of scripts) {
          const src = s.getAttribute('src') || '';
          if (/webcam-publisher\.js(?:\?.*)?$/i.test(src)) {
            basePath = new URL(s.src, location.href).pathname.replace(/\/[^/]*$/, "/webcam-publisher/");
            break;
          }
        }
      } catch {}
      const name = (stream || "").trim();
      return name ? basePath + name + ".json" : basePath;
    }

    async _loadFromUrl(rawUrl) {
      let url;
      try { url = new URL(rawUrl, location.href); }
      catch { this._log("Invalid template URL: " + rawUrl, false); return false; }
      url.searchParams.set("t", Date.now().toString()); // cache-buster; edits take effect immediately

      let resp;
      try {
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), TIMEOUT_TEMPLATE_FETCH);
        try { resp = await fetch(url.toString(), { method: "GET", cache: "no-store", signal: ac.signal }); }
        finally { clearTimeout(to); }
      } catch (e) {
        // fetch() only REJECTS on a network-level failure — unreachable host, a blocked CORS
        // preflight, mixed content, or the abort timeout — never on an HTTP error status code.
        const why = e && e.name === "AbortError" ? "request timed out" : "could not reach the server";
        this._log(`Template fetch failed (${why}): ${url.pathname}. If the URL is cross-origin, enable CORS on that server.`, false);
        return false;
      }
      // Reaching here means we got an HTTP response — 404 just means no file at that path (NOT CORS).
      if (resp.status === 404) {
        const s = (this._settings.stream || "").trim() || "<stream>";
        this._log(`No template at ${url.pathname} (404). Put a "${s}.json" file there, or type a full URL to your template.`, false);
        return false;
      }
      if (!resp.ok) { this._log(`Template fetch failed: HTTP ${resp.status} for ${url.pathname}.`, false); return false; }
      try {
        this._applyTemplate(JSON.parse(await resp.text())); // TEMPLATE ONLY: shared connection fields
        this._log(`Template loaded from ${url.pathname}`);
        return true;
      } catch (e) {
        this._log(`Template at ${url.pathname} is not valid JSON: ${e}`, false);
        return false;
      }
    }

    // Server template: ONLY the shared connection fields — stream name, go2rtc base URL, WHIP
    // endpoint URL, and ICE servers. Device ids / enabled / microphone / bearer token are
    // kiosk-local and are never overwritten by a template.
    _applyTemplate(cfg) {
      if (!cfg || typeof cfg !== "object") return;
      if (typeof cfg.stream === "string" && cfg.stream.trim()) this._settings.stream = cfg.stream.trim();
      if (typeof cfg.go2rtc === "string" && cfg.go2rtc.trim()) this._settings.go2rtc = cfg.go2rtc.trim();
      if (typeof cfg.whipUrl === "string") this._settings.whipUrl = cfg.whipUrl.trim();
      if (cfg.iceServers != null) this._settings.iceServers = iceToString(cfg.iceServers);
      // Server type: honor an explicit value, else infer from whether the template carries a WHIP URL.
      if (cfg.serverType === "go2rtc" || cfg.serverType === "whip") this._settings.serverType = cfg.serverType;
      else if (typeof cfg.whipUrl === "string") this._settings.serverType = cfg.whipUrl.trim() ? "whip" : "go2rtc";
      this._persist();
      // Reflect only the template fields; leave enabled/audio/device selects untouched.
      this._$("serverType").value = this._settings.serverType || "go2rtc";
      this._$("stream").value  = this._settings.stream || "";
      this._$("go2rtc").value  = this._settings.go2rtc || "";
      this._$("whipUrl").value = this._settings.whipUrl || "";
      this._$("ice").value     = iceToString(this._settings.iceServers);
      this._applyServerType(this._settings.serverType || "go2rtc");
    }

    // Full config apply (Import): merge known keys only and normalize iceServers.
    async _applyConfig(cfg) {
      const known = ["enabled", "serverType", "go2rtc", "stream", "whipUrl", "bearerToken",
                     "iceServers", "deviceId", "micDeviceId", "audioEnabled"];
      const next = { ...DEFAULTS, ...this._settings, _initialized: true };
      for (const k of known) if (cfg && k in cfg) next[k] = cfg[k];
      next.iceServers = iceToString(next.iceServers);
      this._settings = next;
      this._persist();
      this._reflectSettingsToUI();
    }

    getCardSize() { return 6; }

    // Lovelace visual editor + a valid default config, so the card adds cleanly from the picker.
    static getConfigElement() { return document.createElement(TAG + "-editor"); }
    static getStubConfig() { return {}; }
  }

  // ---- Visual editor shown in the Lovelace "Edit card" dialog ----
  class WebcamPublisherEditor extends HTMLElement {
    // HA calls setConfig again after EVERY config-changed we emit (i.e. every keystroke). The DOM is
    // built exactly once and later calls only sync values — rebuilding it here would destroy the
    // focused input mid-word, drop focus to the dialog, and the next keystroke would fire HA's
    // global hotkeys (quick bar etc.).
    setConfig(config) {
      this._config = Object.assign({}, config);
      if (!this._root) this._render();
      this._syncFromConfig();
    }
    set hass(h) { this._hass = h; }
    _emit() {
      this.dispatchEvent(new CustomEvent("config-changed", {
        detail: { config: this._config }, bubbles: true, composed: true
      }));
    }
    // Build the editor DOM and wire its listeners. Runs once; values are applied by _syncFromConfig.
    _render() {
      this._root = this.attachShadow({ mode: "open" });
      keepKeysInside(this._root);
      this._root.innerHTML = `
<style>
.ed {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 2px;
}
.f {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
label {
  font-size: 12px;
  opacity: .8;
}
input[type=text],
textarea {
  padding: 9px 10px;
  border-radius: 8px;
  border: 1px solid var(--divider-color,#888);
  background: var(--card-background-color,transparent);
  color: inherit;
  font: inherit;
  width: 100%;
  box-sizing: border-box;
}
textarea {
  min-height: 54px;
  resize: vertical;
  font-family: ui-monospace,Menlo,monospace;
  font-size: 12px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.note {
  font-size: 12px;
  opacity: .75;
  line-height: 1.45;
  background: var(--secondary-background-color,#8881);
  padding: 10px;
  border-radius: 8px;
}
</style>
<div class="ed">
  <div class="note">
    Everyday settings live in the card itself (the &#9881; gear) and are saved per browser.
    The fields below are optional <b>initial defaults</b> — applied only the first time the card
    runs in a browser with no saved settings.
  </div>
  <div class="f">
    <label>Server type</label>
    <select id="e_servertype">
      <option value="go2rtc">go2rtc (base URL + stream)</option>
      <option value="whip">Generic WHIP (endpoint URL)</option>
    </select>
  </div>
  <div class="f">
    <label>Stream name</label>
    <input id="e_stream" type="text" placeholder="webcam">
  </div>
  <div class="f" data-server="go2rtc">
    <label>go2rtc base URL</label>
    <input id="e_go2rtc" type="text" placeholder="https://go2rtc-server:1984">
  </div>
  <div class="f" data-server="whip">
    <label>WHIP endpoint URL (any spec-compliant WHIP server)</label>
    <input id="e_whipurl" type="text" placeholder="https://mediamtx-server:8889/webcam/whip">
  </div>
  <div class="f">
    <label>ICE servers (JSON)</label>
    <textarea id="e_ice" placeholder='[{"urls":"stun:stun.l.google.com:19302"}]'></textarea>
  </div>
  <label class="row"><input id="e_enabled" type="checkbox"> Enable automatically on first run</label>
</div>`;
      const $ = (id) => this._root.getElementById(id);
      const upd = (key, val) => {
        const next = Object.assign({}, this._config);
        if (val === "" || val === false || val == null) delete next[key];
        else next[key] = val;
        this._config = next;
        this._emit();
      };
      $("e_servertype").addEventListener("change", (e) => {
        this._applyType(e.target.value);
        upd("serverType", e.target.value === "whip" ? "whip" : ""); // go2rtc is the default → omit
      });
      $("e_stream").addEventListener("input",  (e) => upd("stream", e.target.value.trim()));
      $("e_go2rtc").addEventListener("input",  (e) => upd("go2rtc", e.target.value.trim()));
      $("e_whipurl").addEventListener("input", (e) => upd("whipUrl", e.target.value.trim()));
      $("e_ice").addEventListener("input",     (e) => upd("ice", e.target.value.trim()));
      $("e_enabled").addEventListener("change",(e) => upd("enabled", e.target.checked));
    }

    // Show only the fields for the chosen server type.
    _applyType(t) {
      this._root.querySelectorAll(".f[data-server]").forEach(
        (el) => { el.style.display = el.getAttribute("data-server") === t ? "" : "none"; });
    }

    // Push config values into the fields WITHOUT rebuilding the DOM. The focused field is left
    // alone: it already holds what the user is typing (HA is just echoing it back), and writing
    // to it would move the cursor.
    _syncFromConfig() {
      const c = this._config || {};
      const $ = (id) => this._root.getElementById(id);
      const active = this._root.activeElement;
      const st = c.serverType === "whip" ? "whip" : "go2rtc";
      const sync = (id, prop, val) => { const el = $(id); if (el && el !== active) el[prop] = val; };
      sync("e_servertype", "value", st);
      this._applyType(st);
      sync("e_stream",  "value", c.stream || "");
      sync("e_go2rtc",  "value", c.go2rtc || "");
      sync("e_whipurl", "value", c.whipUrl || "");
      sync("e_ice",     "value", typeof c.ice === "string" ? c.ice : (c.ice ? JSON.stringify(c.ice) : ""));
      sync("e_enabled", "checked", !!c.enabled);
    }
  }

  // -------------------- Registration --------------------
  customElements.define(TAG, WebcamPublisher);
  customElements.define(TAG + "-editor", WebcamPublisherEditor);
  (window.customCards = window.customCards || []).push({
    type: TAG,
    name: "Webcam Publisher",
    description:
      "Turn this device into a camera: publishes the browser's camera/mic over WHIP to go2rtc — " +
      "feeding Frigate (recommended) and Home Assistant — or any WHIP server. Auto-reconnects " +
      "forever; per-browser settings; URL templates.",
  });
})();
