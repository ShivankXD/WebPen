/**
 * drive.js — WebPen Google Drive Integration
 * ─────────────────────────────────────────────────────────────────────────────
 * This module handles the entire Drive flow:
 *
 *   1. OAuth2 via chrome.identity.getAuthToken()
 *      • Non-interactive first (silent refresh from cached token)
 *      • Falls back to interactive consent screen if needed
 *      • On 401, removes stale token and retries once automatically
 *
 *   2. "WebPen" folder management
 *      • Queries Drive for an existing folder named "WebPen"
 *      • Creates it if absent (idempotent — always reuses the same folder)
 *      • Caches the folder ID in chrome.storage.local to save API round-trips
 *
 *   3. Composited screenshot upload
 *      • Receives a composited PNG blob (page + drawing layer)
 *      • Names it  webpen-YYYY-MM-DD-HHmmss.png
 *      • Uses the multipart upload endpoint for a single-request upload
 *      • Returns the Drive file URL on success
 *
 *   4. User info fetch
 *      • Fetches the signed-in Google account's email and display name
 *      • Used to show "Signed in as …" in the popup
 *
 * Usage (from popup.js or background.js):
 *   import { driveUpload, getDriveUserInfo, revokeToken } from './drive.js';
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SETUP CHECKLIST
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. Google Cloud Console → APIs & Services → Credentials
 *    → Create OAuth 2.0 Client ID → Chrome Extension
 *    → Set "Application ID" to your extension ID (chrome://extensions)
 *    → Copy the generated Client ID into manifest.json's oauth2.client_id
 *
 * 2. Enable "Google Drive API" in APIs & Services → Library
 *
 * 3. In OAuth consent screen:
 *    → Add scope: https://www.googleapis.com/auth/drive.file
 *      (this scope only allows files the extension itself creates — least privilege)
 *    → Add test users (yourself) while in "Testing" publish status
 *
 * 4. The extension ID changes if you reload unpacked — pin it or use a
 *    key in manifest.json for a stable ID during development.
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

// ── Constants ─────────────────────────────────────────────────────────────────

const DRIVE_UPLOAD_URL =
  "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink";

const DRIVE_FILES_URL =
  "https://www.googleapis.com/drive/v3/files";

const USERINFO_URL =
  "https://www.googleapis.com/oauth2/v2/userinfo";

const FOLDER_NAME       = "WebPen";
const FOLDER_CACHE_KEY  = "webpen_drive_folder_id";
const USERINFO_CACHE_KEY = "webpen_drive_userinfo";

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * driveUpload(blob)
 *
 * Full pipeline: auth → ensure folder → upload blob → return result.
 *
 * @param  {Blob}   blob  - PNG image blob (composited page + drawings)
 * @returns {Promise<{ fileId: string, fileName: string, webViewLink: string }>}
 * @throws  {DriveError} with a human-readable .message
 */
export async function driveUpload(blob) {
  const token    = await getToken({ interactive: true });
  const folderId = await ensureWebPenFolder(token);
  return uploadFile(blob, folderId, token);
}

/**
 * getDriveUserInfo()
 *
 * Returns the signed-in user's Google profile (name + email).
 * Uses a cached copy in chrome.storage.local; fetches fresh if absent.
 *
 * @returns {Promise<{ name: string, email: string, picture: string } | null>}
 */
export async function getDriveUserInfo() {
  // Return cached copy if available
  const cached = await storageGet(USERINFO_CACHE_KEY);
  if (cached) return cached;

  try {
    const token = await getToken({ interactive: false });
    const info  = await fetchUserInfo(token);
    await storageSet(USERINFO_CACHE_KEY, info);
    return info;
  } catch {
    return null; // not signed in yet — that's fine
  }
}

/**
 * revokeToken()
 *
 * Signs the user out of the Drive integration: removes the cached OAuth token
 * from Chrome's token cache and clears local caches (folder ID, user info).
 *
 * @returns {Promise<void>}
 */
export async function revokeToken() {
  await new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (token) {
        chrome.identity.removeCachedAuthToken({ token }, resolve);
      } else {
        resolve();
      }
    });
  });

  // Clear local caches
  await chrome.storage.local.remove([FOLDER_CACHE_KEY, USERINFO_CACHE_KEY]);
}

// ── OAuth2 helpers ────────────────────────────────────────────────────────────

