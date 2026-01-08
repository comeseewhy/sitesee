/* SnowBridge — features/size.js
   Size toggle + overlays lifecycle (GitHub Pages safe)
   - Exports:
       clearSizeOverlays(state)
       toggleSize(state, force, deps)
   - Preserves app.js behavior + status messaging.
*/

"use strict";

import { areaM2FromLayer, fmtArea } from "../map/geometry.js";

// Matches app.js STYLE.sizeOutline today (safe default; can be overridden via deps)
export const DEFAULT_SIZE_OUTLINE_STYLE = Object.freeze({
  weight: 3,
  opacity: 1,
  fillOpacity: 0.0,
  color: "#111827",
});

/**
 * Resolve Leaflet instance.
 * Prefer explicit L, else globalThis.L (preserves current app behavior).
 * @param {any} L
 * @returns {any|null}
 */
function resolveLeaflet(L) {
  if (L) return L;
  try {
    return typeof globalThis !== "undefined" ? globalThis.L : null;
  } catch {
    return null;
  }
}

/**
 * Remove size outline + label overlays (preserved behavior).
 * @param {object} state
 */
export function clearSizeOverlays(state) {
  const st = state;
  if (!st?.map) {
    // Still null the refs (fail-soft)
    if (st) {
      st.sizeOutlineLayer = null;
      st.sizeLabelMarker = null;
    }
    return;
  }

  if (st.sizeOutlineLayer) {
    try {
      st.map.removeLayer(st.sizeOutlineLayer);
    } catch {}
    st.sizeOutlineLayer = null;
  }

  if (st.sizeLabelMarker) {
    try {
      st.map.removeLayer(st.sizeLabelMarker);
    } catch {}
    st.sizeLabelMarker = null;
  }
}

/**
 * Toggle parcel size overlays (behavior preserved).
 *
 * deps:
 * - L: Leaflet instance (preferred; falls back to globalThis.L)
 * - setStatus1: single-line status setter (required to preserve messaging)
 * - sizeOutlineStyle: optional override for outline style
 *
 * @param {object} state
 * @param {boolean|undefined} force
 * @param {object} deps
 * @param {any} deps.L
 * @param {(msg:string)=>void} deps.setStatus1
 * @param {object} [deps.sizeOutlineStyle]
 */
export function toggleSize(state, force, deps = {}) {
  const st = state;
  const L = resolveLeaflet(deps?.L);
  const setStatus1 = typeof deps?.setStatus1 === "function" ? deps.setStatus1 : null;
  const outlineStyle = deps?.sizeOutlineStyle || DEFAULT_SIZE_OUTLINE_STYLE;

  const next = typeof force === "boolean" ? force : !st?.sizeOn;
  st.sizeOn = next;

  clearSizeOverlays(st);

  if (!next) {
    if (setStatus1) {
      const r = st?.selectedRoll ?? "";
      setStatus1(`Size OFF • roll ${r}`.trim());
    }
    return;
  }

  const roll = st?.selectedRoll ? String(st.selectedRoll) : null;
  if (!roll) {
    if (setStatus1) setStatus1("Select a parcel first");
    return;
  }

  const parcel = st?.parcelByRoll?.get?.(roll);
  if (!parcel) {
    if (setStatus1) setStatus1("Parcel not found");
    return;
  }

  if (!st?.map || !L) {
    if (setStatus1) setStatus1("Error • map not ready");
    return;
  }

  const areaM2 = areaM2FromLayer(parcel, { L, map: st.map });
  const txt = `Size • ${fmtArea(areaM2)}`;

  try {
    st.sizeOutlineLayer = L.geoJSON(parcel.toGeoJSON(), {
      style: outlineStyle,
      interactive: false,
    }).addTo(st.map);

    const c = parcel.getBounds().getCenter();
    st.sizeLabelMarker = L.marker(c, { interactive: false, opacity: 0.95 }).addTo(st.map);
    st.sizeLabelMarker
      .bindTooltip(txt, { permanent: true, direction: "top", offset: [0, -8] })
      .openTooltip();
  } catch (e) {
    // Fail-soft: clear partial overlays + message
    try {
      console.warn("Size overlays failed", e);
    } catch {}
    clearSizeOverlays(st);
    st.sizeOn = false;
    if (setStatus1) setStatus1("Error • size overlay failed");
    return;
  }

  if (setStatus1) setStatus1(`${txt} • roll ${roll}`);
}
