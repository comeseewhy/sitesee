/* SnowBridge — app.js (robust framework)
   Goals:
   1) Always show basemap + parcels, centered to data bounds.
   2) Address autocomplete from addresses.full_addr (2000-ish).
   3) Go -> select parcel by ROLLNUMSHO (highlight + zoom).
   4) View -> show satellite ONLY within +8m parcel boundary (mask outside).
   5) Draw -> (stub) structured hook for later Leaflet.draw integration.

   Notes:
   - Works even if config.json is missing or invalid (uses fallbacks).
   - Emits clear status + console logs so you can debug fast on GitHub Pages.
*/

(() => {
  "use strict";

  // -----------------------------
  // DOM
  // -----------------------------
  const $ = (id) => document.getElementById(id);

  const el = {
    map: $("map"),
    addrInput: $("addrInput"),
    addrBtn: $("addrBtn"),
    modeToggle: $("modeToggle"), // not used in this version (kept compatible)
    satToggle: $("satToggle"),   // treated as "manual satellite" (optional)
    status: $("status"),
    topbar: $("topbar"),
  };

  function setStatus(msg) {
    if (!el.status) return;
    el.status.textContent = String(msg ?? "").replace(/\s+/g, " ").trim();
  }

  function hardFail(msg, err) {
    console.error(msg, err || "");
    setStatus(`Error: ${msg}`);
  }

  // If Leaflet didn’t load, stop early with a clear message
  if (typeof L === "undefined") {
    hardFail("Leaflet failed to load (L is undefined). Check Leaflet <script> tag.");
    return;
  }
  if (!el.map) {
    hardFail("Missing #map element in index.html");
    return;
  }

  // -----------------------------
  // Config loading (optional)
  // -----------------------------
  const FALLBACK_CFG = {
    map: { maxZoom: 19, minZoom: 11, fitPaddingPx: 20 },
    data: {
      joinKey: "ROLLNUMSHO",
      files: {
        addresses: "../data/SnowBridge_addresses_4326.geojson",
        parcels: "../data/SnowBridge_parcels_4326.geojson",
        snowZone: "../data/SnowBridge_parcels_+8m_4326.geojson",
        centroids: "../data/SnowBridge_centroids_4326.geojson",
      },
    },
    basemaps: {
      base: {
        url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        options: { maxZoom: 19, attribution: "© OpenStreetMap contributors" },
      },
      satellite: {
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        options: { maxZoom: 19, attribution: "Tiles © Esri" },
      },
    },
  };

  async function loadJSON(url) {
    console.log("Fetching:", url);
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${url} → ${res.status} ${res.statusText}`);
    return res.json();
  }

  async function loadConfigOrFallback() {
    try {
      const cfg = await loadJSON("./config.json");
      // Very small sanity check:
      if (!cfg?.data?.files?.parcels) throw new Error("config missing data.files.parcels");
      return cfg;
    } catch (e) {
      console.warn("Config load failed; using fallback config.", e);
      setStatus("Config not loaded (fallback mode) — still running.");
      return FALLBACK_CFG;
    }
  }

  // -----------------------------
  // Utility: bounds + geometry
  // -----------------------------
  function unionBounds(boundsList) {
    let out = null;
    for (const b of boundsList) {
      if (!b) continue;
      out = out ? out.extend(b) : b;
    }
    return out;
  }

  function normalizeAddr(s) {
    return String(s ?? "")
      .toUpperCase()
      .replace(/[.,]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Convert GeoJSON Polygon/MultiPolygon -> array of rings as LatLngs
  // Leaflet expects [ [latlng, latlng...], [hole...], ... ]
  function polygonLatLngRingsFromGeoJSON(geom) {
    if (!geom) return null;

    const toLatLngRing = (ring) => ring.map(([lng, lat]) => [lat, lng]);

    if (geom.type === "Polygon") {
      return geom.coordinates.map(toLatLngRing);
    }

    if (geom.type === "MultiPolygon") {
      // Flatten: keep each polygon as its own set of rings.
      // We’ll return an array of polygons, each polygon = rings[]
      return geom.coordinates.map((poly) => poly.map(toLatLngRing));
    }

    return null;
  }

  // Create an "outside mask" so satellite appears ONLY inside the selected shape.
  // Technique: big outer ring (world rectangle) with HOLE = selected polygon outer ring(s)
  function createOutsideMaskForPolygonRings(polygonRings) {
    // polygonRings is rings[] for Polygon (rings[0] is outer)
    const outerWorld = [
      [85, -180],
      [85, 180],
      [-85, 180],
      [-85, -180],
    ];

    // Leaflet holes: [outerWorld, hole1, hole2...]
    // We want the HOLE to be the parcel area, so the mask covers everything else.
    const holes = [];

    // Use only outer ring for hole; ignore internal holes for now (rare in parcels).
    if (polygonRings && polygonRings[0] && polygonRings[0].length) {
      holes.push(polygonRings[0]);
    }

    return L.polygon([outerWorld, ...holes], {
      stroke: false,
      fill: true,
      fillOpacity: 0.65,
      // no explicit color per your preference; Leaflet default is okay
      interactive: false,
    });
  }

  // For MultiPolygon, make multiple holes in the same mask
  function createOutsideMaskForMultiPolygon(polygonsRings) {
    const outerWorld = [
      [85, -180],
      [85, 180],
      [-85, 180],
      [-85, -180],
    ];

    const holes = [];
    for (const rings of polygonsRings) {
      if (rings?.[0]?.length) holes.push(rings[0]);
    }

    return L.polygon([outerWorld, ...holes], {
      stroke: false,
      fill: true,
      fillOpacity: 0.65,
      interactive: false,
    });
  }

  // -----------------------------
  // UI: Suggestions + View button
  // -----------------------------
  function ensureViewButton() {
    let btn = $("viewBtn");
    if (btn) return btn;

    btn = document.createElement("button");
    btn.id = "viewBtn";
    btn.type = "button";
    btn.textContent = "View";
    btn.disabled = true;

    // minimal inline styling so it looks okay even if CSS changes
    btn.style.padding = "8px 12px";
    btn.style.borderRadius = "8px";
    btn.style.border = "1px solid #d1d5db";
    btn.style.background = "#f9fafb";
    btn.style.cursor = "pointer";

    // insert next to Go button
    if (el.addrBtn?.parentNode) {
      el.addrBtn.parentNode.insertBefore(btn, el.addrBtn.nextSibling);
    } else if (el.topbar) {
      el.topbar.appendChild(btn);
    }
    return btn;
  }

  function ensureSuggestBox() {
    let box = $("addrSuggest");
    if (box) return box;

    box = document.createElement("div");
    box.id = "addrSuggest";
    box.style.position = "absolute";
    box.style.zIndex = "9999";
    box.style.display = "none";
    box.style.maxHeight = "260px";
    box.style.overflow = "auto";
    box.style.background = "#fff";
    box.style.border = "1px solid #d1d5db";
    box.style.borderRadius = "8px";
    box.style.boxShadow = "0 6px 18px rgba(0,0,0,0.10)";
    box.style.fontFamily = "system-ui, Arial, sans-serif";
    box.style.fontSize = "14px";

    document.body.appendChild(box);
    return box;
  }

  function positionSuggestBox(box) {
    if (!el.addrInput) return;
    const r = el.addrInput.getBoundingClientRect();
    box.style.left = `${Math.round(r.left)}px`;
    box.style.top = `${Math.round(r.bottom + 6)}px`;
    box.style.width = `${Math.round(r.width)}px`;
  }

  function renderSuggestions(box, items, onPick) {
    box.innerHTML = "";
    if (!items.length) {
      box.style.display = "none";
      return;
    }

    for (const it of items) {
      const row = document.createElement("div");
      row.textContent = it.label;
      row.style.padding = "10px 10px";
      row.style.cursor = "pointer";
      row.style.whiteSpace = "nowrap";
      row.style.overflow = "hidden";
      row.style.textOverflow = "ellipsis";

      row.addEventListener("mouseenter", () => (row.style.background = "#f3f4f6"));
      row.addEventListener("mouseleave", () => (row.style.background = "transparent"));
      row.addEventListener("click", () => onPick(it));

      box.appendChild(row);
    }

    positionSuggestBox(box);
    box.style.display = "block";
  }

  // -----------------------------
  // App state
  // -----------------------------
  const state = {
    cfg: null,
    map: null,
    basemap: null,
    satellite: null,

    parcelsLayer: null,
    snowLayer: null,

    parcelByRoll: new Map(),
    snowByRoll: new Map(),

    addresses: [], // { label, norm, roll, lat, lng }
    selectedRoll: null,

    // overlays for View-mode
    maskLayer: null,
    snowOutlineLayer: null,

    // ui
    viewBtn: null,
    suggestBox: null,
    viewEnabled: false,
  };

  // -----------------------------
  // Core map + layers
  // -----------------------------
  function buildParcelsLayer(geojson, joinKey) {
    state.parcelByRoll.clear();

    const lyr = L.geoJSON(geojson, {
      style: { weight: 1, opacity: 0.7, fillOpacity: 0.08 },
      onEachFeature: (feature, layer) => {
        const roll = feature?.properties?.[joinKey];
        if (roll != null) state.parcelByRoll.set(String(roll), layer);

        layer.on("click", () => {
          if (roll == null) return;
          selectRoll(String(roll), { zoom: true, enableView: true });
        });
      },
    });

    return lyr;
  }

  function buildSnowLayer(geojson, joinKey) {
    state.snowByRoll.clear();

    const lyr = L.geoJSON(geojson, {
      style: { weight: 1, opacity: 0.55, fillOpacity: 0.04 },
      onEachFeature: (feature, layer) => {
        const roll = feature?.properties?.[joinKey];
        if (roll != null) state.snowByRoll.set(String(roll), layer);
      },
    });

    return lyr;
  }

  function clearSelectionStyles() {
    if (!state.selectedRoll) return;
    const p = state.parcelByRoll.get(state.selectedRoll);
    if (p) p.setStyle({ weight: 1, opacity: 0.7, fillOpacity: 0.08 });

    const s = state.snowByRoll.get(state.selectedRoll);
    if (s) s.setStyle({ weight: 1, opacity: 0.55, fillOpacity: 0.04 });
  }

  function applySelectionStyles(roll) {
    const p = state.parcelByRoll.get(roll);
    if (p) p.setStyle({ weight: 3, opacity: 1, fillOpacity: 0.16 });

    // show the +8m boundary subtly even before View
    const s = state.snowByRoll.get(roll);
    if (s) s.setStyle({ weight: 2, opacity: 0.9, fillOpacity: 0.06 });

    if (s) s.bringToFront();
    if (p) p.bringToFront();
  }

  function fitToRoll(roll) {
    const padding = state.cfg?.map?.fitPaddingPx ?? 20;
    const target = state.parcelByRoll.get(roll) || state.snowByRoll.get(roll);
    if (!target) return;
    state.map.fitBounds(target.getBounds(), { padding: [padding, padding] });
  }

  function selectRoll(roll, { zoom, enableView } = { zoom: true, enableView: true }) {
    clearSelectionStyles();
    state.selectedRoll = roll;
    applySelectionStyles(roll);

    if (zoom) fitToRoll(roll);

    setStatus(`Selected: ${roll}`);

    if (enableView && state.viewBtn) {
      state.viewBtn.disabled = false;
      state.viewEnabled = true;
    }

    console.log("Selected roll:", roll);
  }

  // -----------------------------
  // Address index (full_addr)
  // -----------------------------
  function buildAddressIndex(addrGeo, joinKey) {
    const rows = [];

    for (const f of addrGeo.features || []) {
      const p = f.properties || {};
      const g = f.geometry;
      if (!g || g.type !== "Point" || !Array.isArray(g.coordinates)) continue;

      const roll = p[joinKey];
      if (roll == null) continue;

      // Your requirement: specifically "full_addr"
      // (but we’ll still accept variants just in case)
      const label =
        p.full_addr ??
        p.FULL_ADDR ??
        p.FULLADDR ??
        p.ADDR_FULL ??
        p.ADDRESS ??
        "";

      const [lng, lat] = g.coordinates;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      const txt = String(label).trim();
      if (!txt) continue;

      rows.push({
        label: txt,
        norm: normalizeAddr(txt),
        roll: String(roll),
        lat,
        lng,
      });
    }

    return rows;
  }

  function getSuggestions(query, limit = 12) {
    const q = normalizeAddr(query);
    if (!q) return [];
    // Contains match (fast enough for ~2000 rows)
    const out = [];
    for (const r of state.addresses) {
      if (r.norm.includes(q)) {
        out.push(r);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  function onGo() {
    const q = el.addrInput?.value ?? "";
    const qn = normalizeAddr(q);
    if (!qn) {
      setStatus("Type an address");
      return;
    }

    // prefer exact match if present
    let match = null;
    for (const r of state.addresses) {
      if (r.norm === qn) { match = r; break; }
    }
    if (!match) {
      const sug = getSuggestions(q, 1);
      match = sug[0] || null;
    }

    if (!match) {
      setStatus("No match");
      return;
    }

    // zoom near point first (nice feel)
    state.map.setView([match.lat, match.lng], Math.max(state.map.getZoom(), 17));
    selectRoll(match.roll, { zoom: true, enableView: true });
  }

  // -----------------------------
  // View mode: satellite + mask outside selected +8m parcel
  // -----------------------------
  function clearViewOverlays() {
    if (state.maskLayer) {
      try { state.map.removeLayer(state.maskLayer); } catch (_) {}
      state.maskLayer = null;
    }
    if (state.snowOutlineLayer) {
      try { state.map.removeLayer(state.snowOutlineLayer); } catch (_) {}
      state.snowOutlineLayer = null;
    }
  }

  function enableSatelliteMaskedToSnowZone() {
    if (!state.selectedRoll) {
      setStatus("Select a parcel first");
      return;
    }

    const snowFeatureLayer = state.snowByRoll.get(state.selectedRoll);
    if (!snowFeatureLayer) {
      setStatus("Snow zone not found for this parcel (+8m layer join mismatch?)");
      return;
    }

    // Ensure satellite added (below mask)
    if (state.satellite && !state.map.hasLayer(state.satellite)) {
      state.satellite.addTo(state.map);
    }

    // Clear old overlays
    clearViewOverlays();

    // Get GeoJSON geometry from the feature layer
    const gj = snowFeatureLayer.toGeoJSON();
    const geom = gj?.geometry;
    const ringsOrPolys = polygonLatLngRingsFromGeoJSON(geom);

    if (!ringsOrPolys) {
      setStatus("Unable to build mask from snow zone geometry");
      return;
    }

    // Build mask
    if (geom.type === "Polygon") {
      state.maskLayer = createOutsideMaskForPolygonRings(ringsOrPolys);
    } else {
      // MultiPolygon
      state.maskLayer = createOutsideMaskForMultiPolygon(ringsOrPolys);
    }

    state.maskLayer.addTo(state.map);

    // Optional: outline the snow zone boundary for clarity
    state.snowOutlineLayer = L.geoJSON(gj, {
      style: { weight: 2, opacity: 1, fillOpacity: 0.0 },
      interactive: false,
    }).addTo(state.map);

    setStatus(`View: satellite limited to +8m snow zone for ${state.selectedRoll}`);
    console.log("View enabled for roll:", state.selectedRoll);
  }

  // -----------------------------
  // Draw mode stub (Phase 2)
  // -----------------------------
  function enableDrawModeStub() {
    // This is intentionally a stub.
    // Proper draw requires adding Leaflet.draw (CSS+JS) to index.html.
    // Once you add it, we’ll wire:
    // - a FeatureGroup for drawn items
    // - draw controls
    // - export drawn polygon(s) to GeoJSON and download/save.

    setStatus("Draw mode not installed yet (requires Leaflet.draw). Next step: add the library.");
    console.log("Draw stub: add Leaflet.draw to index.html to enable drawing + export.");
  }

  // -----------------------------
  // Init
  // -----------------------------
  async function init() {
    setStatus("Loading…");

    state.cfg = await loadConfigOrFallback();
    const joinKey = state.cfg?.data?.joinKey || "ROLLNUMSHO";
    const files = state.cfg?.data?.files || FALLBACK_CFG.data.files;

    // Create map immediately (don’t wait for data)
    state.map = L.map("map", { zoomControl: true });
    state.map.setMinZoom(state.cfg?.map?.minZoom ?? 0);
    state.map.setMaxZoom(state.cfg?.map?.maxZoom ?? 19);

    // Base tiles
    const baseUrl = state.cfg?.basemaps?.base?.url || FALLBACK_CFG.basemaps.base.url;
    const baseOpt = state.cfg?.basemaps?.base?.options || FALLBACK_CFG.basemaps.base.options;
    state.basemap = L.tileLayer(baseUrl, baseOpt).addTo(state.map);

    // Satellite tiles (not shown until View or manual toggle)
    const satUrl = state.cfg?.basemaps?.satellite?.url || FALLBACK_CFG.basemaps.satellite.url;
    const satOpt = state.cfg?.basemaps?.satellite?.options || FALLBACK_CFG.basemaps.satellite.options;
    state.satellite = L.tileLayer(satUrl, satOpt);

    // UI widgets we inject (View button + suggestion box)
    state.viewBtn = ensureViewButton();
    state.suggestBox = ensureSuggestBox();

    // Wire basic UI
    if (el.addrBtn) el.addrBtn.addEventListener("click", onGo);
    if (el.addrInput) {
      el.addrInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") onGo();
      });

      el.addrInput.addEventListener("input", () => {
        const q = el.addrInput.value || "";
        const matches = getSuggestions(q, 12);
        renderSuggestions(state.suggestBox, matches, (picked) => {
          el.addrInput.value = picked.label;
          state.suggestBox.style.display = "none";
        });
      });

      el.addrInput.addEventListener("focus", () => {
        const q = el.addrInput.value || "";
        const matches = getSuggestions(q, 12);
        renderSuggestions(state.suggestBox, matches, (picked) => {
          el.addrInput.value = picked.label;
          state.suggestBox.style.display = "none";
        });
      });
    }

    // Hide suggestions when clicking elsewhere
    document.addEventListener("click", (e) => {
      const box = state.suggestBox;
      if (!box || box.style.display === "none") return;
      if (e.target === el.addrInput) return;
      if (box.contains(e.target)) return;
      box.style.display = "none";
    });

    // Keep suggestion box positioned on resize/scroll
    window.addEventListener("resize", () => positionSuggestBox(state.suggestBox));
    window.addEventListener("scroll", () => positionSuggestBox(state.suggestBox), true);

    // View button action
    state.viewBtn.addEventListener("click", () => {
      enableSatelliteMaskedToSnowZone();
      // Next UI phase would reveal a "Draw" button here.
      // For now, keep draw stub accessible from console or later UI.
    });

    // Optional manual satellite toggle (if user wants it)
    if (el.satToggle) {
      el.satToggle.addEventListener("change", () => {
        if (!el.satToggle.checked) {
          if (state.map.hasLayer(state.satellite)) state.map.removeLayer(state.satellite);
          clearViewOverlays();
          setStatus("Satellite OFF");
        } else {
          state.satellite.addTo(state.map);
          setStatus("Satellite ON (unmasked)");
        }
      });
    }

    // Load data (parcels -> snowZone -> addresses)
    try {
      setStatus("Loading parcels…");
      const parcelsGeo = await loadJSON(files.parcels);
      state.parcelsLayer = buildParcelsLayer(parcelsGeo, joinKey).addTo(state.map);

      setStatus("Loading +8m snow zone…");
      const snowGeo = await loadJSON(files.snowZone);
      state.snowLayer = buildSnowLayer(snowGeo, joinKey).addTo(state.map);

      // Bring parcels on top for interaction
      try { state.parcelsLayer.bringToFront(); } catch (_) {}

      setStatus("Loading addresses…");
      const addrGeo = await loadJSON(files.addresses);
      state.addresses = buildAddressIndex(addrGeo, joinKey);

      // Auto-center to bounds of any available layer
      const b1 = state.parcelsLayer?.getBounds?.();
      const b2 = state.snowLayer?.getBounds?.();
      const all = unionBounds([b1, b2]);

      if (all && all.isValid && all.isValid()) {
        state.map.fitBounds(all, { padding: [20, 20] });
      } else {
        // fallback view
        state.map.setView([42.93, -80.28], 14);
      }

      setStatus(`Ready • ${state.addresses.length} addresses • search or click a parcel`);
      console.log("Loaded:", {
        parcels: state.parcelByRoll.size,
        snowZone: state.snowByRoll.size,
        addresses: state.addresses.length,
      });
    } catch (e) {
      hardFail(e.message, e);
    }
  }

  init();
})();