/**
 * getToken({ interactive })
 *
 * Wraps chrome.identity.getAuthToken in a Promise.
 *
 * MV3 service workers cannot open interactive OAuth windows — only
 * extension pages (popup.html) can. This function is designed to be
 * called from popup.js (interactive: true) or from background.js
 * (interactive: false, for token refreshes only).
 *
 * @param  {{ interactive: boolean }} opts
 * @returns {Promise<string>} OAuth access token
 */
function getToken({ interactive }) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new DriveError(
          interactive
            ? "Google sign-in was cancelled or failed. Please try again."
            : "No cached token — sign-in required.",
          "AUTH_FAILED"
        ));
        return;
      }
      resolve(token);
    });
  });
}

/**
 * withTokenRetry(fn)
 *
 * Calls fn(token). If the Drive API returns 401 (expired token), removes
 * the stale token from Chrome's cache and retries once with a fresh one.
 * This handles the case where Chrome caches a token that Google has revoked.
 *
 * @param  {(token: string) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTokenRetry(fn) {
  const token = await getToken({ interactive: false });
  try {
    return await fn(token);
  } catch (err) {
    if (err.code === "TOKEN_EXPIRED") {
      // Evict the bad token, get a fresh one, retry once
      await new Promise((r) => chrome.identity.removeCachedAuthToken({ token }, r));
      const freshToken = await getToken({ interactive: false });
      return fn(freshToken);
    }
    throw err;
  }
}

// ── Drive folder management ───────────────────────────────────────────────────

/**
 * ensureWebPenFolder(token)
 *
 * Guarantees a "WebPen" folder exists in the user's Drive root and
 * returns its ID.
 *
 * Strategy:
 *   1. Check chrome.storage.local for a cached folder ID
 *   2. Verify the cached ID still exists on Drive (handles deleted folders)
 *   3. Search Drive for an existing "WebPen" folder
 *   4. Create one if none found
 *
 * @param  {string} token
 * @returns {Promise<string>} folder ID
 */
async function ensureWebPenFolder(token) {
  // Step 1: check cache
  const cachedId = await storageGet(FOLDER_CACHE_KEY);
  if (cachedId) {
    // Step 2: verify it still exists
    const exists = await folderExists(cachedId, token);
    if (exists) return cachedId;
    // Folder was deleted — clear cache and fall through
    await chrome.storage.local.remove(FOLDER_CACHE_KEY);
  }

  // Step 3: search Drive for existing "WebPen" folder
  const existingId = await findWebPenFolder(token);
  if (existingId) {
    await storageSet(FOLDER_CACHE_KEY, existingId);
    return existingId;
  }

  // Step 4: create the folder
  const newId = await createWebPenFolder(token);
  await storageSet(FOLDER_CACHE_KEY, newId);
  return newId;
}

/**
 * folderExists(folderId, token) — quick HEAD-like check using files.get
 */
async function folderExists(folderId, token) {
  try {
    const resp = await driveGet(
      `${DRIVE_FILES_URL}/${folderId}?fields=id,trashed`,
      token
    );
    // trashed=true means it's in the bin — treat as non-existent
    return !resp.trashed;
  } catch {
    return false;
  }
}

/**
 * findWebPenFolder(token) — search for an existing "WebPen" folder in Drive root
 *
 * The query uses Drive's search syntax:
 *   name = 'WebPen'
 *   mimeType = 'application/vnd.google-apps.folder'
 *   'root' in parents
 *   trashed = false
 */
async function findWebPenFolder(token) {
  const q = encodeURIComponent(
    `name = '${FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false`
  );
  const data = await driveGet(`${DRIVE_FILES_URL}?q=${q}&fields=files(id)`, token);
  return data.files?.[0]?.id ?? null;
}

/**
 * createWebPenFolder(token) — create a new "WebPen" folder in Drive root
 */
