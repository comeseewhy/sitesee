/* SnowBridge — map/layers.js
   Leaflet GeoJSON layer builders + roll→layer Maps (GitHub Pages safe)
   - Exports: buildParcelsLayer, buildSnowLayer
   - Hard constraints:
       - Handler injection (no UI imports)
       - Join-key logic sacred: treat roll/join values as strings consistently
   - Behavior preserved from app.js defaults:
       - Parcels: interactive, styled, click + contextmenu events wired (via injected handlers)
       - Snow: non-interactive, thin outline, builds snowByRoll map
*/

"use strict";

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
 * Get a Map to store roll→layer.
 * Prefers opts.byRollMap, else opts.state[mapKey], else creates a fresh Map.
 * @param {object} opts
 * @param {string} mapKey
 * @returns {Map<string, any>}
 */
function resolveByRollMap(opts, mapKey) {
  const m = opts?.byRollMap;
  if (m && typeof m.set === "function" && typeof m.clear === "function") return m;

  const st = opts?.state;
  const sm = st && st[mapKey];
  if (sm && typeof sm.set === "function" && typeof sm.clear === "function") return sm;

  // fallback (non-breaking): still builds a usable map for callers
  return new Map();
}

/**
 * Default parcel style (matches app.js STYLE.idleParcel today).
 * Kept here as a safe fallback; callers may pass opts.style.
 */
const DEFAULT_PARCEL_STYLE = Object.freeze({
  weight: 1,
  opacity: 0.8,
  fillOpacity: 0.08,
  color: "#2563eb",
});

/**
 * Default snow style (matches app.js buildSnowLayer today).
 */
const DEFAULT_SNOW_STYLE = Object.freeze({
  weight: 1,
  opacity: 0.35,
  fillOpacity: 0.0,
});

/**
 * Build the parcels GeoJSON layer and populate roll→layer map.
 *
 * Handler injection:
 * - opts.onClick({ roll, feature, layer, event })
 * - opts.onContextMenu({ roll, pxX, pxY, feature, layer, event })
 *
 * @param {object} geojson GeoJSON FeatureCollection
 * @param {string} joinKey feature.properties[joinKey] provides the roll/join value
 * @param {object} [opts]
 * @param {any} [opts.L] Leaflet instance (preferred); falls back to globalThis.L
 * @param {object} [opts.state] optional app state; if provided, uses state.parcelByRoll
 * @param {Map<string, any>} [opts.byRollMap] optional explicit map; overrides state
 * @param {object|function} [opts.style] Leaflet style object or function(feature) => style
 * @param {(ctx:{roll:string,feature:any,layer:any,event:any})=>void} [opts.onClick]
 * @param {(ctx:{roll:string,pxX:number,pxY:number,feature:any,layer:any,event:any})=>void} [opts.onContextMenu]
 * @returns {any} Leaflet GeoJSON layer
 */
export function buildParcelsLayer(geojson, joinKey, opts = {}) {
  const Leaflet = resolveLeaflet(opts?.L);
  if (!Leaflet) throw new Error("Leaflet not available (L is undefined).");

  const byRoll = resolveByRollMap(opts, "parcelByRoll");
  byRoll.clear();

  const onClick = typeof opts?.onClick === "function" ? opts.onClick : null;
  const onContextMenu = typeof opts?.onContextMenu === "function" ? opts.onContextMenu : null;

  const styleOpt = opts?.style ?? DEFAULT_PARCEL_STYLE;

  return Leaflet.geoJSON(geojson, {
    style: styleOpt,
    onEachFeature: (feature, layer) => {
      const raw = feature?.properties?.[joinKey];
      const roll = raw != null ? String(raw) : null;

      if (roll != null) byRoll.set(roll, layer);

      // Preserve app.js: click handler exists on parcel features
      layer.on("click", (e) => {
        if (roll == null) return;
        if (!onClick) return;
        try {
          onClick({ roll, feature, layer, event: e });
        } catch (err) {
          try {
            console.warn("Parcels onClick handler failed", err);
          } catch {}
        }
      });

      // Preserve app.js: contextmenu handler exists on parcel features
      layer.on("contextmenu", (e) => {
        if (roll == null) return;
        if (!onContextMenu) return;

        const pxX = e?.originalEvent?.clientX ?? 0;
        const pxY = e?.originalEvent?.clientY ?? 0;

        try {
          onContextMenu({
            roll,
            pxX: Number.isFinite(pxX) ? pxX : 0,
            pxY: Number.isFinite(pxY) ? pxY : 0,
            feature,
            layer,
            event: e,
          });
        } catch (err) {
          try {
            console.warn("Parcels onContextMenu handler failed", err);
          } catch {}
        }
      });
    },
  });
}

/**
 * Build the snow zone (+8m) GeoJSON layer and populate roll→layer map.
 * IMPORTANT: snow layer is non-interactive (matches app.js).
 *
 * @param {object} geojson GeoJSON FeatureCollection
 * @param {string} joinKey feature.properties[joinKey] provides the roll/join value
 * @param {object} [opts]
 * @param {any} [opts.L] Leaflet instance (preferred); falls back to globalThis.L
 * @param {object} [opts.state] optional app state; if provided, uses state.snowByRoll
 * @param {Map<string, any>} [opts.byRollMap] optional explicit map; overrides state
 * @param {object|function} [opts.style] Leaflet style object or function(feature) => style
 * @returns {any} Leaflet GeoJSON layer
 */
export function buildSnowLayer(geojson, joinKey, opts = {}) {
  const Leaflet = resolveLeaflet(opts?.L);
  if (!Leaflet) throw new Error("Leaflet not available (L is undefined).");

  const byRoll = resolveByRollMap(opts, "snowByRoll");
  byRoll.clear();

  const styleOpt = opts?.style ?? DEFAULT_SNOW_STYLE;

  return Leaflet.geoJSON(geojson, {
    interactive: false, // non-negotiable: preserves app.js
    style: styleOpt,
    onEachFeature: (feature, layer) => {
      const raw = feature?.properties?.[joinKey];
      if (raw == null) return;
      byRoll.set(String(raw), layer);
    },
  });
}
