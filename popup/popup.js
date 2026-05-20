/**
 * popup.js — WebPen v3 Premium popup controller
 *
 * Architecture note on why Drive upload is orchestrated here and not
 * in background.js:
 *
 *   chrome.identity.getAuthToken({ interactive: true }) opens a real browser
 *   window for the Google consent screen. MV3 service workers are headless —
 *   they have no window context to attach that flow to. Chrome will silently
 *   fail or throw if you try. Extension pages (popup, options) DO have a
 *   window, so interactive OAuth must originate here.
 *
 *   Flow:
 *     1. popup.js calls chrome.identity.getAuthToken({ interactive: true })
 *     2. User sees Google consent screen if first time (or token expired)
 *     3. popup.js sends "webpen-composite-for-drive" to background.js
 *        → background.js calls captureVisibleTab (only SW can do this)
 *        → background.js composites page + drawing layer
 *        → returns composited PNG as a data URL
 *     4. popup.js converts data URL → Blob, calls Drive API with token
 *     5. On success, popup.js broadcasts "webpen-drive-upload-done" to
 *        the active tab's content script so the toolbar button can react
 */

"use strict";

// ── CSP-safe fetch proxy ──────────────────────────────────────────────────────
//
// popup.js runs as an extension page (chrome-extension:// origin), so its own
// fetch() calls are NOT blocked by the host page's CSP. However, we still route
// Drive API and backend calls through the extension's background service worker
// for two reasons:
//
//   1. CONSISTENCY: The same code path works whether called from popup.js or
//      a content script. Content scripts CANNOT fetch() external URLs directly
//      without hitting the page's connect-src CSP.
//
//   2. BINARY UPLOAD EXCEPTION: The Drive multipart upload sends a raw binary
//      Uint8Array that cannot be serialised over chrome.runtime.sendMessage
//      (which only handles JSON-serialisable data). This one call MUST use
//      fetch() directly from popup.js. All other Drive calls (folder search,
//      folder create, userinfo, token revoke) are plain JSON and go through
//      cspFetch().
//
// Rule of thumb applied here:
//   • JSON-in / JSON-out calls  → cspFetch() (proxied through background.js)
//   • Binary body upload        → fetch() directly from popup.js (extension origin)
//   • data: URL → Blob          → fetch() on a data: URL (no network, always safe)
//
// ─────────────────────────────────────────────────────────────────────────────

/**
 * cspFetch(url, options)
 * Routes a fetch through background.js so it works from both popup.js
 * and content scripts (which cannot fetch() external URLs under strict CSP).
 * Returns a Response-like object with .ok, .status, .json(), .text().
 */
function cspFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        action: "webpen-fetch",
        url,
        method: options.method || "GET",
        headers: options.headers || {},
        body: options.body != null
          ? (typeof options.body === "string"
            ? options.body
            : JSON.stringify(options.body))
          : null,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error("[WebPen cspFetch] " + chrome.runtime.lastError.message));
          return;
        }
        if (!response) {
          reject(new Error("[WebPen cspFetch] No response from background.js"));
          return;
        }
        if (!response.ok && response.error) {
          const err = new Error(response.error);
          err.status = response.status;
          reject(err);
          return;
        }
        const bodyText = response.body ?? "";
        resolve({
          ok: response.ok,
          status: response.status,
          json: () => Promise.resolve(JSON.parse(bodyText)),
          text: () => Promise.resolve(bodyText),
        });
      }
    );
  });
}

// ── Config ────────────────────────────────────────────────────────────────────
const PAYPAL_PLAN_ID = "P-4U736067JU390512SNIGZQ6A"; // ← paste your PayPal Plan ID here
const BACKEND_BASE_URL = "https://webpen-backend-7ac1.onrender.com";

// Drive API endpoints
const DRIVE_UPLOAD_URL =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

