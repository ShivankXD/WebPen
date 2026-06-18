/**
 * popup.js — WebPen Premium popup controller
 *
 * Premium unlocks the full 15-colour palette in the on-page toolbar.
 * Payment is handled by PayPal through a small hosted checkout window; the
 * popup polls the backend until the subscription is confirmed, then flips the
 * UI to Premium and notifies the active tab so its colour swatches unlock
 * live (no reload needed).
 */

"use strict";

// ── CSP-safe fetch proxy ──────────────────────────────────────────────────────
//
// popup.js runs as an extension page (chrome-extension:// origin), so its own
// fetch() calls are not blocked by the host page's CSP. We still route the
// backend status check through the background service worker for consistency
// with content scripts (which cannot fetch external URLs directly).
function cspFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        action: "webpen-fetch",
        url,
        method: options.method || "GET",
        headers: options.headers || {},
        body: options.body != null
          ? (typeof options.body === "string" ? options.body : JSON.stringify(options.body))
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
const BACKEND_BASE_URL = "https://webpen-backend-7ac1.onrender.com";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const planBadge     = document.getElementById("plan-badge");
const statusDot     = document.getElementById("status-dot");
const statusLabel   = document.getElementById("status-label");
const toggleBtn     = document.getElementById("toggle-btn");
const upgradeCta    = document.getElementById("upgrade-cta");
const colorsRow     = document.getElementById("colors-feature-row");
const modalBackdrop = document.getElementById("modal-backdrop");
const upgradeModal  = document.getElementById("upgrade-modal");
const modalClose    = document.getElementById("modal-close");

// ── Bootstrap ─────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const { isPremium = false } = await chrome.storage.sync.get("isPremium");

  const { activeTabs = [] } = await chrome.storage.session.get("activeTabs");
  const isActive = activeTabs.includes(tab?.id);

  applyPremiumUI(isPremium);
  applyActiveUI(isActive);

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
});

// ── UI helpers ────────────────────────────────────────────────────────────────
function applyPremiumUI(isPremium) {
  if (!isPremium) return;
  planBadge.textContent = "PREMIUM";
  planBadge.className = "badge badge-premium";
  upgradeCta?.classList.add("hidden");

  if (colorsRow) {
    colorsRow.classList.replace("locked", "available");
    const lockIcon = colorsRow.querySelector(".lock-icon");
    if (lockIcon) {
      lockIcon.outerHTML = `<svg class="feat-icon" viewBox="0 0 24 24"
        fill="none" stroke="var(--green)" stroke-width="2.5"
        stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>`;
    }
    colorsRow.querySelector(".premium-tag")?.remove();
  }
}

function applyActiveUI(isActive) {
  statusDot.classList.toggle("active", isActive);
  statusLabel.textContent = isActive ? "Active on this tab" : "Inactive on this tab";
  const btnSpan = toggleBtn.querySelector("span");
  if (btnSpan) {
    btnSpan.textContent = isActive ? "Turn Off" : "Turn On";
  } else {
    toggleBtn.textContent = isActive ? "Turn Off" : "Turn On";
  }
  toggleBtn.classList.toggle("active-btn", isActive);
}

// ── Modal ─────────────────────────────────────────────────────────────────────
let statusPollInterval = null;
let selectedPlan = "monthly"; // "monthly" ($1/mo) | "lifetime" ($6 once)

function openModal() {
  document.body.classList.add("modal-open");
  modalBackdrop.classList.remove("hidden");
  setupPlanPicker();
  setupCheckoutButton();
}

// Let the user toggle between the Monthly and Lifetime plan cards
function setupPlanPicker() {
  const cards = document.querySelectorAll(".plan-card");
  cards.forEach(card => {
    card.onclick = () => {
      selectedPlan = card.getAttribute("data-plan") || "monthly";
      cards.forEach(c => c.classList.toggle("selected", c === card));
    };
  });
}

function closeModal() {
  document.body.classList.remove("modal-open");
  modalBackdrop.classList.add("hidden");
  if (statusPollInterval) {
    clearInterval(statusPollInterval);
    statusPollInterval = null;
  }
}

// ── Secure checkout & polling ───────────────────────────────────────────────────
function setupCheckoutButton() {
  const checkoutBtn = document.getElementById("checkout-btn");
  if (!checkoutBtn) return;

  checkoutBtn.onclick = async () => {
    checkoutBtn.disabled = true;
    checkoutBtn.innerHTML =
      `<span class="drive-spinner" style="margin-right: 6px; vertical-align: middle;"></span>Opening secure checkout…`;

    try {
      const userId = await getExtensionUserId();
      const checkoutUrl =
        `${BACKEND_BASE_URL}/checkout.html?userId=${encodeURIComponent(userId)}` +
        `&plan=${encodeURIComponent(selectedPlan)}`;

      // Open a native-looking secure payment dialog window
      chrome.windows.create({
        url: checkoutUrl,
        type: "popup",
        width: 480,
        height: 720,
      });

      // Start short-polling status
      startStatusPolling(userId);

      checkoutBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
          stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; margin-right: 6px; vertical-align: -1px;">
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
        Waiting for payment…
      `;
    } catch (err) {
      console.error("[WebPen] Checkout launch error:", err);
      checkoutBtn.disabled = false;
      checkoutBtn.innerHTML = `⚠ Checkout failed — try again`;
    }
  };
}

function startStatusPolling(userId) {
  if (statusPollInterval) clearInterval(statusPollInterval);

  statusPollInterval = setInterval(async () => {
    try {
      const resp = await cspFetch(`${BACKEND_BASE_URL}/api/user-status?userId=${encodeURIComponent(userId)}`);
      const result = await resp.json();

      if (result.isPremium) {
        clearInterval(statusPollInterval);
        statusPollInterval = null;

        await chrome.storage.sync.set({ isPremium: true, premiumEmail: result.email || "" });

        // Tell the active tab's content script to unlock its colour palette live
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          chrome.tabs.sendMessage(tab.id, { action: "webpen-premium-activated" });
        }

        upgradeModal.classList.add("success-state");
        setTimeout(() => {
          closeModal();
          applyPremiumUI(true);
        }, 2000);
      }
    } catch (err) {
      console.error("[WebPen] Status poll error:", err);
    }
  }, 2000);
}

/**
 * getExtensionUserId()
 * Returns a stable anonymous ID for this install, used as the PayPal
 * subscription's custom_id so the webhook can link the payment back to the
 * user. Generated once and cached in chrome.storage.sync.
 */
function getExtensionUserId() {
  return new Promise((resolve) => {
    chrome.storage.sync.get("anonId", ({ anonId }) => {
      if (anonId) { resolve(anonId); return; }
      const id = crypto.randomUUID();
      chrome.storage.sync.set({ anonId: id });
      resolve(id);
    });
  });
}
