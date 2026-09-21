/* Thin client for the local intra-Lens backend (see internal/server). */
(function (global) {
  'use strict';

  function request(path, options) {
    return fetch(path, options).then(function (response) {
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

  global.IntraLens = global.IntraLens || {};

  /** Backend state, filled once at boot and read by the views. */
  global.IntraLens.runtime = { status: null };

  global.IntraLens.api = {
    /** The OpenAPI document, served from the embedded copy. */
    spec: function () { return request('api/spec'); },

    /** Backend state: credentials present, target intranet, callable operations. */
    status: function () { return request('api/status'); },

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