// Storage keys
const FOLDER_CACHE_KEY = "webpen_drive_folder_id";
const USERINFO_CACHE_KEY = "webpen_drive_userinfo";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const planBadge = document.getElementById("plan-badge");
const statusDot = document.getElementById("status-dot");
const statusLabel = document.getElementById("status-label");
const toggleBtn = document.getElementById("toggle-btn");
const driveBtn = document.getElementById("drive-btn");
const upgradeCta = document.getElementById("upgrade-cta");
const driveRow = document.getElementById("drive-feature-row");
const modalBackdrop = document.getElementById("modal-backdrop");
const upgradeModal = document.getElementById("upgrade-modal");
const modalClose = document.getElementById("modal-close");
const paypalContainer = document.getElementById("paypal-btn-container");
const userInfoEl = document.getElementById("drive-user-info");
const signOutBtn = document.getElementById("drive-sign-out");

// ── Bootstrap ─────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const { isPremium = false, premiumEmail = "" } =
    await chrome.storage.sync.get(["isPremium", "premiumEmail"]);

  const { activeTabs = [] } = await chrome.storage.session.get("activeTabs");
  const isActive = activeTabs.includes(tab?.id);

  applyPremiumUI(isPremium, premiumEmail);
  applyActiveUI(isActive);

  if (isPremium) loadAndShowUserInfo();

  // ── Activate / deactivate ────────────────────────────────────────────────
  toggleBtn.addEventListener("click", async () => {
    const { activeTabs: current = [] } = await chrome.storage.session.get("activeTabs");
    const active = current.includes(tab.id);
    await chrome.runtime.sendMessage({
      action: active ? "webpen-deactivate" : "webpen-activate",
      tabId: tab.id,
    });
    applyActiveUI(!active);
    const updated = active
      ? current.filter(id => id !== tab.id)
      : [...current, tab.id];
    await chrome.storage.session.set({ activeTabs: updated });
  });

  // ── Upgrade modal ────────────────────────────────────────────────────────
  upgradeCta.addEventListener("click", openModal);
  modalClose.addEventListener("click", closeModal);
  modalBackdrop.addEventListener("click", (e) => {
    if (e.target === modalBackdrop) closeModal();
  });

  // ── Drive save button ────────────────────────────────────────────────────
  driveBtn?.addEventListener("click", handleDriveSave);

  // ── Sign-out ─────────────────────────────────────────────────────────────
  signOutBtn?.addEventListener("click", handleSignOut);
});

// ── UI helpers ────────────────────────────────────────────────────────────────
function applyPremiumUI(isPremium) {
  if (!isPremium) return;
  planBadge.textContent = "PREMIUM";
  planBadge.className = "badge badge-premium";
  driveBtn?.classList.remove("hidden");
  upgradeCta?.classList.add("hidden");
  driveRow.classList.replace("locked", "available");
  const lockIcon = driveRow.querySelector(".lock-icon");
  if (lockIcon) {
    lockIcon.outerHTML = `<svg class="feat-icon" viewBox="0 0 24 24"
      fill="none" stroke="var(--green)" stroke-width="2.5"
      stroke-linecap="round" stroke-linejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>`;
  }
  driveRow.querySelector(".premium-tag")?.remove();
}

function applyActiveUI(isActive) {
  statusDot.classList.toggle("active", isActive);
  statusLabel.textContent = isActive ? "Active on this tab" : "Inactive on this tab";
  toggleBtn.textContent = isActive ? "Deactivate" : "Activate";
  toggleBtn.classList.toggle("active-btn", isActive);
}

