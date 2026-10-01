/*
 * signup.js — config-gated signup form handler for the Quoteleg local page
 * (idea-0021, session triple-niche__20260925-041042; production rollout of
 * the consented-analytics revision, session
 * consented-attribution__20261001-140140).
 * Normative contract: docs/backend-architecture.md §12 (frontend), §7 (API);
 * analytics additions per the frozen backend contract
 * (backend-contract__20261001-142148.md §1.7) and plan §10.5/§10.10.
 *
 * Two-state contract:
 *  - Local engineering pages ship a comment-only signup-config.js stub, so
 *    window.__SHADOW_SIGNUP_CONFIG__ stays undefined. Every submit attempt then
 *    does nothing — no fetch, no storage, no external request, no message, ever.
 *    (The only work at load is binding two listeners that no-op without a live
 *    config; the config is read lazily on each submit attempt.)
 *  - Deployed variants carry a real signup-config.js; only then does a submit
 *    collect form fields, optionally run reCAPTCHA Enterprise, and POST once to
 *    config.backendUrl + /api/v1/signups.
 *
 * Analytics context (consent-aware clients): when tracking.js is present it
 * exposes window.__SHADOW_ATTRIBUTION__; this handler asks it for the current
 * permitted context and adds the additive top-level `analytics` object
 * (consent_state + identifiers only when accepted). signup.js NEVER depends on
 * tracking.js loading or succeeding: absent/blocked/failed tracking falls back
 * to consent_state "unknown" with a minimized origin+path source_url, exactly
 * the frozen refusal/unknown posture. When tracking.js is present, source_url
 * is its sanitized URL (approved campaign params kept when accepted) or
 * origin+path only otherwise.
 *
 * Post-submit states (2026-09-26 messaging directive + 2026-10-01 success-state
 * directive): 200 → status shows exactly "You're on the list" and the email
 * input and submit button are DISABLED — never removed or hidden — so the
 * layout never shifts (the status region reserves its line). Failures keep the
 * form enabled for retry with distinct messages per failure kind: 422 names
 * what to check (never the generic wording — this port wires the previously
 * missing 422 branch flagged in marketing-copy
 * production-adaptation__20261001-185702.md §5), 429 rate-limit wording,
 * 400 captcha wording, captcha/network failures their own wording (the
 * distinct network message is part of the same wiring fix). Error strings are
 * this page's adopted staging set (adaptation report §5, verbatim).
 *
 * Never: cookies, localStorage/sessionStorage, analytics of its own, or any
 * request other than the reCAPTCHA loader (live + captchaRequired only) and the
 * signup POST. (Storage used by consent analytics lives in tracking.js, which
 * never runs without its own live config.)
 */
