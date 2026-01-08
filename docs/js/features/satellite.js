/* SnowBridge — features/satellite.js
   Satellite toggle + overlay lifecycle (GitHub Pages safe)
   - Exports:
       installSatelliteStickyZoom(state, deps)
       toggleSatellite(state, force, deps)
       clearViewOverlays(state)
   - Preserves app.js behavior (masked satellite to +8m snow zone) and messages.
   - Adds race-gating to avoid zoomend rebuild thrash.
*/

"use strict";

import { polygonLatLngRingsFromGeoJSON, createOutsideMaskFromGeom } from "../map/geometry.js";

// Matches app.js STYLE.snowOutline today (safe default; can be overridden via deps)
export const DEFAULT_SNOW_OUTLINE_STYLE = Object.freeze({
  weight: 2,
  opacity: 1,
  fillOpacity: 0.0,
  color: "#ffffff",
});

/**
 * Remove mask + snow outline overlays (preserved behavior).
 * @param {object} state
 */
export function clearViewOverlays(state) {
  const st = state;
  if (!st?.map) return;

  if (st.maskLayer) {
    try {
      st.map.removeLayer(st.maskLayer);
    } catch {}
    st.maskLayer = null;
  }
  if (st.snowOutlineLayer) {
    try {
      st.map.removeLayer(st.snowOutlineLayer);
    } catch {}
    st.snowOutlineLayer = null;
  }
}

/**
 * Internal: ensure the satellite tile layer is present when satOn.
 * @param {object} state
 */
function ensureSatelliteLayer(state) {
  const st = state;
  if (!st?.map || !st?.satellite) return false;
  try {
    if (!st.map.hasLayer(st.satellite)) st.satellite.addTo(st.map);
    return true;
  } catch {
    return false;
  }
}

/**
 * Internal: build + add mask + outline for the current roll.
 * Returns true if overlays exist afterwards, false if failed (and will shut satOn off when called from toggle).
 *
 * @param {object} state
 * @param {object} deps
 * @param {any} deps.L
 * @param {(msg:string)=>void} [deps.setStatus1]
 * @param {object} [deps.snowOutlineStyle]
 * @param {boolean} [deps.failSoft] if true, do not flip satOn off on failure (used by zoomend)
 */
function rebuildViewOverlaysForSelectedRoll(state, deps = {}) {
  const st = state;
  const L = deps?.L || (typeof globalThis !== "undefined" ? globalThis.L : null);
  const setStatus1 = typeof deps?.setStatus1 === "function" ? deps.setStatus1 : null;
  const outlineStyle = deps?.snowOutlineStyle || DEFAULT_SNOW_OUTLINE_STYLE;

  const roll = st?.selectedRoll ? String(st.selectedRoll) : null;
  if (!st?.map || !roll) return false;

  const snow = st.snowByRoll?.get?.(roll);
  if (!snow) return false;

  const gj = snow.toGeoJSON?.();
  const geom = gj?.geometry;

  const rings = polygonLatLngRingsFromGeoJSON(geom);
  if (!rings) return false;

  const mask = createOutsideMaskFromGeom(geom, rings, L);
  if (!mask) return false;

  try {
    st.maskLayer = mask.addTo(st.map);
    st.snowOutlineLayer = L.geoJSON(gj, { style: outlineStyle, interactive: false }).addTo(st.map);
    return true;
  } catch (e) {
    try {
      console.warn("Satellite overlay rebuild failed", e);
    } catch {}
    // keep fail-soft option for zoomend; toggleSatellite will handle satOn state + messaging
    if (!deps?.failSoft && setStatus1) {
      try {
        setStatus1("Unable to create mask layer");
      } catch {}
    }
    return false;
  }
}

/**
 * Install the “sticky once enabled” zoomend behavior (preserved), with race gating.
 * Call once after state.map exists (safe even before snow data loads).
 *
 * @param {object} state
 * @param {object} deps
 * @param {any} deps.L Leaflet instance (preferred)
 * @param {object} [deps.snowOutlineStyle] override outline style
 */