// ── Drive user info display ───────────────────────────────────────────────────
async function loadAndShowUserInfo() {
  if (!userInfoEl) return;
  const { [USERINFO_CACHE_KEY]: cached } =
    await chrome.storage.local.get(USERINFO_CACHE_KEY);
  if (cached) { renderUserInfo(cached); return; }
  try {
    const token = await getAuthToken({ interactive: false });
    // cspFetch() routes through background.js — works under any page CSP.
    // popup.js could fetch() directly (extension origin), but using cspFetch
    // keeps the pattern consistent across all Drive API calls.
    const resp = await cspFetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return;
    const d = await resp.json();
    const user = { name: d.name, email: d.email, picture: d.picture };
    await chrome.storage.local.set({ [USERINFO_CACHE_KEY]: user });
    renderUserInfo(user);
  } catch { /* not signed in yet — silent */ }
}

function renderUserInfo(user) {
  if (!userInfoEl) return;
  userInfoEl.classList.remove("hidden");
  userInfoEl.innerHTML = `
    ${user.picture
      ? `<img src="${escHtml(user.picture)}" alt="" class="user-avatar" />`
      : `<div class="user-avatar-placeholder"></div>`}
    <div class="user-text">
      <span class="user-name">${escHtml(user.name || "")}</span>
      <span class="user-email">${escHtml(user.email || "")}</span>
    </div>`;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Drive save ────────────────────────────────────────────────────────────────
async function handleDriveSave() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Step 1 — OAuth (interactive: consent screen if first time / token expired)
  setDriveBtnState("loading", "Connecting to Google…");
  let token;
  try {
    token = await getAuthToken({ interactive: true });
  } catch (err) {
    setDriveBtnState("error", "Sign-in failed");
    scheduleReset();
    return;
  }

  // Step 2 — Composite: SW captures tab + merges drawing layer
  setDriveBtnState("loading", "Capturing page…");
  let blob;
  try {
    const resp = await chrome.runtime.sendMessage({
      action: "webpen-composite-for-drive",
      tabId: tab.id,
    });
    if (!resp?.ok) throw new Error(resp?.error || "Composite failed");
    blob = await dataUrlToBlob(resp.dataUrl);
  } catch (err) {
    setDriveBtnState("error", "Capture failed");
    scheduleReset();
    return;
  }

  // Step 3 — Ensure WebPen folder exists
  setDriveBtnState("loading", "Checking Drive folder…");
  let folderId;
  try {
    folderId = await ensureWebPenFolder(token);
  } catch (err) {
    if (err.status === 401) {
      try { token = await refreshToken(); folderId = await ensureWebPenFolder(token); }
      catch { setDriveBtnState("error", "Auth expired"); scheduleReset(); return; }
    } else {
      setDriveBtnState("error", "Folder error");
      scheduleReset();
      return;
    }
  }

  // Step 4 — Upload file
  setDriveBtnState("loading", "Uploading to Drive…");
  let result;
  try {
    result = await uploadFileToDrive(blob, folderId, token);
  } catch (err) {
    if (err.status === 401) {
      try { token = await refreshToken(); result = await uploadFileToDrive(blob, folderId, token); }
      catch { setDriveBtnState("error", "Upload failed"); scheduleReset(); return; }
    } else {
      setDriveBtnState("error", "Upload failed");
      scheduleReset();
      return;
    }
  }

  // Step 5 — Notify content script so toolbar Drive button reacts
  chrome.tabs.sendMessage(tab.id, {
    action: "webpen-drive-upload-done",
    ok: true,
    webViewLink: result.webViewLink,
    fileName: result.fileName,
  });

  // Step 6 — Cache user info for "Signed in as" display
  fetchAndCacheUserInfo(token);

  setDriveBtnState("success", "✓ Saved to Drive");
  scheduleReset(3500);
}

// ── Drive API ─────────────────────────────────────────────────────────────────

/**
 * ensureWebPenFolder(token)
 *
 * Guarantees a "WebPen" folder exists in the user's Drive root.
 * Priority: local cache → Drive search → create new.
 * The folder ID is cached in chrome.storage.local to avoid API calls on
 * every upload.
 */
