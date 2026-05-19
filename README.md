# WebPen — Draw on any webpage

A Manifest V3 browser extension for **Chrome** and **Microsoft Edge** that lets you annotate any page with a floating canvas and toolbar.

---

## Folder Structure

```
webpen/
├── manifest.json       # MV3 extension manifest
├── background.js       # Service worker — handles icon click, tab tracking
├── content.js          # Injected drawing system & toolbar logic
├── content.css         # Injected styles for canvas + toolbar
└── icons/
    ├── icon16.png
    ├── icon48.png
    ├── icon128.png
    ├── icon16_active.png
    ├── icon48_active.png
    └── icon128_active.png
```

---

## Features

| Feature | Details |
|---|---|
| **Canvas overlay** | Full-viewport fixed canvas injected above the page |
| **Pen tool** | Smooth freehand drawing with round caps/joins |
| **Eraser tool** | `destination-out` compositing for clean erasing |
| **Colors** | Red `#e53935`, Blue `#2979ff`, White `#f0f0f0` |
| **Brush size** | Vertical slider from 1 → 40 px |
| **Clear All** | Wipes the entire canvas instantly |
| **Draggable toolbar** | Drag the handle bar to reposition anywhere |
| **Drawing toggle** | Top-right pill button to pause/resume drawing (lets you interact with the page) |
| **Resize handling** | Canvas snapshots and restores drawing on window resize |
| **Teardown** | Clicking the icon again fully removes all injected elements |

---

## Installation

### Chrome
1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `webpen/` folder

### Microsoft Edge
1. Open `edge://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `webpen/` folder

---

## Usage

1. Click the **WebPen icon** in the toolbar to inject the canvas and UI
2. The floating sidebar appears on the left — pick a tool, color, and brush size
3. Draw freely on the page
4. Use the **DRAWING ON/OFF** pill (top-right) to temporarily disable drawing so you can click links or scroll
5. Drag the toolbar handle to reposition it
6. Click **CLR** to clear all marks
7. Click the **WebPen icon** again to remove everything and restore the page

---

## Architecture

```
background.js (service worker)
  │
  ├── tracks active tabs in a Set
  ├── on icon click → chrome.scripting.insertCSS("content.css")
  │                 → chrome.scripting.executeScript("content.js")
  └── on second click → executeScript calls window.__webPenTeardown()

content.js (injected, IIFE-wrapped)
  ├── Creates <canvas id="webpen-canvas"> fixed overlay
  ├── Creates <div id="webpen-toolbar"> floating sidebar
  ├── Creates <div id="webpen-toggle-btn"> top-right pill
  ├── Canvas drawing via mouse events (mousedown/mousemove/mouseup)
  ├── Eraser via globalCompositeOperation = "destination-out"
  ├── Resize handler snapshots/restores canvas content
  └── Exposes window.__webPenTeardown() for clean removal
```