export function installSatelliteStickyZoom(state, deps = {}) {
  const st = state;
  if (!st?.map) return;

  if (st._satZoomendInstalled) return;
  st._satZoomendInstalled = true;

  st._satRebuildInFlight = false;
  st._satRebuildPending = false;

  const onZoomEnd = () => {
    if (!st.satOn) return;

    // Preserve: once sat is enabled, ensure satellite layer stays present
    ensureSatelliteLayer(st);

    const roll = st.selectedRoll ? String(st.selectedRoll) : null;
    if (!roll) return;

    const snow = st.snowByRoll?.get?.(roll);
    if (!snow) return;

    // Preserve: only recreate overlays if missing
    if (st.maskLayer && st.snowOutlineLayer) return;

    // Race gating: coalesce rapid zoomend events
    if (st._satRebuildInFlight) {
      st._satRebuildPending = true;
      return;
    }

    st._satRebuildInFlight = true;

    try {
      clearViewOverlays(st);
      rebuildViewOverlaysForSelectedRoll(st, { ...deps, failSoft: true });
    } finally {
      st._satRebuildInFlight = false;

      if (st._satRebuildPending) {
        st._satRebuildPending = false;

        // One more pass to satisfy the latest zoom state
        if (st.satOn && (!st.maskLayer || !st.snowOutlineLayer)) {
          try {
            clearViewOverlays(st);
            rebuildViewOverlaysForSelectedRoll(st, { ...deps, failSoft: true });
          } catch {}
        }
      }
    }
  };

  st._satZoomendHandler = onZoomEnd;
  try {
    st.map.on("zoomend", onZoomEnd);
  } catch {}
}

/**
 * Toggle satellite masked view (behavior preserved).
 *
 * deps:
 * - L: Leaflet instance (preferred; falls back to globalThis.L)
 * - setStatus1: single-line status setter (required to preserve messaging)
 * - snowOutlineStyle: optional override (defaults to app.js style)
 *
 * @param {object} state
 * @param {boolean|undefined} force
 * @param {object} deps
 * @param {any} deps.L
 * @param {(msg:string)=>void} deps.setStatus1
 * @param {object} [deps.snowOutlineStyle]
 */
export function toggleSatellite(state, force, deps = {}) {
  const st = state;
  const setStatus1 = typeof deps?.setStatus1 === "function" ? deps.setStatus1 : null;

  const next = typeof force === "boolean" ? force : !st?.satOn;
  st.satOn = next;

  // Reset race flags when explicitly toggling (prevents stale zoomend work)
  st._satRebuildPending = false;

  clearViewOverlays(st);

  if (!next) {
    try {
      if (st?.map?.hasLayer?.(st.satellite)) st.map.removeLayer(st.satellite);
    } catch {}
    if (setStatus1) {
      const r = st?.selectedRoll ?? "";
      setStatus1(`Satellite OFF • roll ${r}`.trim());
    }
    return;
  }

  const roll = st?.selectedRoll ? String(st.selectedRoll) : null;
  if (!roll) {
    if (setStatus1) setStatus1("Select a parcel first");
    return;
  }

  const minz = st?.cfg?.map?.satelliteEnableMinZoom ?? 16;
  try {
    if (st?.map?.getZoom?.() < minz) st.map.setZoom(minz, { animate: false });
  } catch {}

  const snow = st?.snowByRoll?.get?.(roll);
  if (!snow) {
    st.satOn = false;
    if (setStatus1) setStatus1("Snow zone not found (+8m join mismatch?)");
    return;
  }

  // Ensure satellite tiles are on
  if (!ensureSatelliteLayer(st)) {
    st.satOn = false;
    if (setStatus1) setStatus1("Unable to enable satellite layer");
    return;
  }

  // Build overlays (mask + outline)
  // Gate against concurrent zoomend rebuilds
  if (st._satRebuildInFlight) {
    // Let the in-flight rebuild finish; mark pending to ensure overlays appear.
    st._satRebuildPending = true;
    if (setStatus1) setStatus1(`Satellite ON • roll ${roll}`);
    return;
  }

  st._satRebuildInFlight = true;
  try {
    const ok = rebuildViewOverlaysForSelectedRoll(st, deps);
    if (!ok) {
      // Match app.js failure messaging priority
      st.satOn = false;

      const gj = snow.toGeoJSON?.();
      const geom = gj?.geometry;
      const rings = polygonLatLngRingsFromGeoJSON(geom);

      if (!rings) {
        if (setStatus1) setStatus1("Unable to build mask from snow zone geometry");
      } else {
        // rebuildViewOverlaysForSelectedRoll uses "Unable to create mask layer" if it throws;
        // otherwise we use the same message here.
        if (setStatus1) setStatus1("Unable to create mask layer");
      }
      return;
    }

    if (setStatus1) setStatus1(`Satellite ON • roll ${roll}`);
  } finally {
    st._satRebuildInFlight = false;
  }
}