async function ensureWebPenFolder(token) {
  // 1. Local cache
  const { [FOLDER_CACHE_KEY]: cachedId } =
    await chrome.storage.local.get(FOLDER_CACHE_KEY);

  if (cachedId) {
    // 2. Verify cache is still valid (folder may have been deleted)
    try {
      const check = await driveGet(
        `${DRIVE_FILES_URL}/${cachedId}?fields=id,trashed`, token
      );
      if (!check.trashed) return cachedId;
    } catch { /* 404 = deleted */ }
    await chrome.storage.local.remove(FOLDER_CACHE_KEY);
  }

  // 3. Search Drive for existing "WebPen" folder
  const q = encodeURIComponent(
    `name = 'WebPen' and mimeType = 'application/vnd.google-apps.folder' ` +
    `and 'root' in parents and trashed = false`
  );
  const searchData = await driveGet(
    `${DRIVE_FILES_URL}?q=${q}&fields=files(id)&pageSize=1`, token
  );

  if (searchData.files?.length > 0) {
    const id = searchData.files[0].id;
    await chrome.storage.local.set({ [FOLDER_CACHE_KEY]: id });
    return id;
  }

  // 4. Create the folder — routed through cspFetch (JSON in/out, no binary body)
  const createResp = await cspFetch(DRIVE_FILES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "WebPen",
      mimeType: "application/vnd.google-apps.folder",
    }),
  });
  await assertOk(createResp, "Could not create WebPen folder");
  const folder = await createResp.json();
  await chrome.storage.local.set({ [FOLDER_CACHE_KEY]: folder.id });
  return folder.id;
}

/**
 * uploadFileToDrive(blob, folderId, token)
 *
 * ── WHY THIS FUNCTION USES fetch() DIRECTLY (NOT cspFetch) ──────────────────
 *
 * cspFetch() works by serialising the request body to a plain string and
 * sending it via chrome.runtime.sendMessage() (which only carries JSON-
 * serialisable values). A PNG screenshot is a binary Uint8Array — it cannot
 * be JSON-serialised without base64 encoding, which would add ~33% size and
 * require a matching decode step in background.js.
 *
 * uploadFileToDrive() is ONLY ever called from popup.js, which is an
 * extension page running at chrome-extension:// origin. Extension pages are
 * NOT subject to the host page's CSP — their fetch() calls go out on the
 * extension's own origin, completely outside any page's connect-src.
 *
 * So using raw fetch() here is both necessary (binary body) and safe (popup
 * origin). All JSON-only Drive calls (folder search, folder create, userinfo)
 * use cspFetch() for consistency and content-script compatibility.
 *
 * ── MULTIPART BODY FORMAT (RFC 2387) ─────────────────────────────────────────
 *
 *   --<boundary>
 *   Content-Type: application/json    ← Part 1: metadata
 *
 *   {"name":"...","mimeType":"image/png","parents":["<folderId>"]}
 *   --<boundary>
 *   Content-Type: image/png           ← Part 2: binary PNG bytes
 *
 *   <raw Uint8Array — no base64 encoding>
 *   --<boundary>--
 */
async function uploadFileToDrive(blob, folderId, token) {
  const fileName = buildFileName();
  const metadata = { name: fileName, mimeType: "image/png", parents: [folderId] };

  const boundary = "webpen_" + crypto.randomUUID().replace(/-/g, "");
  const enc = new TextEncoder();

  const metaPart = enc.encode(
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) + `\r\n`
  );
  const mediaHeader = enc.encode(
    `--${boundary}\r\n` +
    `Content-Type: image/png\r\n\r\n`
  );
  const mediaBody = await blob.arrayBuffer();
  const closing = enc.encode(`\r\n--${boundary}--`);

  const totalLen = metaPart.byteLength + mediaHeader.byteLength +
    mediaBody.byteLength + closing.byteLength;
  const body = new Uint8Array(totalLen);
  let off = 0;
  body.set(metaPart, off); off += metaPart.byteLength;
  body.set(mediaHeader, off); off += mediaHeader.byteLength;
  body.set(new Uint8Array(mediaBody), off); off += mediaBody.byteLength;
  body.set(closing, off);

  const resp = await fetch(DRIVE_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  await assertOk(resp, "Drive upload failed");
  const data = await resp.json();
  return { fileId: data.id, fileName: data.name, webViewLink: data.webViewLink };
}

