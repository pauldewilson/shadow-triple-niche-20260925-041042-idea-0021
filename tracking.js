/*
 * tracking.js — consent-gated pageview attribution for shadow-launcher pages.
 * Setup scope: consented-attribution__20261001-140140 (staging pilot, t0001).
 *
 * Normative sources (this file codes against NOTHING else):
 *   - Frozen backend contract §1 (frozen 2026-10-01T16:30Z):
 *     agent_docs/research/consented-attribution__20261001-140140/site-backend-agent/
 *     backend-contract__20261001-142148.md
 *   - Plan §5–§10 (behavioral states, storage contract, identity/visit rules,
 *     URL minimization, retry policy): agent_docs/plan/consented-attribution__20261001-140140/full.md
 *   - UI contract: agent_docs/research/consented-attribution__20261001-140140/
 *     ui-ux/consent-banner-spec__20261001-142148.md (surfaces, hooks, focus rules)
 *   - Final strings: marketing-copy/consent-privacy-wording__20261001-142148.md
 *     (banner/buttons/details/current-choice strings live in index.html; status
 *     wording per ui-ux §4.5)
 *
 * Sticky-overlay UI additions (consent-banner-sticky__20261002-145950, user
 * directive 2026-10-02): the banner is a fixed bottom overlay; the details
 * disclosure opens FULLSCREEN on compact viewports. Presentation-only changes:
 * fullscreen Close/focus choreography on the details toggle event, Escape to
 * close the fullscreen panel, a focus-scroll guard so a focused element is
 * never left behind the overlay, inert-background toggling scoped to the
 * mobile fullscreen view (robust cleanup — a close path can never leave the
 * page inert). Storage, receipts, retries, states and hooks are untouched.
 * All additions bind only in the config-gated activation path.
 *
 * Two-state contract:
 *  - Local engineering pages ship a comment-only tracking-config.js stub, so
 *    window.__SHADOW_TRACKING_CONFIG__ stays undefined — and file:// never
 *    qualifies. This script then does NOTHING: the banner stays hidden, no
 *    listeners bind, no storage is touched, no requests are made.
 *  - Deployed variants carry a real tracking-config.js; only then does the
 *    banner unhide, consent get recorded server-side, and pageviews ingest.
 *
 * Storage contract (plan §6): every key is namespaced by site id AND
 * environment —
 *   localStorage : shadow-analytics.<site>.<env>.pref | .identity | .queue | .revoke
 *   sessionStorage: shadow-analytics.<site>.<env>.session
 * The preference record stores ONLY {choice, noticeVersion, timestamp} — no
 * visitor id when declined. Identity stores {visitorId, receipt, expiresAt,
 * consentVersion, consentTime} only while accepted. The queue holds only
 * sanitized, already-minimized visit payloads (bounded). Never stored: emails,
 * form values, raw URLs with query/fragment, secrets. In-memory fallback when
 * storage access throws (plan §6) — no fingerprinting, no third-party cookies.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------ constants */

  var PREFERENCE_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days (plan §6/§12)
  var SESSION_IDLE_MS = 30 * 60 * 1000;              // 30-min sliding window (frozen §1.13)
  var RETRY_LIMIT = 3;                               // ≤3 retries per payload (plan §10.9)
  var RETRY_WINDOW_MS = 10 * 60 * 1000;              // within 10 minutes
  var RETRY_DELAYS_MS = [2000, 15000, 60000];        // bounded backoff; all inside the window
  var QUEUE_MAX = 5;                                 // bounded pending events (plan §6)
  var MAX_URL_CHARS = 2048;                          // contract §1.6.5
  var MAX_PARAM_VALUE = 256;                         // contract §1.6.5
  var APPROVED_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_id', 'utm_content', 'utm_term'];

  /* --------------------------------------------------------------- config */

  var cfg = null; // validated config; null → fully inert
  var pausedForReprompt = false; // material notice change: analytics stopped pending a fresh decision

  function validateConfig(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.enabled !== true) return null; // kill-switch level 3 (contract §1.12)
    if (typeof raw.endpoint !== 'string' || !/^https?:\/\//i.test(raw.endpoint)) return null;
    if (typeof raw.siteId !== 'string' || !raw.siteId || raw.siteId.length > 120) return null;
    if (typeof raw.environment !== 'string' || !raw.environment || raw.environment.length > 32) return null;
    if (typeof raw.noticeVersion !== 'string' || !raw.noticeVersion || raw.noticeVersion.length > 32) return null;
    return {
      endpoint: raw.endpoint.replace(/\/+$/, ''),
      siteId: raw.siteId,
      environment: raw.environment,
      noticeVersion: raw.noticeVersion
    };
  }

  function isFileProtocol() {
    try { return window.location.protocol === 'file:'; } catch (err) { return true; }
  }

  /* -------------------------------------------------------------- storage */

  function nsSegment(value) {
    return String(value).replace(/[^A-Za-z0-9_-]/g, '_');
  }

  /* Storage area wrapper: real storage when available, in-memory fallback
     otherwise (plan §6). One probe key inside the documented namespace. */
  function makeArea(native, probeKey) {
    var memory = {};
    var usable = null;
    function available() {
      if (usable !== null) return usable;
      try {
        native.setItem(probeKey, '1');
        native.removeItem(probeKey);
        usable = true;
      } catch (err) {
        usable = false;
      }
      return usable;
    }
    return {
      get: function (key) {
        if (available()) {
          try { return native.getItem(key); } catch (err) { usable = false; }
        }
        return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
      },
      set: function (key, value) {
        memory[key] = value;
        if (available()) {
          try { native.setItem(key, value); } catch (err) { usable = false; }
        }
      },
      remove: function (key) {
        delete memory[key];
        if (available()) {
          try { native.removeItem(key); } catch (err) { usable = false; }
        }
      }
    };
  }

  function readJson(area, key) {
    var raw = area.get(key);
    if (typeof raw !== 'string' || !raw) return null;
    try {
      var value = JSON.parse(raw);
      return value && typeof value === 'object' ? value : null;
    } catch (err) {
      return null;
    }
  }

  function writeJson(area, key, value) {
    try { area.set(key, JSON.stringify(value)); } catch (err) { /* in-memory fallback already applied */ }
  }

  var ls = null;  // localStorage area
  var ss = null;  // sessionStorage area
  var KEY_PREF, KEY_IDENTITY, KEY_QUEUE, KEY_REVOKE, KEY_SESSION;

  function buildKeys() {
    var ns = 'shadow-analytics.' + nsSegment(cfg.siteId) + '.' + nsSegment(cfg.environment);
    KEY_PREF = ns + '.pref';
    KEY_IDENTITY = ns + '.identity';
    KEY_QUEUE = ns + '.queue';
    KEY_REVOKE = ns + '.revoke';
    KEY_SESSION = ns + '.session'; // sessionStorage
  }

  /* ------------------------------------------------------------ random ids */

  /* Cryptographically random, charset [A-Za-z0-9_-], 22 chars (contract bounds:
     visitor/visit 8–64). No secure randomness → NO attribution at all (plan §7:
     never fall back to weak identifiers). */
  function randomId() {
    var cryptoObj = window.crypto;
    if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') return null;
    var bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return window.btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /* ------------------------------------------------------- URL sanitizer — */
  /* client half of frozen contract §1.6 (server re-sanitizes authoritatively) */

  function hasControlChars(value) {
    for (var i = 0; i < value.length; i++) {
      var code = value.charCodeAt(i);
      if (code <= 0x1f || code === 0x7f) return true;
    }
    return false;
  }

  function sanitizeUrl(href) {
    var parsed;
    try { parsed = new URL(href); } catch (err) { return { url: '', ok: false }; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { url: '', ok: false };

    // origin excludes userinfo by construction; pathname carries the path
    var kept = [];
    for (var i = 0; i < APPROVED_PARAMS.length; i++) {
      var key = APPROVED_PARAMS[i];
      var values = parsed.searchParams.getAll(key);
      if (!values.length) continue;
      var valid = [];
      for (var v = 0; v < values.length; v++) {
        var value = values[v];
        if (hasControlChars(value) || value.length > MAX_PARAM_VALUE) continue; // discarded, never hashed
        if (valid.indexOf(value) === -1) valid.push(value);
      }
      if (valid.length !== 1) continue; // none → discarded; conflicting duplicates → omit ALL (never first/last)
      kept.push(key + '=' + encodeURIComponent(valid[0])); // identical duplicates collapse to one
    }

    var rebuilt = parsed.origin + parsed.pathname + (kept.length ? '?' + kept.join('&') : '');
    if (rebuilt.length > MAX_URL_CHARS) {
      rebuilt = parsed.origin + parsed.pathname; // shed params before failing
      if (rebuilt.length > MAX_URL_CHARS) return { url: '', ok: false }; // honest absence, no fabrication
    }
    return { url: rebuilt, ok: true };
  }

  /* origin + path only — the minimized URL for declined/unknown/withdrawn
     contexts (frozen contract §1.7) */
  function minimizeUrl(href) {
    try {
      var parsed = new URL(href);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      return parsed.origin + parsed.pathname;
    } catch (err) {
      return '';
    }
  }

  function referrerOrigin() {
    try {
      if (!document.referrer) return '';
      var parsed = new URL(document.referrer);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      return parsed.origin; // origin/domain only — never paths or queries (plan §8)
    } catch (err) {
      return '';
    }
  }

  /* coarse device class only (plan §8): viewport bucket + primary language */
  function viewportBucket() {
    var width = window.innerWidth || 0;
    if (width < 480) return 'xs';
    if (width < 768) return 'sm';
    if (width < 1024) return 'md';
    if (width < 1440) return 'lg';
    return 'xl';
  }

  function primaryLanguage() {
    var lang = (navigator && navigator.language) || '';
    lang = String(lang);
    if (lang.length > 35) lang = lang.split('-')[0] || '';
    return lang.slice(0, 35);
  }

  /* ---------------------------------------------------- consent records */

  function loadPref() {
    var pref = readJson(ls, KEY_PREF);
    if (!pref || (pref.choice !== 'accepted' && pref.choice !== 'declined')) return null;
    if (typeof pref.noticeVersion !== 'string' || !pref.noticeVersion) return null;
    var ts = Number(pref.timestamp);
    if (!isFinite(ts) || (Date.now() - ts) > PREFERENCE_TTL_MS) return null; // 180-day expiry → re-prompt
    return pref;
  }

  function storePref(choice) {
    // Initial decline stores ONLY {choice, noticeVersion, timestamp} (plan §6/§10.8).
    writeJson(ls, KEY_PREF, { choice: choice, noticeVersion: cfg.noticeVersion, timestamp: Date.now() });
  }

  function loadIdentity() {
    var identity = readJson(ls, KEY_IDENTITY);
    if (!identity) return null;
    if (typeof identity.visitorId !== 'string' || !identity.visitorId) return null;
    if (typeof identity.receipt !== 'string' || !identity.receipt) return null;
    if (typeof identity.consentVersion !== 'string' || identity.consentVersion !== cfg.noticeVersion) return null;
    var expires = Date.parse(identity.expiresAt);
    if (!isFinite(expires) || expires <= Date.now()) return null; // expired locally → caller mints NEW (no bridging)
    return identity;
  }

  /* Shape + expiry only, any notice version — used where a stored identity must
     be reused or revoked across a notice-version change (contract §1.2: accept
     on an active row ROTATES the receipt and keeps the original expiry; the
     withdrawal path must capture the old-version receipt BEFORE clearing). */
  function loadIdentityAnyVersion() {
    var identity = readJson(ls, KEY_IDENTITY);
    if (!identity) return null;
    if (typeof identity.visitorId !== 'string' || !identity.visitorId) return null;
    if (typeof identity.receipt !== 'string' || !identity.receipt) return null;
    var expires = Date.parse(identity.expiresAt);
    if (!isFinite(expires) || expires <= Date.now()) return null;
    return identity;
  }

  function storeIdentity(visitorId, receipt, expiresAt) {
    writeJson(ls, KEY_IDENTITY, {
      visitorId: visitorId,
      receipt: receipt,
      expiresAt: expiresAt,
      consentVersion: cfg.noticeVersion,
      consentTime: new Date().toISOString()
    });
  }

  function clearIdentity() { ls.remove(KEY_IDENTITY); }
  function clearQueue() { ls.remove(KEY_QUEUE); }
  function clearRevoke() { ls.remove(KEY_REVOKE); }

  function fixedExpiry() {
    // Server expires_at is authoritative; this fallback is the same fixed 30-day
    // lifetime — never a rolling extension (plan §7).
    return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  }

  /* ------------------------------------------------------------- session */

  /* Tab-scoped analytics session (frozen §1.13): activity = pageview ingestion
     or a signup submission carrying analytics context ONLY. 30-minute sliding
     inactivity window; expired/absent → rotate to a NEW session id before the
     next measured event. An already-persisted visit's session is never rewritten. */
  function loadSession() {
    var session = readJson(ss, KEY_SESSION);
    var now = Date.now();
    var last = session ? Number(session.lastActivity) : NaN;
    if (!session || typeof session.sessionId !== 'string' || !session.sessionId ||
        !isFinite(last) || (now - last) > SESSION_IDLE_MS) {
      var fresh = randomId();
      if (!fresh) return null;
      session = { sessionId: fresh, lastActivity: now };
    } else {
      session.lastActivity = now;
    }
    writeJson(ss, KEY_SESSION, session);
    return session;
  }

  function touchSession() {
    var session = readJson(ss, KEY_SESSION);
    if (session && typeof session.sessionId === 'string' && isFinite(Number(session.lastActivity)) &&
        (Date.now() - Number(session.lastActivity)) <= SESSION_IDLE_MS) {
      session.lastActivity = Date.now();
      writeJson(ss, KEY_SESSION, session);
    }
  }

  /* ---------------------------------------------------------------- API */

  function postJson(path, bodyString, keepalive) {
    return fetch(cfg.endpoint + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyString,
      keepalive: !!keepalive
    }).then(function (response) {
      return response.json().then(
        function (json) { return { status: response.status, json: json }; },
        function () { return { status: response.status, json: null }; }
      );
    });
  }

  function consentBody(op, visitorId, receipt) {
    var body = {
      op: op,
      site_id: cfg.siteId,
      purpose: 'analytics',
      visitor_id: visitorId,
      consent_version: cfg.noticeVersion,
      consent_time: new Date().toISOString()
    };
    if (op === 'withdraw' && receipt) body.receipt = receipt; // required iff withdraw (contract §1.2)
    return JSON.stringify(body);
  }

  /* --------------------------------------------------------- visit queue */

  var scheduledRetries = {};      // visitId → true while a retry timer is pending
  var currentPageVisit = null;    // { visitId, state: 'sending'|'sent'|'stopped' }

  function loadQueue() {
    var queue = readJson(ls, KEY_QUEUE);
    if (!Array.isArray(queue)) return [];
    return queue.filter(function (item) {
      return item && typeof item.payload === 'string' && typeof item.visitId === 'string' &&
        isFinite(Number(item.firstAttempt)) &&
        (Date.now() - Number(item.firstAttempt)) <= RETRY_WINDOW_MS &&
        Number(item.retries) <= RETRY_LIMIT;
    });
  }

  function saveQueue(queue) { writeJson(ls, KEY_QUEUE, queue); }

  function enqueueVisit(payloadString, visitId) {
    var queue = loadQueue();
    if (queue.length >= QUEUE_MAX) queue.shift(); // bounded (plan §6)
    queue.push({ payload: payloadString, visitId: visitId, firstAttempt: Date.now(), retries: 0 });
    saveQueue(queue);
  }

  function removeFromQueue(visitId) {
    saveQueue(loadQueue().filter(function (item) { return item.visitId !== visitId; }));
  }

  /* Returns 'sent' | 'stopped' | 'retry'. Byte-identical payloads are retried
     with the SAME visit_id (idempotent server-side; contract §1.3). */
  function sendVisit(payloadString, visitId, keepalive) {
    return postJson('/api/v1/analytics/visits', payloadString, keepalive)
      .then(function (result) {
        if (result.status === 200) return 'sent';
        if (result.status === 403 || result.status === 409 || result.status === 413 || result.status === 422) {
          var reason = result.json && result.json.reason;
          // Dead identity/receipt (incl. receipt rotated elsewhere) → clear the
          // stored identity so the next activation mints a fresh lifecycle.
          if (reason === 'receipt_expired' || reason === 'receipt_withdrawn' ||
              reason === 'unknown_receipt' || reason === 'visitor_mismatch') {
            clearIdentity();
            if (currentPageVisit && currentPageVisit.visitId === visitId) currentPageVisit.state = 'stopped';
          }
          return 'stopped'; // semantic rejection: never retried
        }
        return 'retry'; // network failure surfaces as rejection below; 429/5xx land here
      })
      .catch(function () { return 'retry'; }); // network failure (fetch rejects)
  }

  function scheduleNextRetry(visitId) {
    delete scheduledRetries[visitId];
    var item = null;
    var queue = loadQueue();
    for (var i = 0; i < queue.length; i++) {
      if (queue[i].visitId === visitId) item = queue[i];
    }
    if (!item) return;
    if (pausedForReprompt || !loadIdentity() || item.retries >= RETRY_LIMIT ||
        (Date.now() - item.firstAttempt) >= RETRY_WINDOW_MS) {
      removeFromQueue(visitId); // refusal/withdrawal/expiry → discard (plan §10.9)
      return;
    }
    scheduledRetries[visitId] = true;
    window.setTimeout(function () {
      delete scheduledRetries[visitId];
      if (pausedForReprompt || !loadIdentity()) { removeFromQueue(visitId); return; }
      sendVisit(item.payload, visitId, false).then(function (outcome) {
        if (outcome === 'sent' || outcome === 'stopped') { removeFromQueue(visitId); return; }
        item.retries += 1;
        saveQueue(loadQueue().map(function (q) { return q.visitId === visitId ? item : q; }));
        scheduleNextRetry(visitId);
      });
    }, RETRY_DELAYS_MS[Math.min(item.retries, RETRY_DELAYS_MS.length - 1)]);
  }

  function schedulePendingQueue() {
    loadQueue().forEach(function (item) {
      if (!scheduledRetries[item.visitId]) scheduleNextRetry(item.visitId);
    });
  }

  /* --------------------------------------------------------- pageviews */

  function buildVisitPayload() {
    var identity = loadIdentity();
    if (!identity) return null;
    var session = loadSession();
    if (!session) return null;
    var sanitized = sanitizeUrl(window.location.href);
    if (!sanitized.ok) return null; // unparseable/oversized → honest absence (plan §8)
    var visitId = randomId();
    if (!visitId) return null;
    var payload = {
      site_id: cfg.siteId,
      receipt: identity.receipt,
      visitor_id: identity.visitorId,
      visit_id: visitId,
      session_id: session.sessionId,
      page_url: sanitized.url,
      referrer: referrerOrigin(),
      device: { viewport_bucket: viewportBucket(), language: primaryLanguage() },
      client_time: new Date().toISOString()
    };
    return { visitId: visitId, body: JSON.stringify(payload) };
  }

  /* One pageview occurrence: first activated document after valid consent,
     reload, and BFCache restoration (plan §7). NOT: focus, scroll, banner
     reopen, anchor navigation, unactivated prerender. */
  function sendCurrentPageview() {
    var pref = loadPref();
    if (pausedForReprompt || !pref || pref.choice !== 'accepted') return;
    if (typeof document.prerendering === 'boolean' && document.prerendering) {
      var onActivate = function () {
        document.removeEventListener('prerenderingchange', onActivate);
        sendCurrentPageview();
      };
      document.addEventListener('prerenderingchange', onActivate);
      return;
    }
    var built = buildVisitPayload();
    if (!built) return;
    currentPageVisit = { visitId: built.visitId, state: 'sending' };
    sendVisit(built.body, built.visitId, true).then(function (outcome) {
      if (outcome === 'sent') {
        if (currentPageVisit && currentPageVisit.visitId === built.visitId) currentPageVisit.state = 'sent';
        return;
      }
      if (outcome === 'stopped') {
        if (currentPageVisit && currentPageVisit.visitId === built.visitId) currentPageVisit.state = 'stopped';
        return;
      }
      enqueueVisit(built.body, built.visitId); // transient failure → bounded retries
      scheduleNextRetry(built.visitId);
    });
  }

  /* ------------------------------------------------------- consent flows */

  function activateAccept() {
    storePref('accepted'); // choice survives receipt failure (plan §10.6: no false analytics success)
    pausedForReprompt = false;
    var identity = loadIdentityAnyVersion(); // reuse across a notice-version change (receipt rotates)
    var visitorId = identity ? identity.visitorId : null;

    function finish(id) {
      storeIdentity(id.visitorId, id.receipt, id.expiresAt);
      sendCurrentPageview();
      schedulePendingQueue();
      refreshFooter();
    }

    function attempt(tryVisitorId, retriesLeft, rotated) {
      postJson('/api/v1/analytics/consent', consentBody('accept', tryVisitorId, null), retriesLeft === RETRY_LIMIT)
        .then(function (result) {
          if (result.status === 200 && result.json && result.json.ok && typeof result.json.receipt === 'string') {
            finish({
              visitorId: tryVisitorId,
              receipt: result.json.receipt,
              expiresAt: typeof result.json.expires_at === 'string' ? result.json.expires_at : fixedExpiry()
            });
            return;
          }
          var reason = result.json && result.json.reason;
          if (result.status === 409 && (reason === 'visitor_withdrawn' || reason === 'visitor_expired')) {
            // Dead identity → mint a NEW visitor id; no bridging to the old
            // identity (contract §1.4; dispatch item 7). One rotation only.
            if (!rotated) {
              var fresh = randomId();
              if (fresh) { attempt(fresh, RETRY_LIMIT, true); return; }
            }
            clearIdentity();
            refreshFooter();
            return;
          }
          if (result.status === 403 || result.status === 422 || result.status === 413) {
            // 403 analytics_disabled (kill switch) and schema rejections: stop
            // quietly — choice stays stored, no identity, no sends, signup unaffected.
            clearIdentity();
            refreshFooter();
            return;
          }
          if (retriesLeft > 0) { // 429 / 5xx / network failure → bounded retries
            window.setTimeout(function () { attempt(tryVisitorId, retriesLeft - 1, rotated); },
              RETRY_DELAYS_MS[Math.min(RETRY_LIMIT - retriesLeft, RETRY_DELAYS_MS.length - 1)]);
            return;
          }
          clearIdentity(); // gave up quietly; no identity, no false success
          refreshFooter();
        })
        .catch(function () {
          if (retriesLeft > 0) {
            window.setTimeout(function () { attempt(tryVisitorId, retriesLeft - 1, rotated); },
              RETRY_DELAYS_MS[Math.min(RETRY_LIMIT - retriesLeft, RETRY_DELAYS_MS.length - 1)]);
            return;
          }
          clearIdentity();
          refreshFooter();
        });
    }

    if (!visitorId) {
      visitorId = randomId();
      if (!visitorId) { clearIdentity(); refreshFooter(); return; } // no secure randomness → no attribution
    }
    attempt(visitorId, RETRY_LIMIT, false);
  }

  function activateRemembered() {
    if (loadIdentity()) {
      // Remembered valid acceptance: ingest the current page (fixed 30-day
      // expiry already validated by loadIdentity; NO rolling extension).
      sendCurrentPageview();
      schedulePendingQueue();
      return;
    }
    // Identity expired/missing/rotated: mint a NEW lifecycle silently (dispatch
    // item 7) — the stored choice stays valid; no banner re-prompt.
    clearIdentity();
    activateAccept();
  }

  /* Withdrawal (plan §10.8): stop locally FIRST (pause + clear queue +
     identity), then attempt the minimal revocation call with the receipt.
     Tolerates failure; never replays events; never stores an event queue. */
  function withdraw() {
    var identity = loadIdentityAnyVersion(); // capture the (any-version) receipt BEFORE clearing
    var receipt = identity ? identity.receipt : null;
    var visitorId = identity ? identity.visitorId : null;
    clearQueue();
    clearIdentity();
    ss.remove(KEY_SESSION); // the tab-scoped analytics session id is an analytics identifier too
    storePref('declined'); // post-withdrawal stored state is "declined" (copy S5)
    currentPageVisit = null;
    if (receipt && visitorId) attemptRevocation(consentBody('withdraw', visitorId, receipt), Date.now(), 0);
    refreshFooter();
  }

  function attemptRevocation(body, startedAt, retries) {
    var record = { body: body, firstAttempt: startedAt, retries: retries };
    writeJson(ls, KEY_REVOKE, record);
    var giveUp = function () { clearRevoke(); }; // tolerated failure — best effort
    var done = function () { clearRevoke(); };
    var again = function () {
      var next = retries + 1;
      if (next > RETRY_LIMIT || (Date.now() - startedAt) >= RETRY_WINDOW_MS) { giveUp(); return; }
      window.setTimeout(function () { attemptRevocation(body, startedAt, next); },
        RETRY_DELAYS_MS[Math.min(next - 1, RETRY_DELAYS_MS.length - 1)]);
    };
    postJson('/api/v1/analytics/consent', body, retries === 0)
      .then(function (result) {
        if (result.status >= 200 && result.status < 300) { done(); return; } // incl. 200 revoked=false (no oracle)
        if (result.status === 403 || result.status === 422 || result.status === 413) { done(); return; }
        again();
      })
      .catch(again);
  }

  function resumeRevocation() {
    var record = readJson(ls, KEY_REVOKE);
    if (!record || typeof record.body !== 'string') { clearRevoke(); return; }
    var started = Number(record.firstAttempt);
    if (!isFinite(started) || (Date.now() - started) >= RETRY_WINDOW_MS ||
        Number(record.retries) > RETRY_LIMIT) { clearRevoke(); return; }
    attemptRevocation(record.body, started, Number(record.retries) || 0);
  }

  /* --------------------------------------------- signup attribution API */

  /* In-memory interface signup.js may call (dispatch item 5). Exposed ONLY
     after a valid config activates this script; signup.js treats absence/
     failures as "unknown" and never depends on it. */
  function getSignupContext() {
    var context = {
      available: true,
      state: 'unknown',
      consentVersion: null,
      receipt: null,
      visitorId: null,
      sessionId: null,
      visitId: null,
      sourceUrl: minimizeUrl(window.location.href) // origin + path only
    };
    var pref = loadPref();
    if (!pref || pref.noticeVersion !== cfg.noticeVersion || pausedForReprompt) return context;
    if (pref.choice === 'declined') {
      context.state = 'declined'; // also the state after withdrawal (copy S5)
      return context;
    }
    var identity = loadIdentity();
    if (!identity) return context; // no coherent context → honest "unknown", never accepted-without-receipt
    context.state = 'accepted';
    context.consentVersion = cfg.noticeVersion;
    context.receipt = identity.receipt;
    context.visitorId = identity.visitorId;
    var session = readJson(ss, KEY_SESSION);
    if (session && typeof session.sessionId === 'string') context.sessionId = session.sessionId;
    if (currentPageVisit && currentPageVisit.state !== 'stopped') {
      context.visitId = currentPageVisit.visitId; // conversion-visit reference (pending is a designed race)
    }
    var sanitized = sanitizeUrl(window.location.href);
    if (sanitized.ok) context.sourceUrl = sanitized.url; // approved params kept when accepted (§1.6/§1.7)
    return context;
  }

  function noteSignupActivity() {
    if (!cfg) return;
    touchSession(); // signup submission with analytics context = activity (frozen §1.13)
  }

  /* -------------------------------------------------------------- UI */

  function byHook(hook) { return document.querySelector('[data-' + hook + ']'); }

  var banner, allowBtn, declineBtn, currentLine, toggleBtn, closeBtn,
      footerPrivacy, reopenBtn, stateText, statusLine, bannerTitle;
  /* Sticky-overlay additions (consent-banner-sticky__20261002-145950) */
  var detailsEl, detailsSummary, detailsCloseBtn, bannerInner;
  var inertTargets = [];        // body children frozen out while the fullscreen panel is open
  var suppressDetailsFocus = false; // programmatic detail-close must not steal closeSurface's focus

  function setHidden(el, hidden) {
    if (!el) return;
    if (hidden) el.setAttribute('hidden', '');
    else el.removeAttribute('hidden');
  }

  function refreshFooter() {
    var pref = loadPref();
    var surfaceOpen = banner && !banner.hasAttribute('hidden');
    if (!pref) {
      setHidden(footerPrivacy, true);
      if (stateText) stateText.textContent = '';
      return;
    }
    setHidden(footerPrivacy, surfaceOpen); // hidden while the surface is open (one control set)
    if (stateText) stateText.textContent = pref.choice === 'accepted' ? 'Analytics: On' : 'Analytics: Off';
  }

  function showBannerDecision() {
    setHidden(banner, false);
    setHidden(allowBtn, false);
    setHidden(declineBtn, false);
    setHidden(currentLine, true);
    setHidden(toggleBtn, true);
    setHidden(closeBtn, true);
    refreshFooter();
    // No focus move on load (ui-ux §8.3: no unsolicited focus steal).
  }

  function showBannerManager(pref) {
    setHidden(banner, false);
    setHidden(allowBtn, true);
    setHidden(declineBtn, true);
    setHidden(currentLine, false);
    if (currentLine) currentLine.textContent = pref.choice === 'accepted' ? 'Analytics: allowed' : 'Analytics: declined';
    setHidden(toggleBtn, false);
    if (toggleBtn) toggleBtn.textContent = pref.choice === 'accepted' ? 'Turn off analytics' : 'Turn on analytics';
    setHidden(closeBtn, false);
    refreshFooter();
  }

  function closeSurface() {
    resetDetailsSurface(); // sticky-overlay safety: never leave inert/fullscreen chrome behind
    setHidden(banner, true);
    refreshFooter();
    if (footerPrivacy && !footerPrivacy.hasAttribute('hidden') && reopenBtn) {
      reopenBtn.focus(); // focus never lands on a removed/hidden node (ui-ux §8.3)
    }
  }

  function announce(text) {
    if (statusLine) statusLine.textContent = text; // visually-hidden role="status" in the footer
  }

  function onAllow() {
    activateAccept();
    closeSurface();
    announce('Analytics preference saved: On'); // describes the stored preference only — never measurement success
  }

  function onDecline() {
    var pref = loadPref();
    if (pref && pref.choice === 'accepted') {
      withdraw(); // declining a previously accepted notice = withdrawal (stop + best-effort revoke)
    } else {
      clearIdentity(); // nothing to revoke; ensure no stale identity remains
      storePref('declined'); // LOCAL ONLY — no server call, no identifier (contract §1.4)
      refreshFooter();
    }
    pausedForReprompt = false;
    closeSurface();
    announce('Analytics preference saved: Off');
  }

  function onReopen() {
    var pref = loadPref();
    if (!pref) return; // control only exists once a choice is stored
    showBannerManager(pref);
    if (bannerTitle) bannerTitle.focus(); // user-initiated reveal (ui-ux §8.3)
  }

  function onClose() {
    closeSurface(); // display toggle only — never a visit, event, or request (ui-ux §4.4)
  }

  function onToggle() {
    var pref = loadPref();
    if (!pref) return;
    if (pref.choice === 'accepted') {
      withdraw();
      announce('Analytics preference saved: Off');
    } else {
      activateAccept(); // fresh lifecycle: new visitor id, new receipt
      announce('Analytics preference saved: On');
    }
    pausedForReprompt = false;
    closeSurface();
  }

  /* ---------------- sticky-overlay additions (consent-banner-sticky__20261002-145950) ----------------
     Config-gated: called only from bindUi()/init() after a valid enabled
     config, so inert local pages keep zero listeners with effects. The
     details disclosure opens as a fullscreen fixed panel on compact
     viewports (CSS-only mode switch); fullscreen mode is detected from the
     Close control's computed display — read ONLY while the details is open,
     so the unrendered closed state can never be misread. */

  function isFullscreenPanelMode() {
    if (!detailsCloseBtn) return false;
    try {
      return window.getComputedStyle(detailsCloseBtn).display !== 'none';
    } catch (err) {
      return false;
    }
  }

  function focusEl(el) {
    if (!el) return;
    try { el.focus(); } catch (err) { /* focus is best-effort */ }
  }

  /* While the mobile fullscreen panel is open the background page becomes
     non-focusable (user-directed deviation from the plan's non-modal
     preference, scoped to the fullscreen view; desktop inline stays fully
     non-modal). Targets are the body's direct element children except the
     banner itself (covers main, footer, header and skip links). */
  function setSurfaceInert(active) {
    for (var i = 0; i < inertTargets.length; i++) {
      try {
        if (active) inertTargets[i].setAttribute('inert', '');
        else inertTargets[i].removeAttribute('inert');
      } catch (err) { /* keep going — restore every node */ }
    }
  }

  /* Focus choreography on the details toggle event (ui-ux §8.3: a
     user-initiated reveal may move focus; focus must never land on a
     hidden/removed node). Open on mobile → focus the fullscreen Close
     control; close (any mode) → restore focus to the summary. Desktop inline
     open/close keeps the native no-move behavior. */
  function onDetailsToggle() {
    if (!detailsEl || !banner) return;
    var open = detailsEl.hasAttribute('open');
    try {
      if (open && isFullscreenPanelMode()) {
        banner.classList.add('consent-banner--details-open'); // CSS hides the compact bar
        setSurfaceInert(true);
        focusEl(detailsCloseBtn);
      } else {
        banner.classList.remove('consent-banner--details-open');
        setSurfaceInert(false);
        if (!open && !suppressDetailsFocus) focusEl(detailsSummary);
      }
    } finally {
      if (!open) {
        suppressDetailsFocus = false;
        setSurfaceInert(false); // guarantee: no close path can leave the page inert
      }
    }
  }

  function onDetailsCloseClick() {
    if (!detailsEl) return;
    suppressDetailsFocus = false; // user-initiated close: the toggle restores focus to the summary
    detailsEl.removeAttribute('open');
  }

  /* Escape closes the fullscreen DETAILS panel only — never the decision or
     manager surface (ui-ux §9: the unset banner's only exits are Allow,
     Decline, or leaving; the manager Close is deliberate). */
  function onDocumentKeydown(event) {
    if (!event || (event.key !== 'Escape' && event.key !== 'Esc')) return;
    if (!detailsEl || !detailsEl.hasAttribute('open') || !isFullscreenPanelMode()) return;
    onDetailsCloseClick();
  }

  /* Focus-scroll guard: with a fixed bottom overlay, a browser's native
     scroll-into-view can leave the focused element behind the banner. When a
     newly focused element would be obscured by the card, scroll its nearest
     scrollable ancestor up just enough to clear it (plan §6 / ui-ux §8.3:
     a focused element is never left obscured). Banner-internal elements
     always clear (they live in the overlay). */
  function scrollableAncestorOf(el) {
    var node = el;
    while (node) {
      if (node === document.body || node === document.documentElement) {
        return document.scrollingElement || document.documentElement;
      }
      if (typeof node.getBoundingClientRect === 'function') {
        var style = window.getComputedStyle(node);
        var overflowY = style && style.overflowY;
        if ((overflowY === 'auto' || overflowY === 'scroll') &&
            node.scrollHeight > node.clientHeight + 1) {
          return node;
        }
      }
      node = node.parentElement;
    }
    return document.scrollingElement || null;
  }

  function onFocusScrollGuard(event) {
    if (!banner || !bannerInner || banner.hasAttribute('hidden')) return;
    var target = event && event.target;
    if (!target || typeof target.getBoundingClientRect !== 'function') return;
    if (banner.contains(target)) return; // the overlay's own controls are never behind it
    var card = bannerInner.getBoundingClientRect();
    if (!card || card.width === 0 || card.top >= (window.innerHeight || document.documentElement.clientHeight)) return;
    var rect = target.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    // obscured only if the element's rect actually intersects the card
    var obscured = rect.bottom > card.top && rect.top < card.bottom &&
                   rect.right > card.left && rect.left < card.right;
    if (!obscured) return;
    var scroller = scrollableAncestorOf(target);
    if (!scroller) return;
    // Scrolling DOWN moves the element up, out from behind the bottom-anchored
    // card. Scroll only as far as needed (+8px keeps the focus outline clear
    // of the card edge), never push the element's own top off-screen, and
    // never beyond the scroller's end — at the page's absolute bottom nothing
    // can scroll further, which is the accepted bottom-edge tradeoff while
    // the surface is open (plan §6 amendment); the guard then simply stands
    // down instead of scrolling away from the element.
    var overlap = (rect.bottom + 8) - card.top;
    var maxScroll = 0;
    try { maxScroll = scroller.scrollHeight - scroller.clientHeight; } catch (err) { maxScroll = 0; }
    var roomBelow = maxScroll - scroller.scrollTop;
    var headroom = Math.min(overlap, rect.top, roomBelow);
    if (headroom <= 0) return;
    try { scroller.scrollTop += headroom; } catch (err) { /* scrolling is best-effort */ }
  }

  /* Viewport flips while the details is open must keep the chrome invariant:
     after ANY flip, an open panel on a compact viewport always carries the
     fullscreen chrome (class + inert background) and on a desktop viewport
     never does (the CSS chrome follows the media query; the class/inert/focus
     state is JS-owned and would otherwise go stale until a close path heals
     it). Flipping INTO fullscreen adopts the chrome — class, inert background
     and focus on the Close control — so the reader keeps their place (the
     summary they were on becomes visibility:hidden, so Close is the correct
     focus target, never a hidden node). Flipping to desktop leaves the
     disclosure open inline, drops the chrome and restores focus to the
     summary. Idempotent under the rapid resize events a drag produces. */
  function reconcileViewportMode() {
    if (!detailsEl || !detailsEl.hasAttribute('open')) return;
    if (isFullscreenPanelMode()) {
      if (banner && !banner.classList.contains('consent-banner--details-open')) {
        banner.classList.add('consent-banner--details-open');
        setSurfaceInert(true);
        focusEl(detailsCloseBtn);
      }
      return;
    }
    if (banner) banner.classList.remove('consent-banner--details-open');
    setSurfaceInert(false);
    focusEl(detailsSummary);
  }

  /* Safety reset for closeSurface: whatever path closes the surface, the page
     must never stay inert and the fullscreen chrome must never stay stuck. */
  function resetDetailsSurface() {
    if (banner) banner.classList.remove('consent-banner--details-open');
    setSurfaceInert(false);
    if (detailsEl && detailsEl.hasAttribute('open')) {
      suppressDetailsFocus = true; // closeSurface owns focus restoration
      detailsEl.removeAttribute('open'); // async toggle clears the flag without stealing focus
    }
  }

  function bindUi() {
    if (allowBtn) allowBtn.addEventListener('click', onAllow);
    if (declineBtn) declineBtn.addEventListener('click', onDecline);
    if (reopenBtn) reopenBtn.addEventListener('click', onReopen);
    if (closeBtn) closeBtn.addEventListener('click', onClose);
    if (toggleBtn) toggleBtn.addEventListener('click', onToggle);
    /* Sticky-overlay additions: document-level listeners early-return while
       the banner is hidden or the panel closed, so they are inert without an
       activated config and after every close. */
    if (detailsEl) {
      detailsEl.addEventListener('toggle', onDetailsToggle);
      if (detailsCloseBtn) detailsCloseBtn.addEventListener('click', onDetailsCloseClick);
      document.addEventListener('keydown', onDocumentKeydown);
    }
    document.addEventListener('focusin', onFocusScrollGuard);
    window.addEventListener('resize', reconcileViewportMode);
  }

  /* ------------------------------------------------------------- init */

  function init() {
    var raw = window.__SHADOW_TRACKING_CONFIG__; // undefined locally (comment-only stub)
    if (isFileProtocol()) return; // file:// engineering pages stay fully inert
    cfg = validateConfig(raw);
    if (!cfg) return; // undefined/invalid/disabled → banner never unhides, no storage, no requests
    if (!window.crypto || typeof window.crypto.getRandomValues !== 'function') return; // no secure randomness → no attribution

    ls = makeArea(window.localStorage, 'shadow-analytics.' + nsSegment(cfg.siteId) + '.' + nsSegment(cfg.environment) + '.probe');
    ss = makeArea(window.sessionStorage, 'shadow-analytics.' + nsSegment(cfg.siteId) + '.' + nsSegment(cfg.environment) + '.probe-s');
    buildKeys();

    banner = byHook('consent-banner');
    allowBtn = byHook('consent-allow');
    declineBtn = byHook('consent-decline');
    currentLine = byHook('consent-current');
    toggleBtn = byHook('consent-toggle');
    closeBtn = byHook('consent-close');
    footerPrivacy = byHook('footer-privacy');
    reopenBtn = byHook('consent-reopen');
    stateText = byHook('consent-state');
    statusLine = byHook('consent-status');
    bannerTitle = document.getElementById('consent-banner-title');

    /* Sticky-overlay additions (consent-banner-sticky__20261002-145950):
       resolve the disclosure nodes and freeze the inert target list once —
       the DOM is static from here on. Targets: every direct element child of
       <body> except the banner itself (scripts excluded). */
    detailsEl = byHook('consent-details');
    detailsCloseBtn = byHook('consent-details-close');
    detailsSummary = detailsEl ? detailsEl.querySelector('summary') : null;
    bannerInner = banner ? banner.querySelector('.consent-banner__inner') : null;
    inertTargets = [];
    var bodyChildren = document.body.children;
    for (var i = 0; i < bodyChildren.length; i++) {
      var node = bodyChildren[i];
      if (node !== banner && node.tagName !== 'SCRIPT') inertTargets.push(node);
    }

    resumeRevocation();

    var pref = loadPref();
    if (!pref || pref.noticeVersion !== cfg.noticeVersion) {
      if (pref && pref.choice === 'accepted') {
        pausedForReprompt = true; // material notice change: collection paused pending a fresh decision (plan §10.7)
      }
      showBannerDecision();
    } else if (pref.choice === 'accepted') {
      refreshFooter();
      activateRemembered();
    } else {
      refreshFooter(); // declined (or post-withdrawal)
    }

    bindUi();

    // BFCache restoration is its own pageview occurrence (plan §7); focus/scroll
    // and ordinary tab switches are NOT.
    window.addEventListener('pageshow', function (event) {
      if (!event || !event.persisted) return;
      var current = loadPref();
      if (!current || current.noticeVersion !== cfg.noticeVersion || pausedForReprompt) return;
      if (current.choice !== 'accepted') return;
      sendCurrentPageview();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* Expose the attribution interface signup.js may call (dispatch item 5),
     guarded so it behaves identically whether or not this script activated:
     without a valid config it reports the honest "unknown" state with the
     minimized origin+path URL — the same posture signup.js itself falls back
     to when tracking.js is absent or blocked. It NEVER performs storage or
     network work outside an activated config. */
  window.__SHADOW_ATTRIBUTION__ = {
    getSignupContext: function () {
      if (!cfg) {
        return {
          available: true,
          state: 'unknown',
          consentVersion: null,
          receipt: null,
          visitorId: null,
          sessionId: null,
          visitId: null,
          sourceUrl: minimizeUrl(window.location.href)
        };
      }
      return getSignupContext();
    },
    noteSignupActivity: function () {
      if (cfg) noteSignupActivity();
    }
  };
})();