/*
 * signup.js — canonical config-gated signup form handler for shadow-launcher pages.
 * Normative contract: docs/backend-architecture.md §12 (frontend), §7 (API).
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
 * Never: cookies, localStorage/sessionStorage, analytics, or any request other
 * than the reCAPTCHA loader (live + captchaRequired only) and the signup POST.
 */
(function () {
  'use strict';

  var inflight = new WeakSet(); // per-form single-flight guard
  var sessionId = null; // generated lazily, once per page load
  var recaptchaPromise = null; // module-level guard: loader injected at most once

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

  function setStatus(statusEl, message, kind) {
    if (!statusEl) return;
    statusEl.textContent = message; // aria-live region announces the change
    statusEl.classList.toggle('signup-status--error', kind === 'error');
    statusEl.classList.toggle('signup-status--success', kind === 'success');
  }

  function setBusy(form, buttons, busy) {
    if (busy) {
      inflight.add(form);
      form.setAttribute('aria-busy', 'true');
      Array.prototype.forEach.call(buttons, function (b) { b.disabled = true; });
    } else {
      inflight.delete(form);
      form.removeAttribute('aria-busy');
      // Re-enable even on success: the backend is a fact table — repeated
      // submissions are expected and stored as separate rows (§6).
      Array.prototype.forEach.call(buttons, function (b) { b.disabled = false; });
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

  async function attemptSubmit(form) {
    var config = getConfig();
    if (!config) return; // inert: no live config → do nothing, forever
    if (inflight.has(form)) return; // single-flight

    var status = form.querySelector('[role="status"]');
    var buttons = form.querySelectorAll('button');
    setBusy(form, buttons, true);

    try {
      var formData = collectFormData(form);
      var body = {
        source: config.source,
        source_url: window.location.href,
        session_id: ensureSessionId(),
        consent_version: config.consentVersion,
        form_data: formData
      };
      var email = extractEmail(form, formData);
      if (email) body.email = email; // key omitted entirely when empty

      if (config.captchaRequired) {
        body.captcha_token = await getRecaptchaToken(config); // throws → no POST
      }

      var response = await fetch(config.backendUrl.replace(/\/+$/, '') + '/api/v1/signups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (response.status === 200) {
        setStatus(status, "Thanks — you're on the list.", 'success');
      } else if (response.status === 429) {
        setStatus(status, 'Too many attempts — try again in a minute.', 'error');
      } else if (response.status === 400) {
        setStatus(status, 'Verification failed — please try again.', 'error');
      } else {
        setStatus(status, 'Something went wrong — please try again.', 'error');
      }
    } catch (err) {
      // captcha failure or network error — error text; controls re-enabled in finally
      setStatus(status, err && err.captcha
        ? 'Verification failed — please try again.'
        : 'Something went wrong — please try again.', 'error');
    } finally {
      setBusy(form, buttons, false);
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
