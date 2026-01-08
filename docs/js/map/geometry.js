/* SnowBridge — map/geometry.js
   Geometry helpers (GitHub Pages safe)
   - Exports:
       polygonLatLngRingsFromGeoJSON
       createOutsideMaskFromGeom
       areaM2FromLayer
       fmtArea
       lockMapInteractions
   - No DOM. Leaflet may be passed in as L (preferred); includes safe fallbacks.
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
 * Convert a GeoJSON Polygon/MultiPolygon geometry to Leaflet-style [lat,lng] rings.
 * Preserves app.js behavior:
 * - Polygon => [ring1, ring2, ...]
 * - MultiPolygon => [ [ring1, ...], [ring1, ...], ... ] (polygons)
 *
 * @param {any} geom GeoJSON geometry
 * @returns {any[]|null}
 */
export function polygonLatLngRingsFromGeoJSON(geom) {
  if (!geom) return null;

  const toLatLngRing = (ring) => {
    if (!Array.isArray(ring)) return [];
    return ring.map((pt) => {
      const lng = Array.isArray(pt) ? pt[0] : null;
      const lat = Array.isArray(pt) ? pt[1] : null;
      return [lat, lng];
    });
  };

  if (geom.type === "Polygon" && Array.isArray(geom.coordinates)) {
    return geom.coordinates.map(toLatLngRing);
  }

  if (geom.type === "MultiPolygon" && Array.isArray(geom.coordinates)) {
    return geom.coordinates.map((poly) => (Array.isArray(poly) ? poly.map(toLatLngRing) : []));
  }

  return null;
}

/**
 * Create an "outside mask" polygon (world rectangle with parcel/snow-zone outer ring as a hole).
 * Preserves app.js options: stroke:false fill:true fillOpacity:0.65 interactive:false
 *
 * @param {any} geom GeoJSON geometry (Polygon/MultiPolygon)
 * @param {any} ringsOrPolys output from polygonLatLngRingsFromGeoJSON
 * @param {any} [L] Leaflet instance (preferred); falls back to globalThis.L
 * @returns {any|null} Leaflet polygon layer
 */
export function createOutsideMaskFromGeom(geom, ringsOrPolys, L) {
  const Leaflet = resolveLeaflet(L);
  if (!Leaflet || !geom) return null;

  // Keep identical "world" bounds used in app.js
  const outerWorld = [
    [85, -180],
    [85, 180],
    [-85, 180],
    [-85, -180],
  ];

  const holes = [];

  if (geom.type === "Polygon") {
    if (ringsOrPolys?.[0]?.length) holes.push(ringsOrPolys[0]);
  } else if (geom.type === "MultiPolygon") {
    for (const rings of ringsOrPolys || []) {
      if (rings?.[0]?.length) holes.push(rings[0]);
    }
  }

  return Leaflet.polygon([outerWorld, ...holes], {
    stroke: false,
    fill: true,
    fillOpacity: 0.65,
    interactive: false,
  });
}

/**
 * Simple polygon area in m².
 * Preserves app.js behavior:
 * - Use L.GeometryUtil.geodesicArea if present
 * - Else fallback to a rough planar estimate using projected pixels at maxZoom
 *
 * IMPORTANT:
 * - Prefer passing opts.map explicitly.
 * - Fallbacks attempt layer._map (if layer is on a map).
 *
 * @param {any} layer Leaflet layer with getLatLngs() / toGeoJSON()
 * @param {object} [opts]
 * @param {any} [opts.L] Leaflet instance (preferred); falls back to globalThis.L
 * @param {any} [opts.map] Leaflet map instance (preferred); fallback tries layer._map
 * @returns {number|null}
 */
export function areaM2FromLayer(layer, opts = {}) {
  try {
    if (!layer || typeof layer.toGeoJSON !== "function") return null;

    const gj = layer.toGeoJSON();
    const geom = gj?.geometry;
    if (!geom) return null;

    const Leaflet = resolveLeaflet(opts?.L);
    const map = opts?.map || layer?._map || null;

    // If Leaflet GeometryUtil exists (plugin/extra), use it.
    if (Leaflet?.GeometryUtil?.geodesicArea && typeof layer.getLatLngs === "function") {
      const latlngs = layer.getLatLngs();

      // Structure varies; preserve app.js choice:
      // take first ring of first polygon if nested, else first ring
      const ring = Array.isArray(latlngs?.[0]?.[0]) ? latlngs[0][0] : latlngs[0];
      if (Array.isArray(ring) && ring.length >= 3) {
        return Math.abs(Leaflet.GeometryUtil.geodesicArea(ring));
      }
    }

    // Fallback: very rough projected pixel area at maxZoom → meters²
    if (!map || typeof map.project !== "function") return null;
    if (typeof layer.getLatLngs !== "function") return null;

    const latlngs = layer.getLatLngs();
    const ring = Array.isArray(latlngs?.[0]?.[0]) ? latlngs[0][0] : latlngs[0];
    if (!ring || ring.length < 3) return null;

    const maxZ = typeof map.getMaxZoom === "function" ? map.getMaxZoom() : 22;
    const pts = ring.map((ll) => map.project(ll, maxZ));

    let sum = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      sum += a.x * b.y - b.x * a.y;
    }

    const pxArea = Math.abs(sum / 2);

    // Convert pixel² → meters² using CRS scale at maxZoom (same constant as app.js)
    const crs = map.options?.crs;
    const scale = crs && typeof crs.scale === "function" ? crs.scale(maxZ) : null;
    if (!scale || !Number.isFinite(scale) || scale <= 0) return null;

    const metersPerPx = 40075016.68557849 / scale; // Earth circumference / scale
    return pxArea * metersPerPx * metersPerPx;
  } catch (e) {
    try {
      console.warn("Area calc failed", e);
    } catch {}
    return null;
  }
}

/**
 * Format area in a friendly way (matches app.js).
 * @param {number|null} m2
 * @returns {string}
 */
export function fmtArea(m2) {
  if (!Number.isFinite(m2)) return "n/a";
  const acres = m2 / 4046.8564224;
  if (acres >= 1) return `${acres.toFixed(2)} acres`;
  return `${m2.toFixed(0)} m²`;
}

/**
 * Lock/unlock Leaflet map interactions (used for Draw mode).
 * Preserves app.js behavior and handler list.
 *
 * @param {boolean} lock
 * @param {any} map Leaflet map
 */
export function lockMapInteractions(lock, map) {
  const m = map;
  if (!m) return;

  const set = (handler, enabledWhenUnlocked) => {
    if (!handler) return;
    try {
      enabledWhenUnlocked ? handler.enable() : handler.disable();
    } catch {
      /* no-op */
    }
  };

  set(m.dragging, !lock);
  set(m.scrollWheelZoom, !lock);
  set(m.doubleClickZoom, !lock);
  set(m.boxZoom, !lock);
  set(m.keyboard, !lock);
  set(m.touchZoom, !lock);
  set(m.tap, !lock);

  try {
    if (lock && typeof m.stop === "function") m.stop();
  } catch {
    /* no-op */
  }
}
