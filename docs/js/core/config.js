/* SnowBridge — core/config.js
   Config + JSON loading (GitHub Pages safe)
   - Exports FALLBACK_CFG, loadJSON, loadConfigOrFallback
   - Preserves app.js behavior: same fetch options, same fallback rules/messages.
   - No DOM, no Leaflet.
*/

"use strict";

// -----------------------------
// Fallback config (must match app.js today)
// -----------------------------
export const FALLBACK_CFG = Object.freeze({
  map: {
    startView: { lat: 42.93, lng: -80.28, zoom: 14 },
    minZoom: 11,
    maxZoom: 22,
    fitPaddingPx: 20,
    satelliteEnableMinZoom: 16,
    queryZoom: 19,
  },
  data: {
    joinKey: "ROLLNUMSHO",
    files: {
      addresses: "./SnowBridge_addresses_4326.geojson",
      parcels: "./SnowBridge_parcels_4326.geojson",
      snowZone: "./SnowBridge_parcels_+8m_4326.geojson",
    },
  },
  basemaps: {
    base: {
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      options: {
        maxNativeZoom: 19,
        maxZoom: 22,
        attribution: "© OpenStreetMap contributors",
      },
    },
    satellite: {
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      options: {
        maxNativeZoom: 19,
        maxZoom: 22,
        attribution: "Tiles © Esri",
      },
    },
  },
});

// -----------------------------
// JSON loader (behavior preserved)
// -----------------------------
export async function loadJSON(url) {
  console.log("Fetching:", url);
  const res = await fetch(url, { cache: "no-store" }); // preserve: no-store
  if (!res.ok) throw new Error(`${url} → ${res.status} ${res.statusText}`);
  return res.json();
}

// -----------------------------
// Config loader with fallback (behavior preserved)
// -----------------------------
/**
 * Load ./config.json, validate minimally, else fallback.
 * @param {object} opts
 * @param {(msg:string)=>void} [opts.onStatus] - optional status callback (e.g. app.js setStatus)
 * @param {string} [opts.url] - override config url (default "./config.json")
 * @returns {Promise<object>} cfg (either loaded cfg or FALLBACK_CFG)
 */
export async function loadConfigOrFallback(opts = {}) {
  const onStatus = typeof opts.onStatus === "function" ? opts.onStatus : null;
  const url = opts.url || "./config.json";

  try {
    const cfg = await loadJSON(url);

    // Preserve the same minimal validation from app.js
    if (!cfg?.data?.files?.parcels) throw new Error("config missing data.files.parcels");

    return cfg;
  } catch (e) {
    console.warn("Config load failed; using fallback config.", e);

    // Preserve message + "still running" behavior (single-line safe)
    if (onStatus) onStatus("Config not loaded (fallback mode) — still running.");

    return FALLBACK_CFG;
  }
}
