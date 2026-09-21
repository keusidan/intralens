/* Client for the intra-Lens backend (see internal/server).
 *
 * Three situations are supported:
 *   1. served by the Go binary  -> same-origin /api/* calls
 *   2. static copy (GitHub Pages) -> the spec is baked into the page and the
 *      API is unreachable, so the UI starts in browse-only mode
 *   3. static copy + a local backend the visitor points us at -> cross-origin
 *      /api/* calls, which that backend must allow with --allow-origin
 */
(function (global) {
  'use strict';

  var STORAGE_BASE = 'intralens:backend';

  var base = read(STORAGE_BASE) || '';

  function read(key) {
    try { return global.localStorage.getItem(key); } catch (err) { return null; }
  }

  function write(key, value) {
    try {
      if (value) global.localStorage.setItem(key, value);
      else global.localStorage.removeItem(key);
    } catch (err) { /* private mode */ }
  }

  function endpoint(path) {
    return base ? base.replace(/\/+$/, '') + '/' + path : path;
  }

  function request(path, options) {
    return fetch(endpoint(path), options).then(function (response) {
      return response.text().then(function (text) {
        var payload = null;
        if (text) {
          try { payload = JSON.parse(text); } catch (err) { payload = null; }
        }
        if (!response.ok) {
          var message = (payload && payload.error) || (response.status + ' ' + response.statusText);
          var error = new Error(message);
          error.status = response.status;
          throw error;
        }
        return payload;
      });
    });
  }

  /** True when the page carries a baked spec, i.e. the static Pages build. */
  function isStatic() {
    return !!global.INTRALENS_SPEC;
  }

  global.IntraLens = global.IntraLens || {};

  /** Backend state, filled once at boot and read by the views. */
  global.IntraLens.runtime = { status: null };

  global.IntraLens.api = {
    /** Base URL of the backend: '' means same origin. */
    getBase: function () { return base; },

    /** Point the UI at another intra-Lens instance (or back to same origin). */
    setBase: function (value) {
      base = (value || '').trim().replace(/\/+$/, '');
      write(STORAGE_BASE, base);
    },

    isStatic: isStatic,

    /** Browse-only means: no backend to call, only the baked spec. */
    isBrowseOnly: function () { return isStatic() && !base; },

    /** The OpenAPI document, from the backend or from the baked copy. */
    spec: function () {
      if (!base && isStatic()) return Promise.resolve(global.INTRALENS_SPEC);
      return request('api/spec')['catch'](function (err) {
        if (isStatic()) return global.INTRALENS_SPEC;
        throw err;
      });
    },

    /** Backend state, or null when there is no backend to ask. */
    status: function () {
      if (!base && isStatic()) return Promise.resolve(null);
      return request('api/status');
    },

    /** Run one operation through the intraoapi42 Go client. */
    call: function (payload) {
      return request('api/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
