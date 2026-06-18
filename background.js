/**
 * background.js — WebPen v3 Service Worker
 *
 * Message routing table:
 *   webpen-activate          → inject CSS + JS into tab
 *   webpen-deactivate        → call teardown on tab
 *   webpen-capture           → captureVisibleTab + composite + download
 *   webpen-fetch             → CSP-safe proxy for backend status checks
 */

"use strict";

// ── Active tab tracking ────────────────────────────────────────────────────────
async function getActiveTabs() {
  const { activeTabs = [] } = await chrome.storage.session.get("activeTabs");
  return new Set(activeTabs);
}
async function saveActiveTabs(set) {
  await chrome.storage.session.set({ activeTabs: [...set] });
}

// ── Icon click fallback (popup is primary; this fires via keyboard shortcut) ──
chrome.action.onClicked?.addListener(async (tab) => {
  await toggleWebPen(tab.id);
});

// ── Central message router ────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {

    case "webpen-activate":
      activateTab(msg.tabId).then(() => sendResponse({ ok: true }));
      return true;

    case "webpen-deactivate":
      deactivateTab(msg.tabId).then(() => sendResponse({ ok: true }));
      return true;

    // Called by the camera button in content.js — downloads screenshot locally
    case "webpen-capture":
      handleLocalCapture(msg, sender, sendResponse);
      return true;
  }
});

// ── Tab activation helpers ────────────────────────────────────────────────────
async function activateTab(tabId) {
  const tabs = await getActiveTabs();
  if (tabs.has(tabId)) return;
  tabs.add(tabId);
  await saveActiveTabs(tabs);
  await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  chrome.action.setIcon({ tabId, path: {
    16:  "icons/icon16_active.png",
    48:  "icons/icon48_active.png",
    128: "icons/icon128_active.png",
  }});
}

async function deactivateTab(tabId) {
  const tabs = await getActiveTabs();
  tabs.delete(tabId);
  await saveActiveTabs(tabs);
  await chrome.scripting.executeScript({
    target: { tabId },
    func:   () => window.__webPenTeardown?.(),
  });
  chrome.action.setIcon({ tabId, path: {
    16:  "icons/icon16.png",
    48:  "icons/icon48.png",
    128: "icons/icon128.png",
  }});
}

async function toggleWebPen(tabId) {
  const tabs = await getActiveTabs();
  if (tabs.has(tabId)) await deactivateTab(tabId);
  else                  await activateTab(tabId);
}

// ── Local download capture (camera button in toolbar) ────────────────────────
async function handleLocalCapture(msg, sender, sendResponse) {
  try {
    const pageDataUrl = await chrome.tabs.captureVisibleTab(
      sender.tab.windowId, { format: "png" }
    );
    const [pageImg, drawImg] = await Promise.all([
      loadImage(pageDataUrl),
      loadImage(msg.drawingDataUrl),
    ]);
    const oc  = new OffscreenCanvas(pageImg.width, pageImg.height);
    const ctx = oc.getContext("2d");
    ctx.drawImage(pageImg, 0, 0);
    ctx.drawImage(drawImg, 0, 0, pageImg.width, pageImg.height);
    const blob     = await oc.convertToBlob({ type: "image/png" });
    const finalUrl = await blobToDataUrl(blob);
    await chrome.downloads.download({
      url:      finalUrl,
      filename: "webpen-screenshot.png",
      saveAs:   false,
    });
    sendResponse({ ok: true });
  } catch (err) {
    console.error("[WebPen] Local capture error:", err);
    sendResponse({ ok: false, error: err.message });
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload  = () => res(img);
    img.onerror = () => rej(new Error("Image load failed"));
    img.src = src;
  });
}

function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = () => res(r.result);
    r.onerror = () => rej(new Error("FileReader error"));
    r.readAsDataURL(blob);
  });
}

// ── Tab lifecycle cleanup ─────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const tabs = await getActiveTabs();
  tabs.delete(tabId);
  await saveActiveTabs(tabs);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    const tabs = await getActiveTabs();
    tabs.delete(tabId);
    await saveActiveTabs(tabs);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// CSP-SAFE BACKEND PROXY
// ══════════════════════════════════════════════════════════════════════════════
//
// Content scripts cannot call fetch() to external origins on pages with
// restrictive CSP (connect-src 'self'). All external HTTP calls must go
// through the extension service worker, which runs at extension origin
// and is completely outside the host page's CSP.
//
// Message schema:
//   { action: "webpen-fetch",
//     url:    string,          ← target URL
//     method: string,          ← "GET" | "POST" | etc.
//     headers: object,         ← key/value headers
//     body:   string | null }  ← JSON-stringified body or null
//
// The SW validates the URL against an allowlist before fetching, so a
// compromised page cannot use this proxy to reach arbitrary URLs.
// ══════════════════════════════════════════════════════════════════════════════

// ── PROXY_ALLOWLIST ──────────────────────────────────────────────────────────
//
// Only URLs whose ORIGIN matches an entry in this list will be fetched
// through the CSP proxy. Requests to any other origin are blocked with 403.
//
// ▶ SETUP: Replace the first entry with your real backend URL.
//   Use the exact origin (scheme + host + port). No trailing slashes.
//
//   Examples:
//     "https://api.webpen.app"          ← custom domain
//     "https://webpen-backend.fly.dev"  ← Fly.io deployment
//     "https://abc123.onrender.com"     ← Render deployment
//
// ─────────────────────────────────────────────────────────────────────────────
const PROXY_ALLOWLIST = [

  "https://webpen-backend-7ac1.onrender.com",  // WebPen Render backend (premium status)
];

function isAllowedProxyUrl(urlStr) {
  try {
    const { origin } = new URL(urlStr);
    return PROXY_ALLOWLIST.some(allowed => origin === new URL(allowed).origin);
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action !== "webpen-fetch") return false;

  // Security: verify the URL is on the allowlist
  if (!isAllowedProxyUrl(msg.url)) {
    console.warn("[WebPen Proxy] Blocked fetch to disallowed URL:", msg.url);
    sendResponse({ ok: false, error: "URL not in proxy allowlist", status: 403 });
    return false;
  }

  (async () => {
    try {
      const resp = await fetch(msg.url, {
        method:  msg.method  || "GET",
        headers: msg.headers || {},
        body:    msg.body    || undefined,
      });

      // Read body as text (JSON.parse on the receiving end if needed)
      const text = await resp.text();

      sendResponse({
        ok:     resp.ok,
        status: resp.status,
        body:   text,
      });
    } catch (err) {
      sendResponse({ ok: false, error: err.message, status: 0 });
    }
  })();

  return true; // keep port open for async sendResponse
});
