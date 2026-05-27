/*
 * WebPen — content.js  (injected into host pages via chrome.scripting.executeScript)
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * SECTION 1 — CSP ARCHITECTURE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Content Security Policy (CSP) is a header the HOST PAGE sets, e.g.:
 *   Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-abc'
 *
 * Things that ARE subject to the page's CSP when a content script does them:
 *   • fetch() / XMLHttpRequest to any origin                   → connect-src
 *   • new Worker() / importScripts()                           → worker-src
 *   • document.createElement('script').src = external          → script-src
 *   • @import in a <style> tag injected via innerHTML          → style-src
 *   • @font-face src pointing to an external HTTP URL          → font-src
 *
 * Things that are NOT subject to the page's CSP:
 *   • chrome.runtime.sendMessage() — IPC to the extension SW, not a network call
 *   • chrome.scripting.insertCSS() — treated as extension-origin
 *   • chrome-extension:// URLs in @font-face src              — extension-origin
 *   • fetch() made from background.js (SW origin != page origin)
 *
 * WebPen's CSP-safe rules applied here:
 *
 *   RULE A — No external fetch() from content scripts.
 *     All backend calls (PayPal verify, Drive upload) go through
 *     chrome.runtime.sendMessage() → background.js → fetch().
 *     Background.js runs at the extension's service worker origin and is
 *     completely outside the host page's connect-src directive.
 *
 *   RULE B — No external font/style loads from injected DOM.
 *     The @import was removed from content.css. Instead, injectFont() below
 *     creates a <style> tag with a @font-face rule that points to
 *     chrome-extension:// URLs. These URLs are served from the extension's
 *     own origin and bypass the page's font-src CSP.
 *
 *   RULE C — No eval(), no javascript: URLs, no inline handlers.
 *     All event listeners are attached with addEventListener(). No innerHTML
 *     is used for anything executable. No script tags are created.
 *
 *   RULE D — No PayPal SDK or any 3rd-party <script> injection into the page.
 *     The PayPal SDK <script> tag lives exclusively in popup/popup.html,
 *     which is an extension page (chrome-extension:// origin) and therefore
 *     has its own CSP defined by the extension manifest, not the host page.
 *     The content script never touches PayPal at all.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * SECTION 2 — CANVAS SCROLL & DPR DESIGN
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The canvas is position:fixed (CSS). This means:
 *   • It is anchored to the VIEWPORT top-left, not the document top-left.
 *   • Scrolling the page does NOT move it. The OS compositor slides the
 *     page content underneath it; the canvas layer stays put.
 *   • Drawing coordinates come from MouseEvent.clientX / clientY, which are
 *     also VIEWPORT-relative. So coordinate system matches at every scroll
 *     position — no offset math needed.
 *
 * DPR (devicePixelRatio) handling:
 *   • CSS  dimensions: always 100vw × 100vh (logical pixels).
 *   • Buffer dimensions: Math.round(window.innerWidth  * dpr)
 *                        Math.round(window.innerHeight * dpr)
 *   Without this, at DPR=2 (Retina, most mobile, 150% Windows scaling)
 *   the canvas pixel buffer is half the display resolution → blurry strokes.
 *   ctx.scale(dpr, dpr) after resize maps logical-pixel coordinates to
 *   the physical-pixel buffer so drawing math stays in logical pixels.
 *
 * Resize handling:
 *   • Uses visualViewport API (more accurate than window on mobile/pinch-zoom).
 *   • Snapshots the canvas BEFORE resizing (synchronously), then restores.
 *   • ResizeObserver on document.documentElement catches font-size changes,
 *     mobile keyboard pop-ups, and other layout shifts window.resize misses.
 *   • Debounced 120ms to avoid thrashing during live resize drags.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

(function () {
  "use strict";

  // ── Guard: already injected ─────────────────────────────────────────────────
  if (document.getElementById("webpen-canvas")) return;

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION A — CSP-SAFE FONT INJECTION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * injectFont()
   *
   * Creates a <style> element with @font-face pointing to chrome-extension://
   * URLs. This is the ONLY CSP-safe way to load a custom font from a content
   * script:
   *
   *   ✗ WRONG: @import url('https://fonts.googleapis.com/...')
   *     → Blocked by  style-src 'self'  or  style-src 'nonce-...'
   *     → The import request originates from the PAGE'S origin context
   *
   *   ✓ CORRECT: @font-face { src: url('chrome-extension://EXT_ID/fonts/...') }
   *     → chrome-extension:// is extension-origin, never blocked by page CSP
   *     → Font file must be listed in manifest.json web_accessible_resources
   *
   * We call chrome.runtime.getURL() to get the canonical URL for this
   * specific extension install (the extension ID is baked in at runtime).
   */
  /**
   * SYSTEM_FONT_STACK — safe, zero-network fallback fonts.
   *
   * Used as the fallback in the @font-face src declaration AND as the
   * font-family value if the woff2 file fails to load entirely.
   * These are all pre-installed on every OS; no network request is made.
   *
   *   'Menlo'           — macOS / iOS monospace
   *   'Consolas'        — Windows monospace  
   *   'Liberation Mono' — Linux monospace
   *   'Courier New'     — universal legacy fallback
   *   monospace         — browser's built-in monospace generic
   */
  const SYSTEM_FONT_STACK = "Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace";

  function injectFont() {
    if (document.getElementById("webpen-font-face")) return;

    const regularUrl  = chrome.runtime.getURL("fonts/JetBrainsMono-Regular.woff2");
    const semiboldUrl = chrome.runtime.getURL("fonts/JetBrainsMono-SemiBold.woff2");

    const style = document.createElement("style");
    style.id    = "webpen-font-face";

    // ── @font-face with local() + system fallback chain ───────────────────────
    //
    // src: priority list, tried left-to-right:
    //
    //   1. local('JetBrains Mono')
    //      If the user already has the font installed on their OS, use it
    //      directly — zero network, zero extension storage access needed.
    //
    //   2. url('chrome-extension://…/fonts/JetBrainsMono-Regular.woff2')
    //      Load from the bundled extension file. chrome-extension:// URLs are
    //      extension-origin and never blocked by the page's font-src CSP.
    //      Listed in manifest.json → web_accessible_resources so Chrome serves
    //      them even from content-script context.
    //
    //   3. font-display: swap (changed from block)
    //      'block' would make text invisible for up to 3 s if the woff2 fails.
    //      'swap' renders the fallback font immediately and swaps in WebPenMono
    //      once it loads. UI labels stay readable even if the file is missing.
    //
    // If the woff2 file genuinely fails to load (missing, corrupt, network
    // error), the browser falls back to the generic `monospace` keyword in the
    // font-family stack defined in content.css, which maps to the OS system
    // monospace — the toolbar still looks clean and fully functional.
    style.textContent = `
      @font-face {
        font-family: 'WebPenMono';
        font-weight: 400;
        font-style:  normal;
        font-display: swap;
        src: local('JetBrains Mono'),
             local('JetBrainsMono-Regular'),
             url('${regularUrl}') format('woff2');
      }
      @font-face {
        font-family: 'WebPenMono';
        font-weight: 600;
        font-style:  normal;
        font-display: swap;
        src: local('JetBrains Mono SemiBold'),
             local('JetBrainsMono-SemiBold'),
             url('${semiboldUrl}') format('woff2');
      }

      /*
       * Root fallback rule — applies when WebPenMono itself is unavailable.
       * By listing the system stack here (not just in content.css) we ensure
       * the fallback is self-contained in this style tag and works even if
       * content.css fails to inject for any reason.
       */
      #webpen-toolbar,
      #webpen-toggle-btn,
      #webpen-drive-toast,
      .webpen-btn,
      #webpen-logo,
      #webpen-size-label,
      #webpen-size-value,
      #webpen-clear-btn {
        font-family: 'WebPenMono', ${SYSTEM_FONT_STACK} !important;
      }
    `;

    // Append to <head> (or <html> if head is unavailable, e.g. in frames)
    const target = document.head || document.documentElement;
    target.appendChild(style);

    // ── Load-failure detection ────────────────────────────────────────────────
    //
    // FontFace.load() resolves if the font loaded successfully, or rejects
    // if the src URL failed (404, corrupt file, etc.).
    // On failure we log a clear warning — the UI continues working because
    // font-display:swap + the fallback stack already handles rendering.
    //
    // We only check the Regular weight; if that file is present the extension
    // is set up correctly. SemiBold shares the same directory.
    if (typeof FontFace !== "undefined") {
      const probe = new FontFace("WebPenMono", `url('${regularUrl}') format('woff2')`, {
        weight: "400",
        style:  "normal",
      });

      probe.load().then(() => {
        // Font loaded successfully — nothing to do, CSS is already applied
      }).catch(() => {
        console.warn(
          "[WebPen] JetBrainsMono-Regular.woff2 failed to load. " +
          "Falling back to system monospace (" + SYSTEM_FONT_STACK + "). " +
          "To fix: download the woff2 files from " +
          "https://github.com/JetBrains/JetBrainsMono/tree/master/fonts/webfonts " +
          "and place them in the extension's fonts/ directory."
        );
        // Force all WebPen elements to the system stack immediately,
        // without waiting for the swap timeout
        const override = document.createElement("style");
        override.id    = "webpen-font-fallback";
        override.textContent = `
          #webpen-toolbar, #webpen-toggle-btn, #webpen-drive-toast,
          .webpen-btn, #webpen-logo, #webpen-size-label,
          #webpen-size-value, #webpen-clear-btn {
            font-family: ${SYSTEM_FONT_STACK} !important;
          }
        `;
        target.appendChild(override);
      });
    }
  }

  injectFont();

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION B — STATE
  // ═══════════════════════════════════════════════════════════════════════════

  const state = {
    drawing:   false,   // canvas draw mode active?
    isDown:    false,   // mouse button held
    tool:      "pen",   // "pen" | "eraser"
    color:     "#e53935",
    brushSize: 6,
    lastX:     0,
    lastY:     0,
    screenLocked: false,
  };

  const COLORS = [
    { id: "red",   hex: "#e53935" },
    { id: "blue",  hex: "#2979ff" },
    { id: "black", hex: "#f0f0f0" },
  ];

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION C — CANVAS + DPR SIZING
  // ═══════════════════════════════════════════════════════════════════════════

  const canvas = document.createElement("canvas");
  canvas.id    = "webpen-canvas";

  const ctx = canvas.getContext("2d");

  /**
   * fitCanvas()
   *
   * Sizes the canvas PIXEL BUFFER to match the PHYSICAL display pixels,
   * not just the CSS logical pixels.
   *
   * At DPR=1 (standard display): buffer = CSS size → 1 canvas px per CSS px.
   * At DPR=2 (Retina / 200%):    buffer = 2× CSS size → crisp sub-pixel lines.
   * At DPR=1.5 (150% Windows):   buffer = 1.5× → still crisp.
   *
   * After resizing the buffer, we ctx.scale(dpr, dpr) so all drawing
   * coordinates can remain in LOGICAL pixels — no multiplication needed
   * at the call sites.
   *
   * The CSS width/height are always 100vw/100vh, set once in content.css.
   * We don't change CSS size here — only the pixel buffer and the ctx transform.
   */
  function fitCanvas(snapshot) {
    const dpr = window.devicePixelRatio || 1;
    const vp  = window.visualViewport;

    // Use visualViewport when available — it accounts for pinch-zoom and
    // mobile on-screen keyboards (which shrink the visible area without
    // changing window.innerWidth/Height on some browsers).
    const logicalW = vp ? Math.round(vp.width)  : window.innerWidth;
    const logicalH = vp ? Math.round(vp.height) : window.innerHeight;

    const physicalW = Math.round(logicalW * dpr);
    const physicalH = Math.round(logicalH * dpr);

    // No-op if nothing changed (avoids clearing the canvas on DPR-only events)
    if (canvas.width === physicalW && canvas.height === physicalH) return;

    // Resize buffer (this clears the canvas — restore snapshot after)
    canvas.width  = physicalW;
    canvas.height = physicalH;

    // Scale context so drawing coordinates stay in logical pixels
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Restore previous drawing if we have a snapshot
    if (snapshot) {
      ctx.drawImage(snapshot, 0, 0, logicalW, logicalH);
    }
  }

  // Initial size (no snapshot needed on first call)
  fitCanvas(null);
  document.body.appendChild(canvas);

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION D — TOOLBAR HTML
  // ═══════════════════════════════════════════════════════════════════════════

  const toolbar = document.createElement("div");
  toolbar.id    = "webpen-toolbar";
  toolbar.innerHTML = `
    <div id="webpen-drag-handle"></div>
    <span id="webpen-logo">WP</span>

    <div class="webpen-btn webpen-selected" id="webpen-tool-pen" data-tip="Pen">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
           stroke="rgba(255,255,255,0.75)" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 20h9"/>
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
      </svg>
    </div>

    <div class="webpen-btn" id="webpen-tool-eraser" data-tip="Eraser">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
           stroke="rgba(255,255,255,0.75)" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 20H7L3 16l10-10 7 7-2.5 2.5"/>
        <path d="M6 11l7 7"/>
      </svg>
    </div>

    <div class="webpen-divider"></div>

    ${COLORS.map(c => `
      <div class="webpen-btn ${c.hex === state.color ? "webpen-selected" : ""}"
           id="webpen-color-${c.id}"
           data-color="${c.hex}"
           data-tip="${c.id[0].toUpperCase() + c.id.slice(1)}">
        <span class="webpen-color-dot" style="background:${c.hex}"></span>
      </div>
    `).join("")}

    <div class="webpen-divider"></div>

    <div id="webpen-size-wrap">
      <span id="webpen-size-label">SIZE</span>
      <input id="webpen-size-slider" type="range"
             min="1" max="40" value="${state.brushSize}" />
      <span id="webpen-size-value">${state.brushSize}</span>
    </div>

    <div class="webpen-divider"></div>

    <div class="webpen-divider"></div>

    <div class="webpen-btn" id="webpen-lock-btn" data-tip="Lock screen">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
           stroke="rgba(255,255,255,0.75)" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 9.9-1" />
      </svg>
    </div>

    <div class="webpen-divider"></div>

    <div class="webpen-btn" id="webpen-shot-btn" data-tip="Save screenshot">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
           stroke="rgba(255,255,255,0.75)" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round">
        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
        <circle cx="12" cy="13" r="4"/>
      </svg>
    </div>

    <div class="webpen-btn webpen-drive-btn webpen-hidden"
         id="webpen-drive-btn" data-tip="Sync to Google Drive">
      <svg width="17" height="15" viewBox="0 0 87.3 78" fill="none">
        <path d="M6.6 66.85l3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3L27.5 53H0c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/>
        <path d="M43.65 25L29.9 0c-1.35.8-2.5 1.9-3.3 3.3L1.2 48.5c-.8 1.4-1.2 2.95-1.2 4.5h27.5z" fill="#00ac47"/>
        <path d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75L86.1 57c.8-1.4 1.2-2.95 1.2-4.5H59.8z" fill="#ea4335"/>
        <path d="M43.65 25L57.4 0H29.9z" fill="#00832d"/>
        <path d="M59.8 52.5H87.3c0-1.55-.4-3.1-1.2-4.5L60.8 3.3c-.8-1.4-1.95-2.5-3.3-3.3L43.65 25z" fill="#2684fc"/>
        <path d="M27.5 53l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h51c1.6 0 3.15-.45 4.5-1.2L59.8 53z" fill="#ffba00"/>
      </svg>
    </div>

    <div class="webpen-divider"></div>

    <div class="webpen-btn" id="webpen-clear-btn" data-tip="Clear all drawings" style="margin-top: 2px;">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
           stroke="rgba(255,255,255,0.75)" stroke-width="2.2"
           stroke-linecap="round" stroke-linejoin="round">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        <line x1="10" y1="11" x2="10" y2="17"></line>
        <line x1="14" y1="11" x2="14" y2="17"></line>
      </svg>
    </div>
  `;
  document.body.appendChild(toolbar);

  // ── Toggle pill ────────────────────────────────────────────────────────────
  const toggleBtn     = document.createElement("div");
  toggleBtn.id        = "webpen-toggle-btn";
  toggleBtn.innerHTML = `<span class="webpen-status-dot"></span>DRAWING ON`;
  document.body.appendChild(toggleBtn);

  // ── Initial drawing mode ON ────────────────────────────────────────────────
  enableDrawing();

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION E — TOOLBAR DRAG
  // ═══════════════════════════════════════════════════════════════════════════

  let dragActive = false, dragStartX = 0, dragStartY = 0,
      tbStartLeft = 0, tbStartTop = 0;

  const handle = document.getElementById("webpen-drag-handle");

  handle.addEventListener("mousedown", (e) => {
    dragActive  = true;
    dragStartX  = e.clientX;
    dragStartY  = e.clientY;
    const rect  = toolbar.getBoundingClientRect();
    tbStartLeft = rect.left;
    tbStartTop  = rect.top;
    e.stopPropagation();
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragActive) return;
    toolbar.style.left      = (tbStartLeft + e.clientX - dragStartX) + "px";
    toolbar.style.top       = (tbStartTop  + e.clientY - dragStartY) + "px";
    toolbar.style.transform = "none";
  });

  document.addEventListener("mouseup", () => { dragActive = false; });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION F — DRAWING MODE TOGGLE
  // ═══════════════════════════════════════════════════════════════════════════

  toggleBtn.addEventListener("click", () => {
    if (state.drawing) disableDrawing();
    else               enableDrawing();
  });

  function enableDrawing() {
    state.drawing = true;
    canvas.classList.add("active");
    if (state.tool === "eraser") canvas.classList.add("eraser-mode");
    toggleBtn.innerHTML = `<span class="webpen-status-dot"></span>DRAWING ON`;
    toggleBtn.classList.remove("drawing-off");
  }

  function disableDrawing() {
    state.drawing = false;
    canvas.classList.remove("active", "eraser-mode");
    toggleBtn.innerHTML = `<span class="webpen-status-dot"></span>DRAWING OFF`;
    toggleBtn.classList.add("drawing-off");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION G — TOOL BUTTONS
  // ═══════════════════════════════════════════════════════════════════════════

  function selectTool(tool) {
    state.tool = tool;
    document.getElementById("webpen-tool-pen")
      .classList.toggle("webpen-selected", tool === "pen");
    document.getElementById("webpen-tool-eraser")
      .classList.toggle("webpen-selected", tool === "eraser");
    if (state.drawing) {
      canvas.classList.toggle("eraser-mode", tool === "eraser");
    }
  }

  document.getElementById("webpen-tool-pen")
    .addEventListener("click", () => selectTool("pen"));
  document.getElementById("webpen-tool-eraser")
    .addEventListener("click", () => selectTool("eraser"));

  COLORS.forEach(c => {
    document.getElementById(`webpen-color-${c.id}`)
      .addEventListener("click", () => {
        state.color = c.hex;
        selectTool("pen");
        COLORS.forEach(cc => {
          document.getElementById(`webpen-color-${cc.id}`)
            .classList.toggle("webpen-selected", cc.hex === c.hex);
        });
      });
  });

  const slider  = document.getElementById("webpen-size-slider");
  const sizeVal = document.getElementById("webpen-size-value");
  slider.addEventListener("input", () => {
    state.brushSize    = parseInt(slider.value, 10);
    sizeVal.textContent = state.brushSize;
  });

  document.getElementById("webpen-clear-btn")
    .addEventListener("click", () => {
      // clearRect in logical-pixel coordinates (ctx is already scaled by DPR)
      const dpr = window.devicePixelRatio || 1;
      ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    });

  // Lock / Unlock screen functionality
  const lockBtn = document.getElementById("webpen-lock-btn");

  function updateLockUI() {
    if (!lockBtn) return;
    lockBtn.classList.toggle("webpen-selected", state.screenLocked);
    if (state.screenLocked) {
      lockBtn.setAttribute("data-tip", "Unlock screen");
      lockBtn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
             stroke="#f5c842" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      `;
    } else {
      lockBtn.setAttribute("data-tip", "Lock screen");
      lockBtn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
             stroke="rgba(255,255,255,0.75)" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 9.9-1" />
        </svg>
      `;
    }
  }

  if (lockBtn) {
    lockBtn.addEventListener("click", () => {
      state.screenLocked = !state.screenLocked;
      updateLockUI();
    });
  }

  // Scroll locking event handlers
  const preventDefaultScroll = (e) => {
    if (state.drawing && state.screenLocked) {
      e.preventDefault();
    }
  };

  const scrollKeys = { 32: 1, 33: 1, 34: 1, 35: 1, 36: 1, 37: 1, 38: 1, 39: 1, 40: 1 };
  const preventDefaultForScrollKeys = (e) => {
    if (state.drawing && state.screenLocked && scrollKeys[e.keyCode]) {
      e.preventDefault();
      return false;
    }
  };

  window.addEventListener("wheel", preventDefaultScroll, { passive: false });
  window.addEventListener("touchmove", preventDefaultScroll, { passive: false });
  window.addEventListener("keydown", preventDefaultForScrollKeys, { passive: false });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION H — CANVAS DRAWING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * getPos(e) — returns [x, y] in LOGICAL pixels relative to the canvas.
   *
   * We use e.clientX / e.clientY (viewport-relative) because the canvas
   * is position:fixed. These values are correct at ANY scroll position —
   * no scroll offset correction is needed.
   *
   * getBoundingClientRect() on a fixed element always returns the same
   * rect regardless of scroll, confirming this approach is correct.
   *
   * We do NOT divide by DPR here because ctx.scale(dpr,dpr) already maps
   * logical → physical. Drawing at logical coords is the right thing.
   */
  function getPos(e) {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function configureCtx() {
    ctx.lineJoin  = "round";
    ctx.lineCap   = "round";
    ctx.lineWidth = state.brushSize;

    if (state.tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = state.color;
    }
  }

  function drawDot(x, y) {
    configureCtx();
    ctx.beginPath();
    ctx.arc(x, y, state.brushSize / 2, 0, Math.PI * 2);
    if (state.tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,1)";
    } else {
      ctx.fillStyle = state.color;
    }
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  }

  function drawLine(x1, y1, x2, y2) {
    configureCtx();
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
  }

  canvas.addEventListener("mousedown", (e) => {
    if (!state.drawing) return;
    state.isDown = true;
    [state.lastX, state.lastY] = getPos(e);
    drawDot(state.lastX, state.lastY);
  });

  canvas.addEventListener("mousemove", (e) => {
    if (!state.isDown || !state.drawing) return;
    const [x, y] = getPos(e);
    drawLine(state.lastX, state.lastY, x, y);
    [state.lastX, state.lastY] = [x, y];
  });

  canvas.addEventListener("mouseup",    () => { state.isDown = false; });
  canvas.addEventListener("mouseleave", () => { state.isDown = false; });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION I — SCROLL-SAFE RESIZE HANDLING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * takeSnapshot() — captures current canvas content BEFORE the pixel buffer
   * is cleared by a resize, so it can be restored afterward.
   *
   * Returns an ImageBitmap (not a data URL string) — createImageBitmap is
   * synchronous-ish and far faster than toDataURL for this purpose.
   * Falls back to null if the canvas is blank (no point restoring nothing).
   */
  async function takeSnapshot() {
    // Quick dirty check — if canvas is blank, skip snapshot
    const imageData = ctx.getImageData(0, 0, 1, 1);
    const isEmpty   = imageData.data.every(v => v === 0);
    if (isEmpty) return null;
    try {
      return await createImageBitmap(canvas);
    } catch {
      return null;
    }
  }

  let resizeTimer = null;

  /**
   * handleResize() — debounced handler for both window.resize and
   * visualViewport resize events.
   *
   * WHY DEBOUNCE?
   *   During a live window drag, resize fires 60+ times/second.
   *   Each call takes a snapshot + recreates the canvas buffer.
   *   Debouncing 120ms means we only do the expensive work once
   *   the user stops dragging, not on every pixel of drag.
   *
   * WHY NOT RESIZE ON SCROLL?
   *   Scroll events on a fixed canvas are a no-op — the canvas doesn't
   *   move, and viewport size doesn't change during a plain scroll.
   *   Only true viewport size changes (window resize, mobile keyboard,
   *   browser chrome show/hide) need canvas buffer resizing.
   */
  async function handleResize() {
    clearTimeout(resizeTimer);

    // Capture current DPR state synchronously before any await
    const dpr      = window.devicePixelRatio || 1;
    const vp       = window.visualViewport;
    const logicalW = vp ? Math.round(vp.width)  : window.innerWidth;
    const logicalH = vp ? Math.round(vp.height) : window.innerHeight;
    const physicalW = Math.round(logicalW * dpr);
    const physicalH = Math.round(logicalH * dpr);

    // No actual size change — nothing to do (also covers DPR-only changes
    // that don't affect logical pixel dimensions)
    if (canvas.width === physicalW && canvas.height === physicalH) return;

    resizeTimer = setTimeout(async () => {
      const snapshot = await takeSnapshot();
      fitCanvas(snapshot);
      if (snapshot) snapshot.close?.(); // free ImageBitmap memory
    }, 120);
  }

  // Primary: visualViewport API — accurate on mobile, handles pinch-zoom
  // and soft keyboard. Falls back to window resize event.
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", handleResize);
    // visualViewport scroll fires when the keyboard slides content up —
    // we don't need to resize for that, but we might need to reposition
    // the canvas CSS origin. Since canvas is position:fixed it handles
    // this automatically; no listener needed.
  } else {
    window.addEventListener("resize", handleResize);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION J — SCREENSHOT / CAMERA BUTTON
  // ═══════════════════════════════════════════════════════════════════════════

  document.getElementById("webpen-shot-btn")
    .addEventListener("click", captureScreenshot);

  function captureScreenshot() {
    const btn = document.getElementById("webpen-shot-btn");
    if (btn.dataset.busy === "1") return;
    btn.dataset.busy = "1";
    btn.classList.add("webpen-capturing");

    // Camera-shutter flash
    const flash = document.createElement("div");
    flash.id    = "webpen-flash-overlay";
    document.body.appendChild(flash);
    setTimeout(() => flash.remove(), 400);

    // Export drawing layer — used by background.js to composite over the page
    const drawingDataUrl = canvas.toDataURL("image/png");

    /*
     * CSP RULE A applied here:
     * We do NOT fetch() any URL. We pass the drawing data to background.js
     * via sendMessage. background.js runs in the extension SW origin and
     * calls captureVisibleTab() + triggers the download — both outside the
     * host page's CSP.
     */
    chrome.runtime.sendMessage(
      { action: "webpen-capture", drawingDataUrl },
      (response) => {
        btn.classList.remove("webpen-capturing");
        delete btn.dataset.busy;

        if (chrome.runtime.lastError || !response?.ok) {
          btn.classList.add("webpen-capture-error");
          setTimeout(() => btn.classList.remove("webpen-capture-error"), 1800);
        } else {
          btn.classList.add("webpen-capture-success");
          setTimeout(() => btn.classList.remove("webpen-capture-success"), 1000);
        }
      }
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION K — DRIVE BUTTON (PREMIUM)
  // ═══════════════════════════════════════════════════════════════════════════

  (async () => {
    const { isPremium = false } = await chrome.storage.sync.get("isPremium");
    if (isPremium) revealDriveButton();
  })();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "webpen-premium-activated") revealDriveButton();
  });

  function revealDriveButton() {
    document.getElementById("webpen-drive-btn")?.classList.remove("webpen-hidden");
  }

  document.getElementById("webpen-drive-btn")
    ?.addEventListener("click", () => {
      const btn = document.getElementById("webpen-drive-btn");
      if (btn.dataset.busy === "1") return;
      btn.dataset.busy = "1";
      btn.classList.add("webpen-drive-syncing");

      /*
       * CSP RULE A applied here:
       * Drive upload is initiated from popup.js (extension page), not here.
       * We send a message to trigger the popup flow; the popup handles
       * OAuth + Drive API fetch (popup runs at extension origin, no CSP).
       */
      chrome.runtime.sendMessage(
        { action: "webpen-drive-trigger",
          drawingDataUrl: canvas.toDataURL("image/png") },
        (response) => {
          btn.classList.remove("webpen-drive-syncing");
          delete btn.dataset.busy;

          if (response?.ok) {
            btn.classList.add("webpen-drive-success");
            if (response.webViewLink) {
              showDriveToast(response.webViewLink, response.fileName);
            }
            setTimeout(() => btn.classList.remove("webpen-drive-success"), 2500);
          } else {
            btn.classList.add("webpen-drive-error");
            setTimeout(() => btn.classList.remove("webpen-drive-error"), 2500);
            console.error("[WebPen Drive] Upload failed:", response?.error);
          }
        }
      );
    });

  function showDriveToast(url, fileName) {
    document.getElementById("webpen-drive-toast")?.remove();
    const toast = document.createElement("div");
    toast.id    = "webpen-drive-toast";
    // Safe because url/fileName come from our own extension backend, not page
    const safeFileName = (fileName || "screenshot").replace(/[<>"]/g, "");
    const safeUrl      = url.startsWith("https://drive.google.com") ? url : "#";
    toast.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
           stroke="#4ade80" stroke-width="2.5"
           stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      <span>Saved: ${safeFileName}</span>
      <a href="${safeUrl}" target="_blank" rel="noopener noreferrer">Open ↗</a>
    `;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.classList.add("webpen-toast-fade");
      setTimeout(() => toast.remove(), 400);
    }, 5000);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION L — MESSAGE LISTENER
  // (must be inside IIFE — needs canvas in closure scope)
  // ═══════════════════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.action) {

      // background.js requests the raw drawing layer for compositing
      case "webpen-export-canvas":
        sendResponse({ dataUrl: canvas.toDataURL("image/png") });
        return true;

      // popup.js reports Drive upload success — update toolbar button
      case "webpen-drive-upload-done": {
        const btn = document.getElementById("webpen-drive-btn");
        if (btn) {
          btn.classList.add("webpen-drive-success");
          setTimeout(() => btn.classList.remove("webpen-drive-success"), 2500);
        }
        if (msg.ok && msg.webViewLink) {
          showDriveToast(msg.webViewLink, msg.fileName);
        }
        return false;
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION M — TEARDOWN
  // ═══════════════════════════════════════════════════════════════════════════

  window.__webPenTeardown = function () {
    // Remove viewport resize listener
    if (window.visualViewport) {
      window.visualViewport.removeEventListener("resize", handleResize);
    } else {
      window.removeEventListener("resize", handleResize);
    }

    clearTimeout(resizeTimer);

    // Remove scroll locking listeners
    window.removeEventListener("wheel", preventDefaultScroll);
    window.removeEventListener("touchmove", preventDefaultScroll);
    window.removeEventListener("keydown", preventDefaultForScrollKeys);

    // Remove all injected DOM
    canvas.remove();
    toolbar.remove();
    toggleBtn.remove();
    document.getElementById("webpen-font-face")?.remove();
    document.getElementById("webpen-drive-toast")?.remove();
    document.getElementById("webpen-flash-overlay")?.remove();

    delete window.__webPenTeardown;
  };

})();