// ── OAuth helpers ─────────────────────────────────────────────────────────────
function getAuthToken({ interactive }) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        const err = new Error(chrome.runtime.lastError?.message || "Auth failed");
        err.code = "AUTH_FAILED";
        reject(err);
        return;
      }
      resolve(token);
    });
  });
}

async function refreshToken() {
  const stale = await new Promise(r => chrome.identity.getAuthToken({ interactive: false }, r));
  if (stale) await new Promise(r => chrome.identity.removeCachedAuthToken({ token: stale }, r));
  return getAuthToken({ interactive: false });
}

async function handleSignOut() {
  setDriveBtnState("loading", "Signing out…");
  const stale = await new Promise(r => chrome.identity.getAuthToken({ interactive: false }, r));
  if (stale) {
    try {
      // cspFetch for consistency — routes through SW to avoid any connect-src block
      await cspFetch(`https://accounts.google.com/o/oauth2/revoke?token=${stale}`);
    } catch { }
    await new Promise(r => chrome.identity.removeCachedAuthToken({ token: stale }, r));
  }
  await chrome.storage.local.remove([FOLDER_CACHE_KEY, USERINFO_CACHE_KEY]);
  if (userInfoEl) { userInfoEl.classList.add("hidden"); userInfoEl.innerHTML = ""; }
  resetDriveBtnState();
}

// ── Misc helpers ──────────────────────────────────────────────────────────────
/**
 * driveGet(url, token)
 * All Drive GET requests (folder verify, folder search) go through cspFetch
 * so they work correctly whether called from popup.js or a content script.
 * These are all JSON-in / JSON-out — no binary data — safe to proxy.
 */
async function driveGet(url, token) {
  const resp = await cspFetch(url, { headers: { Authorization: `Bearer ${token}` } });
  await assertOk(resp, `Drive GET failed`);
  return resp.json();
}

async function assertOk(resp, label) {
  if (resp.ok) return;
  let detail = "";
  try { const e = await resp.json(); detail = e?.error?.message || ""; } catch { }
  const err = new Error(`${label} (HTTP ${resp.status}${detail ? ": " + detail : ""})`);
  err.status = resp.status;
  throw err;
}

