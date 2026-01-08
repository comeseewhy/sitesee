/* SnowBridge — features/draw.js
   Canvas lifecycle + draw mode toggle + map interaction locking (GitHub Pages safe)
   - Exports:
       ensureDrawCanvas
       resizeCanvasToMap
       clearCanvas
       canvasToDataUrl
       loadDataUrlToCanvas
       enableDrawMode
       disableDrawMode
       toggleDraw
   - Behavior preserved from app.js (spray paint, sizing, status messages, locking).
*/

"use strict";

import { lockMapInteractions } from "../map/geometry.js";

// DOM ID (must match styles.css + app.js)
export const CANVAS_ID = "sbCanvas";

/**
 * Resolve map container element where the canvas should live.
 * Preserves app.js: append to #map.
 * @param {any} mapElOrId
 * @returns {HTMLElement|null}
 */
function resolveMapContainer(mapElOrId = null) {
  if (mapElOrId && typeof mapElOrId === "object" && mapElOrId.nodeType === 1) {
    return /** @type {HTMLElement} */ (mapElOrId);
  }
  const id = typeof mapElOrId === "string" && mapElOrId.trim() ? mapElOrId.trim() : "map";
  try {
    return document.getElementById(id);
  } catch {
    return null;
  }
}

/**
 * Ensure the drawing canvas exists and is attached to the map container.
 * Preserves app.js inline styles + behavior.
 *
 * @param {object} state - expects state.canvas and/or assigns it
 * @param {object} [opts]
 * @param {HTMLElement|string} [opts.mapEl] - map container element or id (default "#map")
 * @param {string} [opts.id] - canvas id (default "sbCanvas")
 * @returns {HTMLCanvasElement|null}
 */
export function ensureDrawCanvas(state, opts = {}) {
  const st = state;
  const id = String(opts?.id || CANVAS_ID).trim();

  /** @type {HTMLCanvasElement|null} */
  let c = null;

  try {
    c = /** @type {HTMLCanvasElement|null} */ (document.getElementById(id));
  } catch {
    c = null;
  }

  if (!c) {
    const host = resolveMapContainer(opts?.mapEl || "map");
    if (!host) return null;

    c = document.createElement("canvas");
    c.id = id;

    // Preserve app.js inline presentation
    c.style.position = "absolute";
    c.style.left = "0";
    c.style.top = "0";
    c.style.zIndex = "8000";
    c.style.pointerEvents = "none";
    c.style.display = "none";

    host.appendChild(c);
  }

  if (st) st.canvas = c;
  return c;
}

/**
 * Resize canvas to match Leaflet map size (preserved).
 * @param {object} state - expects state.canvas and state.map
 */
export function resizeCanvasToMap(state) {
  const st = state;
  const c = st?.canvas;
  const map = st?.map;
  if (!c || !map) return;

  try {
    const size = map.getSize();
    c.width = size.x;
    c.height = size.y;
  } catch {
    /* no-op */
  }
}

/**
 * Clear the canvas (preserved).
 * @param {object} state
 */
export function clearCanvas(state) {
  const c = state?.canvas;
  if (!c) return;
  try {
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
  } catch {
    /* no-op */
  }
}

/**
 * Capture canvas to a PNG data URL (preserved).
 * @param {object} state
 * @returns {string|null}
 */
export function canvasToDataUrl(state) {
  const c = state?.canvas;
  if (!c) return null;
  try {
    return c.toDataURL("image/png");
  } catch {
    return null;
  }
}

/**
 * Load a PNG data URL onto the canvas (preserved).
 * @param {object} state
 * @param {string} dataUrl
 * @returns {Promise<boolean>}
 */
export function loadDataUrlToCanvas(state, dataUrl) {
  return new Promise((resolve) => {
    const c = state?.canvas;
    if (!c) return resolve(false);

    let ctx = null;
    try {
      ctx = c.getContext("2d");
    } catch {
      ctx = null;
    }
    if (!ctx) return resolve(false);

    const img = new Image();
    img.onload = () => {
      try {
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0);
        resolve(true);
      } catch {
        resolve(false);
      }
    };
    img.onerror = () => resolve(false);

    try {
      img.src = String(dataUrl || "");
    } catch {
      resolve(false);
    }
  });
}

/**
 * Enable draw mode (spray paint) — preserved.
 *
 * deps:
 * - setStatus1(msg): required to preserve one-line status behavior
 * - toggleSatellite(true): used to force satellite ON for drawing (preserved)
 * - ensureSatelliteOn: optional boolean; if false, will not force satellite (default true)
 * - drawZoom: optional zoom level (default 22; preserved)
 *
 * @param {object} state
 * @param {object} deps
 * @param {(msg:string)=>void} deps.setStatus1
 * @param {(force:boolean)=>void} [deps.toggleSatellite]
 * @param {boolean} [deps.ensureSatelliteOn=true]
 * @param {number} [deps.drawZoom=22]
 */
