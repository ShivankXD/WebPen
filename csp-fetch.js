/**
 * csp-fetch.js — CSP-safe fetch() proxy for WebPen content scripts
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * PROBLEM:
 *   Many websites set a restrictive Content-Security-Policy such as:
 *     Content-Security-Policy: connect-src 'self'
 *   or even:
 *     Content-Security-Policy: default-src 'none'
 *
 *   When a content script calls fetch('https://your-backend.com/...'), that
 *   fetch happens in the HOST PAGE'S security context, not the extension's.
 *   Chrome enforces the page's connect-src on it, blocking the request with:
 *     Refused to connect to 'https://your-backend.com' because it violates
 *     the Content Security Policy directive: "connect-src 'self'"
 *
 * SOLUTION:
 *   Route all network calls through chrome.runtime.sendMessage() to the
 *   background service worker. The SW runs at chrome-extension:// origin —
 *   a completely separate security context that is NEVER subject to the
 *   host page's CSP.
 *
 *   Content script  →  chrome.runtime.sendMessage("webpen-fetch", ...)
 *                   →  background.js validates URL against allowlist
 *                   →  fetch() from SW origin (no CSP restriction)
 *                   →  response returned to content script via sendResponse
 *
 * USAGE (in content scripts):
 *   // Instead of:
 *   const resp = await fetch('https://your-backend.com/api/data', { ... });
 *
 *   // Use:
 *   const resp = await cspFetch('https://your-backend.com/api/data', { ... });
 *   const data = await resp.json();
 *
 * NOTE: This file is NOT injected into pages. It is imported by other
 * extension JS files that run in the content script / popup context.
 * For content scripts (which cannot use ES module import), copy the
 * cspFetch function directly or inject csp-fetch.js as an additional
 * file in chrome.scripting.executeScript({ files: [...] }).
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

/**
 * cspFetch(url, options)
 *
 * Drop-in replacement for fetch() that routes through the extension
 * service worker to bypass page CSP restrictions.
 *
 * Returns a Response-like object with:
 *   .ok      {boolean}  — true if HTTP status 200-299
 *   .status  {number}   — HTTP status code
 *   .json()  {Function} — returns parsed JSON (async, matches fetch API)
 *   .text()  {Function} — returns raw text (async, matches fetch API)
 *
 * Throws if:
 *   • The chrome.runtime message channel is unavailable
 *   • The URL is not on background.js's PROXY_ALLOWLIST
 *   • A network error occurs in the SW
 *
 * @param  {string} url
 * @param  {{ method?: string, headers?: object, body?: string }} [options]
 * @returns {Promise<{ ok: boolean, status: number, json: Function, text: Function }>}
 */
function cspFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const message = {
      action:  "webpen-fetch",
      url,
      method:  options.method  || "GET",
      headers: options.headers || {},
      // body must be a string for IPC serialisation
      body:    options.body != null
                 ? (typeof options.body === "string"
                     ? options.body
                     : JSON.stringify(options.body))
                 : null,
    };

    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(
          "[WebPen cspFetch] Message failed: " +
          chrome.runtime.lastError.message
        ));
        return;
      }

      if (!response) {
        reject(new Error("[WebPen cspFetch] No response from background.js"));
        return;
      }

      if (response.error && !response.ok) {
        // Surface proxy-level errors (allowlist rejection, network failure)
        const err    = new Error(`[WebPen cspFetch] ${response.error}`);
        err.status   = response.status;
        reject(err);
        return;
      }

      // Construct a Response-like object mirroring the fetch() API
      const bodyText = response.body ?? "";

      resolve({
        ok:     response.ok,
        status: response.status,

        /** Returns the body parsed as JSON */
        json() {
          return Promise.resolve(JSON.parse(bodyText));
        },

        /** Returns the raw body string */
        text() {
          return Promise.resolve(bodyText);
        },
      });
    });
  });
}

/**
 * cspPost(url, jsonBody, extraHeaders)
 *
 * Convenience wrapper for the common case of posting JSON to the backend.
 *
 * Example:
 *   const resp = await cspPost(
 *     'https://your-backend.com/paypal/verify-subscription',
 *     { subscriptionId: 'P-xxx', extensionUserId: 'token-yyy' }
 *   );
 *   const result = await resp.json();
 *
 * @param  {string} url
 * @param  {object} jsonBody
 * @param  {object} [extraHeaders]
 * @returns {Promise}
 */
function cspPost(url, jsonBody, extraHeaders = {}) {
  return cspFetch(url, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(jsonBody),
  });
}

// ── Export for ES module contexts (popup.js, drive.js) ──────────────────────
// For plain content script injection, these are available as globals.
if (typeof module !== "undefined") {
  module.exports = { cspFetch, cspPost };
}