async function createWebPenFolder(token) {
  const body = JSON.stringify({
    name:     FOLDER_NAME,
    mimeType: "application/vnd.google-apps.folder",
    // No 'parents' field = created in root ("My Drive")
  });

  const resp = await fetch(DRIVE_FILES_URL, {
    method:  "POST",
    headers: {
      Authorization:  `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body,
  });

  await assertOk(resp, "Failed to create WebPen folder");
  const data = await resp.json();
  return data.id;
}

// ── File upload ───────────────────────────────────────────────────────────────

/**
 * uploadFile(blob, folderId, token)
 *
 * Uploads a PNG blob to the WebPen folder using a multipart upload.
 *
 * Multipart upload format (RFC 2387):
 *   Part 1: JSON metadata  (name, mimeType, parents)
 *   Part 2: Binary payload (the PNG blob)
 *
 * This keeps the upload to a single HTTP request (no resumable session needed
 * for files under 5 MB, which screenshots always are).
 *
 * @param  {Blob}   blob
 * @param  {string} folderId
 * @param  {string} token
 * @returns {Promise<{ fileId, fileName, webViewLink }>}
 */
async function uploadFile(blob, folderId, token) {
  const fileName = buildFileName();

  const metadata = {
    name:     fileName,
    mimeType: "image/png",
    parents:  [folderId],
  };

  // Build multipart body manually so we control Content-Type headers precisely.
  // FormData would work too but the boundary may differ across browsers —
  // explicit construction is more predictable.
  const boundary    = "webpen_boundary_" + Math.random().toString(36).slice(2);
  const delimiter   = `\r\n--${boundary}\r\n`;
  const closeDelim  = `\r\n--${boundary}--`;

  const metaPart =
    delimiter +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(metadata);

  const blobPart =
    `\r\n--${boundary}\r\n` +
    "Content-Type: image/png\r\n\r\n";

  // Concatenate: text parts + binary blob + close delimiter
  const encoder   = new TextEncoder();
  const metaBytes = encoder.encode(metaPart);
  const blobBytes = encoder.encode(blobPart);
  const closeBytes = encoder.encode(closeDelim);
  const blobBuffer = await blob.arrayBuffer();

  const body = new Uint8Array(
    metaBytes.byteLength + blobBytes.byteLength + blobBuffer.byteLength + closeBytes.byteLength
  );
  let offset = 0;
  body.set(metaBytes,              offset); offset += metaBytes.byteLength;
  body.set(blobBytes,              offset); offset += blobBytes.byteLength;
  body.set(new Uint8Array(blobBuffer), offset); offset += blobBuffer.byteLength;
  body.set(closeBytes,             offset);

  const resp = await fetch(DRIVE_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body: body,
  });

  // Handle token expiry mid-upload
  if (resp.status === 401) {
    throw new DriveError("Access token expired.", "TOKEN_EXPIRED");
  }

  await assertOk(resp, "Drive upload failed");
  const data = await resp.json();

  return {
    fileId:      data.id,
    fileName:    data.name,
    webViewLink: data.webViewLink,
  };
}

// ── User info ─────────────────────────────────────────────────────────────────

async function fetchUserInfo(token) {
  const resp = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await assertOk(resp, "Failed to fetch user info");
  const d = await resp.json();
  return { name: d.name, email: d.email, picture: d.picture };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/** Authenticated GET → parsed JSON */
async function driveGet(url, token) {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (resp.status === 401) throw new DriveError("Token expired.", "TOKEN_EXPIRED");
  await assertOk(resp, `Drive GET failed: ${url}`);
  return resp.json();
}

/** Assert response is OK, throw DriveError otherwise */
async function assertOk(resp, label) {
  if (!resp.ok) {
    let detail = "";
    try { const e = await resp.json(); detail = e?.error?.message || ""; } catch {}
    throw new DriveError(
      `${label} (HTTP ${resp.status}${detail ? ": " + detail : ""})`,
      "API_ERROR",
      resp.status
    );
  }
}

/** Build a timestamp filename: webpen-2025-07-04-143022.png */
function buildFileName() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `webpen-${date}-${time}.png`;
}

/** chrome.storage.local get (promisified, returns value or null) */
async function storageGet(key) {
  const result = await chrome.storage.local.get(key);
  return result[key] ?? null;
}

/** chrome.storage.local set (promisified) */
async function storageSet(key, value) {
  return chrome.storage.local.set({ [key]: value });
}

/** Structured error class for Drive operations */
class DriveError extends Error {
  constructor(message, code, status = null) {
    super(message);
    this.name   = "DriveError";
    this.code   = code;    // "AUTH_FAILED" | "TOKEN_EXPIRED" | "API_ERROR"
    this.status = status;  // HTTP status, if from an API response
  }
}