export function enableDrawMode(state, deps = {}) {
  const st = state;
  if (!st) return;

  const setStatus1 = typeof deps?.setStatus1 === "function" ? deps.setStatus1 : null;
  const toggleSatellite = typeof deps?.toggleSatellite === "function" ? deps.toggleSatellite : null;

  st.drawEnabled = true;

  // Preserve: drawing requires satellite; attempt to force ON
  const ensureSat = deps?.ensureSatelliteOn !== false;
  if (ensureSat && !st.satOn && toggleSatellite) toggleSatellite(true);

  // Preserve: if still not on, bail (no silent regression)
  if (ensureSat && !st.satOn) return;

  // Preserve: lock map interactions
  lockMapInteractions(true, st.map);

  // Preserve: zoom + center behavior
  const drawZoom = Number.isFinite(Number(deps?.drawZoom)) ? Number(deps.drawZoom) : 22;

  try {
    const roll = st.selectedRoll;
    const parcel = roll ? st.parcelByRoll.get(String(roll)) : null;
    if (parcel) {
      const c = parcel.getBounds().getCenter();
      st.map.setView(c, drawZoom, { animate: false });
    } else {
      st.map.setZoom(drawZoom, { animate: false });
    }
  } catch {
    /* no-op */
  }

  const c = st.canvas;
  if (!c) return;

  // Preserve: canvas visible + interactive
  c.style.display = "block";
  c.style.pointerEvents = "auto";
  c.style.cursor = "crosshair";

  if (setStatus1) {
    const r = st.selectedRoll ?? "";
    setStatus1(`Draw ON • roll ${r}`.trim());
  }

  let drawing = false;

  // Preserve constants
  const brushR = 18;
  const dotsPerSpray = 26;

  const ctx = c.getContext("2d");
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "rgba(255,255,255,0.35)";

  const spray = (x, y) => {
    for (let i = 0; i < dotsPerSpray; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * brushR;
      const dx = Math.cos(a) * r;
      const dy = Math.sin(a) * r;
      ctx.beginPath();
      ctx.arc(x + dx, y + dy, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  const toCanvasXY = (e) => {
    const rect = c.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onDown = (e) => {
    if (!st.drawEnabled) return;
    drawing = true;
    try {
      e.preventDefault();
    } catch {}
    const { x, y } = toCanvasXY(e);
    spray(x, y);
    st.hasUnsavedDrawing = true;
  };

  const onMove = (e) => {
    if (!st.drawEnabled || !drawing) return;
    const { x, y } = toCanvasXY(e);
    spray(x, y);
    st.hasUnsavedDrawing = true;
  };

  const onUp = () => {
    drawing = false;
  };

  c.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);

  st._drawHandlers = { onDown, onMove, onUp };
}

/**
 * Disable draw mode (preserved).
 * @param {object} state
 * @param {object} deps
 * @param {(msg:string)=>void} [deps.setStatus1]
 */
export function disableDrawMode(state, deps = {}) {
  const st = state;
  if (!st) return;

  const setStatus1 = typeof deps?.setStatus1 === "function" ? deps.setStatus1 : null;

  st.drawEnabled = false;

  lockMapInteractions(false, st.map);

  const c = st.canvas;
  if (c) {
    c.style.pointerEvents = "none";
    c.style.cursor = "default";
  }

  if (setStatus1) {
    const r = st.selectedRoll ?? "";
    setStatus1(`Draw OFF • roll ${r}`.trim());
  }

  const h = st._drawHandlers;
  if (h && c) {
    try {
      c.removeEventListener("mousedown", h.onDown);
    } catch {}
    try {
      window.removeEventListener("mousemove", h.onMove);
    } catch {}
    try {
      window.removeEventListener("mouseup", h.onUp);
    } catch {}
  }
  st._drawHandlers = null;
}

/**
 * Toggle draw mode — preserved (including satellite precondition and final status line).
 *
 * deps:
 * - setStatus1(msg): required (messaging)
 * - toggleSatellite(force): required for "turn on sat first" behavior
 *
 * @param {object} state
 * @param {boolean|undefined} force
 * @param {object} deps
 * @param {(msg:string)=>void} deps.setStatus1
 * @param {(force:boolean)=>void} deps.toggleSatellite
 */
export function toggleDraw(state, force, deps = {}) {
  const st = state;
  if (!st) return;

  const setStatus1 = typeof deps?.setStatus1 === "function" ? deps.setStatus1 : null;
  const toggleSatellite = typeof deps?.toggleSatellite === "function" ? deps.toggleSatellite : null;

  const next = typeof force === "boolean" ? force : !st.drawEnabled;

  if (next) {
    // Preserve: ensure satellite ON before enabling draw
    if (!st.satOn && toggleSatellite) toggleSatellite(true);
    if (!st.satOn) return;

    enableDrawMode(st, { setStatus1, toggleSatellite, ensureSatelliteOn: false });
    return;
  }

  disableDrawMode(st, { setStatus1 });

  if (st.canvas) st.canvas.style.display = "none";

  // Preserve: app.js set status again after hiding
  if (setStatus1) {
    const r = st.selectedRoll ?? "";
    setStatus1(`Draw OFF • roll ${r}`.trim());
  }
}
