/* SnowBridge — map/queryStage.js
   Query-stage orchestration (GitHub Pages safe)
   - Owns: enter/exit query stage + blink timer + fit/zoom helpers
   - Hard constraints:
       - No DOM construction
       - Preserve timing + invariants
   - Uses injected callbacks for UI/style side-effects:
       - applyParcelStyle(roll)
       - setStatus1(msg)
       - hideContextMenu(menuEl)
       - isPanelOpen() / openPanel()
       - toggleSatellite(false), toggleSize(false), toggleDraw(false)
*/

"use strict";

/**
 * Stop the blinking timer (preserved behavior).
 * @param {object} state
 */
export function stopBlink(state) {
  if (!state) return;
  try {
    if (state.blinkTimer) window.clearInterval(state.blinkTimer);
  } catch {
    /* no-op */
  }
  state.blinkTimer = null;
  state.blinkOn = false;
}

/**
 * Start the blinking timer (preserved behavior: 650ms interval).
 * Calls applyParcelStyle on the selected roll each tick.
 *
 * @param {object} state
 * @param {object} deps
 * @param {(roll:string)=>void} deps.applyParcelStyle
 */
export function startBlink(state, deps = {}) {
  if (!state) return;

  const applyParcelStyle = typeof deps.applyParcelStyle === "function" ? deps.applyParcelStyle : null;

  stopBlink(state);

  state.blinkOn = true;
  state.blinkTimer = window.setInterval(() => {
    state.blinkOn = !state.blinkOn;
    if (state.selectedRoll && applyParcelStyle) applyParcelStyle(state.selectedRoll);
  }, 650);
}

/**
 * Fit the map to a roll's parcel bounds (preserved behavior).
 * @param {object} state
 * @param {string} roll
 */
export function fitToRoll(state, roll) {
  const st = state;
  if (!st?.map || !roll) return;

  const padding = st.cfg?.map?.fitPaddingPx ?? 20;
  const target = st.parcelByRoll?.get?.(String(roll));
  if (!target) return;

  try {
    st.map.fitBounds(target.getBounds(), { padding: [padding, padding] });
  } catch {
    /* no-op */
  }
}

/**
 * Tighten zoom to at least cfg.map.queryZoom (default 19), preserving existing zoom if higher.
 * @param {object} state
 */
export function zoomTight(state) {
  const st = state;
  if (!st?.map) return;

  const qz = st.cfg?.map?.queryZoom ?? 19;
  try {
    const z = Math.max(st.map.getZoom(), qz);
    st.map.setZoom(z);
  } catch {
    /* no-op */
  }
}

/**
 * Enter Query Stage (preserved).
 *
 * Side-effects are injected (no DOM construction in this module):
 * - hideContextMenu(state.ctxMenu)
 * - applyParcelStyle(old/new roll)
 * - setStatus1("Query • roll ...")
 * - openPanel() iff isPanelOpen()
 *
 * @param {object} state
 * @param {string|number} roll
 * @param {object} [opts]
 * @param {[number,number]|null} [opts.center] - [lat,lng]
 * @param {string} [opts.source] - label in status line
 * @param {object} deps
 * @param {(menu:any)=>void} deps.hideContextMenu
 * @param {(roll:string)=>void} deps.applyParcelStyle
 * @param {(msg:string)=>void} deps.setStatus1
 * @param {()=>boolean} deps.isPanelOpen
 * @param {()=>void} deps.openPanel
 */
export function enterQueryStage(state, roll, opts = {}, deps = {}) {
  const st = state;
  if (!st) return;

  const hideContextMenu = typeof deps.hideContextMenu === "function" ? deps.hideContextMenu : null;
  const applyParcelStyle = typeof deps.applyParcelStyle === "function" ? deps.applyParcelStyle : null;
  const setStatus1 = typeof deps.setStatus1 === "function" ? deps.setStatus1 : null;
  const isPanelOpen = typeof deps.isPanelOpen === "function" ? deps.isPanelOpen : null;
  const openPanel = typeof deps.openPanel === "function" ? deps.openPanel : null;

  // preserve: hide context menu when entering
  try {
    if (hideContextMenu) hideContextMenu(st.ctxMenu);
  } catch {
    /* no-op */
  }

  const old = st.selectedRoll;

  st.selectedRoll = String(roll);
  st.isQueryStage = true;

  // preserve: restyle old then new
  try {
    if (old && applyParcelStyle) applyParcelStyle(old);
  } catch {
    /* no-op */
  }
  try {
    if (applyParcelStyle) applyParcelStyle(st.selectedRoll);
  } catch {
    /* no-op */
  }

  // preserve: optional center setView (min zoom 17)
  const center = opts?.center ?? null;
  if (center && st.map) {
    try {
      st.map.setView(center, Math.max(st.map.getZoom(), 17));
    } catch {
      /* no-op */
    }
  }

  fitToRoll(st, st.selectedRoll);
  zoomTight(st);

  startBlink(st, { applyParcelStyle });

  const source = String(opts?.source ?? "");
  if (setStatus1) {
    try {
      setStatus1(`Query • roll ${st.selectedRoll}${source ? ` • ${source}` : ""}`);
    } catch {
      /* no-op */
    }
  }

  // preserve: if panel is already open, refresh it on enter
  try {
    if (isPanelOpen && openPanel && isPanelOpen()) openPanel();
  } catch {
    /* no-op */
  }
}

/**
 * Exit Query Stage (preserved).
 *
 * Preserves side-effect ordering:
 * - stopBlink
 * - toggleSatellite(false)
 * - toggleSize(false)
 * - if drawEnabled: toggleDraw(false)
 * - clear state flags
 * - restyle last roll
 * - setStatus1("Ready • search or click a parcel")
 *
 * @param {object} state
 * @param {object} deps
 * @param {(force:boolean)=>void} deps.toggleSatellite
 * @param {(force:boolean)=>void} deps.toggleSize
 * @param {(force:boolean)=>void} deps.toggleDraw
 * @param {(roll:string)=>void} deps.applyParcelStyle
 * @param {(msg:string)=>void} deps.setStatus1
 */
export function exitQueryStage(state, deps = {}) {
  const st = state;
  if (!st) return;

  const toggleSatellite = typeof deps.toggleSatellite === "function" ? deps.toggleSatellite : null;
  const toggleSize = typeof deps.toggleSize === "function" ? deps.toggleSize : null;
  const toggleDraw = typeof deps.toggleDraw === "function" ? deps.toggleDraw : null;
  const applyParcelStyle = typeof deps.applyParcelStyle === "function" ? deps.applyParcelStyle : null;
  const setStatus1 = typeof deps.setStatus1 === "function" ? deps.setStatus1 : null;

  stopBlink(st);

  // preserve: shut off overlays/modes when exiting
  try {
    if (toggleSatellite) toggleSatellite(false);
  } catch {}
  try {
    if (toggleSize) toggleSize(false);
  } catch {}
  try {
    if (st.drawEnabled && toggleDraw) toggleDraw(false);
  } catch {}

  const roll = st.selectedRoll;

  st.isQueryStage = false;
  st.selectedRoll = null;

  try {
    if (roll && applyParcelStyle) applyParcelStyle(String(roll));
  } catch {
    /* no-op */
  }

  try {
    if (setStatus1) setStatus1("Ready • search or click a parcel");
  } catch {
    /* no-op */
  }
}