(function () {
  'use strict';

  var inflight = new WeakSet(); // per-form single-flight guard
  var sessionId = null; // generated lazily, once per page load
  var recaptchaPromise = null; // module-level guard: loader injected at most once
  var ANALYTICS_STATES = ['accepted', 'declined', 'unknown', 'withdrawn'];

  /* Returns the live config, or null when absent/malformed (→ inert page). */
  function getConfig() {
    var config = window.__SHADOW_SIGNUP_CONFIG__;
    if (!config || typeof config !== 'object') return null;
    if (typeof config.backendUrl !== 'string' || !config.backendUrl) return null;
    return config;
  }

  /* session_id — one per page load (server schema limit: 64 chars). */
  function ensureSessionId() {
    if (sessionId) return sessionId;
    var crypto = window.crypto;
    if (crypto && typeof crypto.randomUUID === 'function') {
      sessionId = crypto.randomUUID();
    } else if (crypto && typeof crypto.getRandomValues === 'function') {
      var bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      sessionId = Array.prototype.map.call(bytes, function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
    } else {
      sessionId = 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
    }
    return sessionId;
  }

  /* Collect ALL named fields into form_data — the server stores it as-received
     (§6). Text-like values are trimmed; a single checkbox → boolean; checkboxes
     sharing a name → array of checked values; radios → checked value, omitted
     when none is checked. File inputs and buttons are skipped. */
  function collectFormData(form) {
    var groups = Object.create(null);
    Array.prototype.forEach.call(form.elements, function (el) {
      var tag = el.tagName;
      var type = (el.type || '').toLowerCase();
      if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') return;
      if (!el.name) return;
      if (type === 'file' || type === 'submit' || type === 'button' ||
          type === 'reset' || type === 'image') return;
      (groups[el.name] = groups[el.name] || []).push(el);
    });

    var data = {};
    Object.keys(groups).forEach(function (name) {
      var els = groups[name];
      var first = els[0];
      var type = (first.type || '').toLowerCase();

      if (type === 'radio') {
        for (var i = 0; i < els.length; i++) {
          if (els[i].checked) { data[name] = els[i].value; break; }
        }
      } else if (type === 'checkbox') {
        if (els.length === 1) {
          data[name] = first.checked; // boolean
        } else {
          data[name] = els.filter(function (el) { return el.checked; })
            .map(function (el) { return el.value; });
        }
      } else if (first.tagName === 'SELECT' && first.multiple) {
        data[name] = Array.prototype.filter.call(first.options, function (opt) {
          return opt.selected;
        }).map(function (opt) { return opt.value; });
      } else {
        data[name] = first.value.trim();
      }
    });
    return data;
  }

  /* email is OPTIONAL (§7): the top-level key is included only when a non-empty
     value exists. Prefer the first input[type=email]; else the first collected
     field whose name mentions "email" and holds a string value (booleans and
     arrays from checkboxes never become the email). */
  function extractEmail(form, formData) {
    var input = form.querySelector('input[type="email"]');
    var value = input && typeof input.value === 'string' ? input.value : '';
    if (!value) {
      var name = Object.keys(formData).find(function (key) {
        return /email/i.test(key) && typeof formData[key] === 'string';
      });
      if (name) value = formData[name];
    }
    value = (value || '').trim();
    return value || null;
  }

  /* ---------------------------------------------------------------------
     Consent-aware analytics context (frozen backend contract §1.7).
     Default posture when tracking.js is absent/blocked/failed: consent_state
     "unknown" and a minimized source_url (origin + path only — query string
     and fragment stripped per plan §8/§10.10). Every access to the tracking
     interface is guarded so this handler can never throw because of it. */
  function defaultSourceUrl() {
    try {
      return window.location.origin + window.location.pathname;
    } catch (err) {
      return '';
    }
  }

  function getAnalyticsContext() {
    var ctx = {
      state: 'unknown',
      consentVersion: null,
      receipt: null,
      visitorId: null,
      sessionId: null,
      visitId: null,
      sourceUrl: defaultSourceUrl()
    };
    var api = window.__SHADOW_ATTRIBUTION__; // undefined locally → default posture
    if (!api || typeof api.getSignupContext !== 'function') return ctx;
    var provided;
    try {
      provided = api.getSignupContext();
    } catch (err) {
      return ctx; // tracking.js failed mid-call → honest unknown context
    }
    if (!provided || typeof provided !== 'object' || !provided.available) return ctx;
    if (ANALYTICS_STATES.indexOf(provided.state) === -1) return ctx;
    ctx.state = provided.state;
    if (typeof provided.sourceUrl === 'string' && provided.sourceUrl) {
      ctx.sourceUrl = provided.sourceUrl; // tracking.js already sanitizes (contract §1.6)
    }
    if (ctx.state !== 'accepted') return ctx; // identifiers MUST stay absent otherwise

    if (typeof provided.receipt !== 'string' || !provided.receipt ||
        typeof provided.visitorId !== 'string' || !provided.visitorId) {
      // Accepted locally but no coherent context (e.g. receipt mint failed):
      // never send accepted-without-receipt (the server would 422) — report
      // the honest usable state, "unknown", with the minimized URL.
      ctx.state = 'unknown';
      ctx.sourceUrl = defaultSourceUrl();
      return ctx;
    }
    ctx.consentVersion = typeof provided.consentVersion === 'string' ? provided.consentVersion : null;
    ctx.receipt = provided.receipt;
    ctx.visitorId = provided.visitorId;
    ctx.sessionId = typeof provided.sessionId === 'string' ? provided.sessionId : null;
    ctx.visitId = typeof provided.visitId === 'string' ? provided.visitId : null;
    return ctx;
  }

  function buildAnalyticsObject(ctx) {
    var analytics = { consent_state: ctx.state };
    if (ctx.state === 'accepted') {
      if (ctx.consentVersion) analytics.consent_version = ctx.consentVersion;
      analytics.receipt = ctx.receipt; // required iff accepted (contract §1.7)
      analytics.visitor_id = ctx.visitorId;
      if (ctx.sessionId) analytics.session_id = ctx.sessionId;
      if (ctx.visitId) analytics.visit_id = ctx.visitId;
    }
    return analytics;
  }

  /* Signup submission carrying analytics context = session activity (frozen
     contract §1.13). Best-effort local timestamp touch; never blocks signup. */
  function noteSignupActivity(ctx) {
    if (ctx.state !== 'accepted') return;
    try {
      var api = window.__SHADOW_ATTRIBUTION__;
      if (api && typeof api.noteSignupActivity === 'function') api.noteSignupActivity();
    } catch (err) { /* best effort */ }
  }

  /* --------------------------------------------------------------------- */

  /* Status region — ships in the form markup (reserved line inside
     <form data-signup>); created on demand only as a defensive fallback if a
     deploy variant were ever served without it (never silently no-op). */
  function ensureStatus(form) {
    var status = form.querySelector('[role="status"]');
    if (status) return status;
    status = document.createElement('p');
    status.className = 'signup-status';
    status.setAttribute('role', 'status');
    form.appendChild(status);
    return status;
  }

  function setStatus(statusEl, message, kind) {
    if (!statusEl) return;
    statusEl.textContent = message; // aria-live region announces the change
    statusEl.classList.toggle('signup-status--error', kind === 'error');
    statusEl.classList.toggle('signup-status--success', kind === 'success');
  }

  /* Success state (2026-10-01 user directive): disable — never remove or hide —
     the email input and the submit button. The `disabled` attribute changes no
     box geometry, so the layout never shifts; the status region keeps its
     reserved line. */
  function lockFormFields(form) {
    Array.prototype.forEach.call(form.querySelectorAll('input, button'), function (el) {
      el.disabled = true;
    });
  }

  function setBusy(form, buttons, busy, succeeded) {
    if (busy) {
      inflight.add(form);
      form.setAttribute('aria-busy', 'true');
      Array.prototype.forEach.call(buttons, function (b) { b.disabled = true; });
    } else {
      inflight.delete(form);
      form.removeAttribute('aria-busy');
      if (succeeded) {
        lockFormFields(form);
      } else {
        // Failure keeps the form enabled for retry (honest error shown).
        Array.prototype.forEach.call(buttons, function (b) { b.disabled = false; });
      }
    }
  }

  function captchaError(message) {
    var err = new Error(message);
    err.captcha = true;
    return err;
  }

  /* reCAPTCHA Enterprise (score-based, invisible): inject the loader ONCE
     (data-* guard), then execute with action "signup" — the canvaserp-proven
     pattern. This loader is the ONLY external request the contract allows, and
     it never happens without a live config requiring captcha. */
  function loadRecaptcha(config) {
    if (window.grecaptcha && window.grecaptcha.enterprise) return Promise.resolve();
    if (recaptchaPromise) return recaptchaPromise;
    recaptchaPromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = 'https://www.google.com/recaptcha/enterprise.js?render=' +
        encodeURIComponent(config.siteKey);
      script.async = true;
      script.setAttribute('data-shadow-recaptcha-loader', '1');
      script.onload = function () { resolve(); };
      script.onerror = function () {
        recaptchaPromise = null; // a later attempt may retry the load
        reject(captchaError('recaptcha loader failed'));
      };
      document.head.appendChild(script);
    });
    return recaptchaPromise;
  }

  function getRecaptchaToken(config) {
    return loadRecaptcha(config).then(function () {
      var enterprise = window.grecaptcha && window.grecaptcha.enterprise;
      if (!enterprise) return Promise.reject(captchaError('recaptcha unavailable'));
      return new Promise(function (resolve, reject) {
        enterprise.ready(function () {
          enterprise.execute(config.siteKey, { action: 'signup' })
            .then(resolve, function () { reject(captchaError('token failed')); });
        });
      });
    });
  }

  async function readJsonBody(response) {
    try { return await response.json(); } catch (err) { return null; }
  }

  /* 2026-09-26 directive (wired by this port — the flagged gap): a 422 (request
     validation, e.g. malformed email) must render a SPECIFIC "please check the
     form" message that names what to fix — never the generic "Something went
     wrong". Prefer the backend's per-field 422 detail (detail[].loc =
     ["body", <field>, …]); fall back to the specific form-level wording when
     the body can't be parsed. */
  function validationMessage(payload) {
    var detail = payload && Array.isArray(payload.detail) ? payload.detail : null;
    var field = null;
    if (detail) {
      for (var i = 0; i < detail.length; i++) {
        var loc = detail[i] && detail[i].loc;
        if (Array.isArray(loc) && loc.length > 1 && loc[0] === 'body') {
          field = String(loc[loc.length - 1]);
          break;
        }
      }
    }
    if (field === 'email') return 'Please check the form — enter a valid email address.';
    if (field === 'captcha_token') return 'Verification failed — please try again.';
    if (field) return 'Please check the form — the "' + field + '" entry needs correcting.';
    return 'Please check the form — review your entries and try again.';
  }

  async function attemptSubmit(form) {
    var config = getConfig();
    if (!config) return; // inert: no live config → do nothing, forever
    if (inflight.has(form)) return; // single-flight

    var status = ensureStatus(form); // ships in markup; creation is only a fallback
    var buttons = form.querySelectorAll('button');
    setBusy(form, buttons, true);

    var succeeded = false;
    try {
      var formData = collectFormData(form);
      var analytics = getAnalyticsContext();
      var body = {
        source: config.source,
        // Sanitized when analytics is accepted; origin+path only otherwise
        // (declined/unknown/withdrawn — frozen contract §1.7 + plan §8).
        source_url: analytics.sourceUrl,
        session_id: ensureSessionId(),
        consent_version: config.consentVersion,
        form_data: formData
      };
      var email = extractEmail(form, formData);
      if (email) body.email = email; // key omitted entirely when empty
      body.analytics = buildAnalyticsObject(analytics);

      if (config.captchaRequired) {
        body.captcha_token = await getRecaptchaToken(config); // throws → no POST
      }
      noteSignupActivity(analytics);

      var response = await fetch(config.backendUrl.replace(/\/+$/, '') + '/api/v1/signups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (response.status === 200) {
        setStatus(status, "You're on the list", 'success');
        succeeded = true;
      } else if (response.status === 429) {
        setStatus(status, 'Too many attempts — try again in a minute.', 'error');
      } else if (response.status === 400) {
        setStatus(status, 'Verification failed — please try again.', 'error');
      } else if (response.status === 422) {
        setStatus(status, validationMessage(await readJsonBody(response)), 'error');
      } else {
        setStatus(status, 'Something went wrong — please try again.', 'error');
      }
    } catch (err) {
      if (err && err.captcha) {
        setStatus(status, 'Verification failed — please try again.', 'error');
      } else if (err && err.name === 'TypeError') {
        // fetch rejects with TypeError on network failure — its own wording
        // (distinct-message wiring fix, adaptation report §5).
        setStatus(status, 'Connection problem — check your internet connection and try again.', 'error');
      } else {
        setStatus(status, 'Something went wrong — please try again.', 'error');
      }
    } finally {
      setBusy(form, buttons, false, succeeded);
    }
  }

  /* Submit triggers: the control is <button type="button"> (native submit never
     fires), so button clicks and Enter keydowns on text-like inputs are bound
     here. Without a live config both handlers return before acting on anything. */
  var TEXTLIKE = /^(text|email|search|tel|url|password|number|date|month|week|time|datetime-local)$/i;

  function onClick(event) {
    if (!event.target || !event.target.closest) return;
    var form = event.currentTarget;
    var button = event.target.closest('button, input[type="button"], input[type="submit"]');
    if (!button || !form.contains(button)) return;
    if (button.getAttribute('type') === 'reset') return;
    if (!getConfig()) return;
    event.preventDefault(); // live pages: no native GET — this form posts via fetch
    attemptSubmit(form);
  }

  function onKeyDown(event) {
    if (event.key !== 'Enter') return;
    var form = event.currentTarget;
    var target = event.target;
    if (!target || target.tagName !== 'INPUT' || !TEXTLIKE.test(target.type || '')) return;
    if (target.form !== form) return;
    if (!getConfig()) return;
    event.preventDefault(); // take over: implicit native submission never fires
    attemptSubmit(form);
  }

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll('form[data-signup]'), function (form) {
      form.addEventListener('click', onClick);
      form.addEventListener('keydown', onKeyDown);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