function buildFileName() {
  const now = new Date(), pad = n => String(n).padStart(2, "0");
  return `webpen-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
}

async function dataUrlToBlob(dataUrl) {
  // fetch() on a data: URL is a LOCAL operation — it decodes the base64
  // in-process and returns a Blob. No network request is made.
  // This does NOT go through cspFetch() because:
  //   a) It is not a network call — no server is contacted.
  //   b) The data: URL scheme is always allowed (not subject to connect-src).
  //   c) cspFetch only handles http/https URLs (background.js would reject it).
  const resp = await fetch(dataUrl);
  return resp.blob();
}

async function fetchAndCacheUserInfo(token) {
  try {
    // cspFetch — consistent with all other Drive API calls
    const resp = await cspFetch(USERINFO_URL, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) return;
    const d = await resp.json();
    const user = { name: d.name, email: d.email, picture: d.picture };
    await chrome.storage.local.set({ [USERINFO_CACHE_KEY]: user });
    renderUserInfo(user);
  } catch { }
}

// ── Drive button state machine ────────────────────────────────────────────────
const DRIVE_BTN_ICON = `
  <svg width="16" height="14" viewBox="0 0 87.3 78" fill="none">
    <path d="M6.6 66.85l3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3L27.5 53H0c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/>
    <path d="M43.65 25L29.9 0c-1.35.8-2.5 1.9-3.3 3.3L1.2 48.5c-.8 1.4-1.2 2.95-1.2 4.5h27.5z" fill="#00ac47"/>
    <path d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75L86.1 57c.8-1.4 1.2-2.95 1.2-4.5H59.8z" fill="#ea4335"/>
    <path d="M43.65 25L57.4 0H29.9z" fill="#00832d"/>
    <path d="M59.8 52.5H87.3c0-1.55-.4-3.1-1.2-4.5L60.8 3.3c-.8-1.4-1.95-2.5-3.3-3.3L43.65 25z" fill="#2684fc"/>
    <path d="M27.5 53l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h51c1.6 0 3.15-.45 4.5-1.2L59.8 53z" fill="#ffba00"/>
  </svg>`;

function setDriveBtnState(state, label) {
  if (!driveBtn) return;
  driveBtn.disabled = state === "loading";
  driveBtn.className = "drive-btn" + (state !== "idle" ? ` drive-btn-${state}` : "");
  driveBtn.innerHTML = state === "loading"
    ? `<span class="drive-spinner"></span>${label}`
    : label || `${DRIVE_BTN_ICON} Sync to Google Drive`;
}

function resetDriveBtnState() {
  if (!driveBtn) return;
  driveBtn.disabled = false;
  driveBtn.className = "drive-btn";
  driveBtn.innerHTML = `${DRIVE_BTN_ICON} Sync to Google Drive`;
}

let _resetTimer;
function scheduleReset(ms = 2500) {
  clearTimeout(_resetTimer);
  _resetTimer = setTimeout(resetDriveBtnState, ms);
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function openModal() { modalBackdrop.classList.remove("hidden"); mountPayPalButton(); }
function closeModal() { modalBackdrop.classList.add("hidden"); }

// ── PayPal ────────────────────────────────────────────────────────────────────
let paypalMounted = false;

function mountPayPalButton() {
  if (paypalMounted) return;
  if (typeof paypal === "undefined") {
    paypalContainer.innerHTML = `<p style="color:rgba(255,255,255,0.3);font-size:11px;
      text-align:center;padding:12px 0">⚠ PayPal SDK failed to load.</p>`;
    return;
  }
  paypalMounted = true;
  paypalContainer.innerHTML = "";

  paypal.Buttons({
    style: { shape: "pill", color: "gold", layout: "vertical", label: "subscribe" },
    createSubscription: (_d, actions) =>
      actions.subscription.create({ plan_id: PAYPAL_PLAN_ID }),
    onApprove: async (data) => {
      try {
        const userId = await getExtensionUserId();
        // cspFetch routes through background.js — consistent with all backend calls
        const resp = await cspFetch(`${BACKEND_BASE_URL}/paypal/verify-subscription`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscriptionId: data.subscriptionID, userId }),
        });
        const result = await resp.json();
        if (result.isPremium) {
          await chrome.storage.sync.set({ isPremium: true, premiumEmail: result.email || "" });
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          chrome.tabs.sendMessage(tab.id, { action: "webpen-premium-activated" });
          upgradeModal.classList.add("success-state");
          setTimeout(() => { closeModal(); applyPremiumUI(true); loadAndShowUserInfo(); }, 2000);
        } else {
          alert("Payment received but verification failed. Contact support.");
        }
      } catch (err) {
        console.error("[WebPen] Sub verification failed:", err);
        alert("Could not verify subscription. Please try again.");
      }
    },
    onError: err => console.error("[WebPen] PayPal:", err),
    onCancel: () => { },
  }).render("#paypal-btn-container");
}

async function getExtensionUserId() {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (chrome.runtime.lastError || !token) {
        chrome.storage.sync.get("anonId", ({ anonId }) => {
          if (anonId) { resolve(anonId); return; }
          const id = crypto.randomUUID();
          chrome.storage.sync.set({ anonId: id });
          resolve(id);
        });
        return;
      }
      resolve(token);
    });
  });
}
