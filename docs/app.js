/* SnowBridge — app.js (merged, updated)
   Goals:
   1) Always show basemap + parcels, centered to data bounds.
   2) Address autocomplete from addresses.full_addr (~2000 rows).
   3) Click/select parcel → active highlight + zoom; second click → tighter zoom.
   4) Store parcel → green stored highlight (ready for Draw/Save later).
   5) View → satellite limited to +8m parcel boundary.
   6) Draw → stub for later Leaflet.draw.
   7) Hardening + better ranking + keyboard nav + further zoom.
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
    modeToggle: $("modeToggle"), // unused in this version
    satToggle: $("satToggle"),   // manual satellite toggle
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

  // Ensure Leaflet loaded
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
    map: { maxZoom: 22, minZoom: 11, fitPaddingPx: 20 }, // extended maxZoom
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
        options: { maxNativeZoom: 19, maxZoom: 22, attribution: "© OpenStreetMap contributors" },
      },
      satellite: {
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        options: { maxNativeZoom: 19, maxZoom: 22, attribution: "Tiles © Esri" },
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

  // Tokenization helper for ranking
  function tokenizeNorm(norm) {
    return norm.split(" ").filter(Boolean);
  }

  // Scoring for address suggestions (exact > prefix > token-prefix > contains)
  function scoreAddressCandidate(qNorm, candNorm) {
    if (!qNorm || !candNorm) return -Infinity;

    if (candNorm === qNorm) return 1000;
    if (candNorm.startsWith(qNorm)) return 800;

    const qTokens = tokenizeNorm(qNorm);
    const cTokens = tokenizeNorm(candNorm);

    let score = 0;

    for (const qt of qTokens) {
      if (!qt) continue;
      let best = 0;
      for (const ct of cTokens) {
        if (ct === qt) best = Math.max(best, 60);
        else if (ct.startsWith(qt)) best = Math.max(best, 40);
        else if (ct.includes(qt)) best = Math.max(best, 10);
      }
      score += best;
    }

    if (candNorm.includes(qNorm)) score += 120;

    return score;
  }

  // Convert GeoJSON Polygon/MultiPolygon -> array of rings as LatLngs
  function polygonLatLngRingsFromGeoJSON(geom) {
    if (!geom) return null;

    const toLatLngRing = (ring) => ring.map(([lng, lat]) => [lat, lng]);

    if (geom.type === "Polygon") {
      return geom.coordinates.map(toLatLngRing);
    }

    if (geom.type === "MultiPolygon") {
      return geom.coordinates.map((poly) => poly.map(toLatLngRing));
    }

    return null;
  }

  // Outside mask builder
  function createOutsideMaskForPolygonRings(polygonRings) {
    const outerWorld = [
      [85, -180],
      [85, 180],
      [-85, 180],
      [-85, -180],
    ];
    const holes = [];
    if (polygonRings && polygonRings[0] && polygonRings[0].length) {
      holes.push(polygonRings[0]);
    }
    return L.polygon([outerWorld, ...holes], {
      stroke: false,
      fill: true,
      fillOpacity: 0.65,
      interactive: false,
    });
  }

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
  // UI: Suggestions + View/Store buttons
  // -----------------------------
  function ensureViewButton() {
    let btn = $("viewBtn");
    if (btn) return btn;

    btn = document.createElement("button");
    btn.id = "viewBtn";
    btn.type = "button";
    btn.textContent = "View";
    btn.disabled = true;
    btn.style.padding = "8px 12px";
    btn.style.borderRadius = "8px";
    btn.style.border = "1px solid #d1d5db";
    btn.style.background = "#f9fafb";
    btn.style.cursor = "pointer";

    if (el.addrBtn?.parentNode) {
      el.addrBtn.parentNode.insertBefore(btn, el.addrBtn.nextSibling);
    } else if (el.topbar) {
      el.topbar.appendChild(btn);
    }
    return btn;
  }

  function ensureStoreButton() {
    let btn = $("storeBtn");
    if (btn) return btn;

    btn = document.createElement("button");
    btn.id = "storeBtn";
    btn.type = "button";
    btn.textContent = "Store";
    btn.disabled = true;
    btn.style.padding = "8px 12px";
    btn.style.borderRadius = "8px";
    btn.style.border = "1px solid #d1d5db";
    btn.style.background = "#f9fafb";
    btn.style.cursor = "pointer";

    if (state?.viewBtn?.parentNode) {
      state.viewBtn.parentNode.insertBefore(btn, state.viewBtn.nextSibling);
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

  // highlight for keyboard nav
  function setActiveRow(box, idx) {
    const kids = Array.from(box.children);
    kids.forEach((el, i) => {
      el.style.background = (i === idx) ? "#e5e7eb" : "transparent";
    });
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
    storeBtn: null,
    suggestBox: null,
    viewEnabled: false,

    // storage + effects
    storedRolls: new Set(),
    blinkTimer: null,

    // keyboard nav
    suggestIndex: -1,
  };

  // -----------------------------
  // Style definitions
  // -----------------------------
  const STYLE = {
    idleParcel: { weight: 1, opacity: 0.7, fillOpacity: 0.08 },
    idleSnow:   { weight: 1, opacity: 0.55, fillOpacity: 0.04 },

    activeParcel: { weight: 3, opacity: 1, fillOpacity: 0.22, color: "#f59e0b" }, // amber
    activeSnow:   { weight: 2, opacity: 0.95, fillOpacity: 0.08, color: "#f59e0b" },

    storedParcel: { weight: 2, opacity: 1, fillOpacity: 0.16, color: "#10b981" }, // green
    storedSnow:   { weight: 2, opacity: 0.9, fillOpacity: 0.06, color: "#10b981" },
  };

  // Helper: apply style based on active/stored/idle
  function applyRollStyle(roll) {
    const p = state.parcelByRoll.get(roll);
    const s = state.snowByRoll.get(roll);

    const isActive = (roll === state.selectedRoll);
    const isStored = state.storedRolls.has(roll);

    if (p) p.setStyle(isActive ? STYLE.activeParcel : isStored ? STYLE.storedParcel : STYLE.idleParcel);
    if (s) s.setStyle(isActive ? STYLE.activeSnow   : isStored ? STYLE.storedSnow   : STYLE.idleSnow);

    if (s) s.bringToFront();
    if (p) p.bringToFront();
  }

  function restyleAllAffectedRolls(oldRoll, newRoll) {
    if (oldRoll) applyRollStyle(oldRoll);
    if (newRoll) applyRollStyle(newRoll);
  }

  // Blink effect for active parcel
  function blinkActiveOnce() {
    if (!state.selectedRoll) return;
    const roll = state.selectedRoll;
    const p = state.parcelByRoll.get(roll);
    if (!p) return;

    const base = STYLE.activeParcel;
    p.setStyle({ ...base, weight: base.weight + 2, fillOpacity: Math.min(0.35, (base.fillOpacity ?? 0.22) + 0.1) });

    window.clearTimeout(state.blinkTimer);
    state.blinkTimer = window.setTimeout(() => {
      applyRollStyle(roll);
    }, 220);
  }

  // -----------------------------
  // Core map + layers
  // -----------------------------
  function buildParcelsLayer(geojson, joinKey) {
    state.parcelByRoll.clear();

    const lyr = L.geoJSON(geojson, {
      style: STYLE.idleParcel,
      onEachFeature: (feature, layer) => {
        const roll = feature?.properties?.[joinKey];
        if (roll != null) state.parcelByRoll.set(String(roll), layer);

        layer.on("click", () => {
          if (roll == null) return;
          const r = String(roll);
          const isSame = (state.selectedRoll === r);
          selectRoll(r, { zoom: true, enableView: true, zoomTighter: isSame });
          blinkActiveOnce();
        });
      },
    });

    return lyr;
  }

  function buildSnowLayer(geojson, joinKey) {
    state.snowByRoll.clear();

    const lyr = L.geoJSON(geojson, {
      style: STYLE.idleSnow,
      onEachFeature: (feature, layer) => {
        const roll = feature?.properties?.[joinKey];
        if (roll != null) state.snowByRoll.set(String(roll), layer);
      },
    });

    return lyr;
  }

  function fitToRoll(roll) {
    const padding = state.cfg?.map?.fitPaddingPx ?? 20;
    const target = state.parcelByRoll.get(roll) || state.snowByRoll.get(roll);
    if (!target) return;
    state.map.fitBounds(target.getBounds(), { padding: [padding, padding] });
  }

  // -----------------------------
  // Selection and storage
  // -----------------------------
  function selectRoll(roll, { zoom, enableView, zoomTighter } = { zoom: true, enableView: true, zoomTighter: false }) {
    const old = state.selectedRoll;
    state.selectedRoll = roll;

    restyleAllAffectedRolls(old, roll);

    if (zoom) {
      fitToRoll(roll);
      if (zoomTighter) {
        const z = state.map.getZoom();
        state.map.setZoom(z + 1);
      }
    }

    const storedSuffix = state.storedRolls.has(roll) ? " • stored" : "";
    setStatus(`Active • roll ${roll}${storedSuffix}`);

    if (enableView && state.viewBtn) {
      state.viewBtn.disabled = false;
      state.viewEnabled = true;
    }

    if (state.storeBtn) {
      state.storeBtn.disabled = !state.selectedRoll;
    }

    // keep View sticky
    if (state.maskLayer) enableSatelliteMaskedToSnowZone();

    console.log("Selected roll:", roll);
  }

  function markSelectedAsStored() {
    if (!state.selectedRoll) return;
    state.storedRolls.add(state.selectedRoll);
    applyRollStyle(state.selectedRoll);
    setStatus(`Stored • roll ${state.selectedRoll}`);
  }

  // -----------------------------
  // Address index + suggestions
  // -----------------------------
  function buildAddressIndex(addrGeo, joinKey) {
    const rows = [];

    for (const f of addrGeo.features || []) {
      const p = f.properties || {};
      const g = f.geometry;
      if (!g || g.type !== "Point" || !Array.isArray(g.coordinates)) continue;

      const roll = p[joinKey];
      if (roll == null) continue;

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
    const qNorm = normalizeAddr(query);
    if (!qNorm) return [];

    const scored = [];
    for (const r of state.addresses) {
      const s = scoreAddressCandidate(qNorm, r.norm);
      if (s > 0) scored.push({ r, s });
    }

    scored.sort((a, b) => {
      if (b.s !== a.s) return b.s - a.s;
      return a.r.label.localeCompare(b.r.label);
    });

    return scored.slice(0, limit).map(x => x.r);
  }

  function onGo() {
    const q = el.addrInput?.value ?? "";
    const qn = normalizeAddr(q);
    if (!qn) {
      setStatus("Type an address");
      return;
    }

    const best = getSuggestions(q, 1)[0] || null;
    if (!best) {
      setStatus("No match");
      return;
    }

    state.map.setView([best.lat, best.lng], Math.max(state.map.getZoom(), 17));
    selectRoll(best.roll, { zoom: true, enableView: true });
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

  // Guard for satellite view minimum zoom
  function canUseSatelliteNow() {
    const minz = state.cfg?.map?.satelliteEnableMinZoom ?? 16;
    const z = state.map?.getZoom?.() ?? 0;
    return z >= minz;
  }

  function enableSatelliteMaskedToSnowZone() {
    if (!state.selectedRoll) {
      setStatus("Select a parcel first");
      return;
    }

    // Guard: require enough zoom
    if (!canUseSatelliteNow()) {
      const minz = state.cfg?.map?.satelliteEnableMinZoom ?? 16;
      setStatus(`Zoom in to ${minz}+ for View`);
      return;
    }

    const snowFeatureLayer = state.snowByRoll.get(state.selectedRoll);
    if (!snowFeatureLayer) {
      setStatus("Snow zone not found for this parcel (+8m layer join mismatch?)");
      return;
    }

    if (state.satellite && !state.map.hasLayer(state.satellite)) {
      state.satellite.addTo(state.map);
    }

    clearViewOverlays();

    const gj = snowFeatureLayer.toGeoJSON();
    const geom = gj?.geometry;
    const ringsOrPolys = polygonLatLngRingsFromGeoJSON(geom);

    if (!ringsOrPolys) {
      setStatus("Unable to build mask from snow zone geometry");
      return;
    }

    if (geom.type === "Polygon") {
      state.maskLayer = createOutsideMaskForPolygonRings(ringsOrPolys);
    } else {
      state.maskLayer = createOutsideMaskForMultiPolygon(ringsOrPolys);
    }

    state.maskLayer.addTo(state.map);

    state.snowOutlineLayer = L.geoJSON(gj, {
      style: { weight: 2, opacity: 1, fillOpacity: 0.0 },
      interactive: false,
    }).addTo(state.map);

    setStatus(`View • roll ${state.selectedRoll}`);
    console.log("View enabled for roll:", state.selectedRoll);
  }

  // -----------------------------
  // Draw mode stub (Phase 2)
  // -----------------------------
  function enableDrawModeStub() {
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

    // Create map immediately
    state.map = L.map("map", { zoomControl: true });
    state.map.setMinZoom(state.cfg?.map?.minZoom ?? 0);
    // Max zoom comes from tiles or config; Leaflet docs note map maxZoom considers layer options. :contentReference[oaicite:0]{index=0}
    state.map.setMaxZoom(state.cfg?.map?.maxZoom ?? FALLBACK_CFG.map.maxZoom);

    // Base tiles
    const baseUrl = state.cfg?.basemaps?.base?.url || FALLBACK_CFG.basemaps.base.url;
    const baseOpt = { ...(state.cfg?.basemaps?.base?.options || FALLBACK_CFG.basemaps.base.options) };
    // Ensure overzoom configuration present
    baseOpt.maxNativeZoom ??= 19;
    baseOpt.maxZoom ??= state.cfg?.map?.maxZoom ?? FALLBACK_CFG.map.maxZoom;
    state.basemap = L.tileLayer(baseUrl, baseOpt).addTo(state.map);

    // Satellite tiles
    const satUrl = state.cfg?.basemaps?.satellite?.url || FALLBACK_CFG.basemaps.satellite.url;
    const satOpt = { ...(state.cfg?.basemaps?.satellite?.options || FALLBACK_CFG.basemaps.satellite.options) };
    satOpt.maxNativeZoom ??= 19;
    satOpt.maxZoom ??= state.cfg?.map?.maxZoom ?? FALLBACK_CFG.map.maxZoom;
    state.satellite = L.tileLayer(satUrl, satOpt);

    // UI widgets (View, Store + suggestions)
    state.viewBtn = ensureViewButton();
    state.storeBtn = ensureStoreButton();
    state.suggestBox = ensureSuggestBox();

    // Button wiring
    if (el.addrBtn) el.addrBtn.addEventListener("click", onGo);

    if (el.addrInput) {
      el.addrInput.addEventListener("keydown", (e) => {
        const box = state.suggestBox;
        const open = box && box.style.display !== "none" && box.children.length;

        if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
          e.preventDefault();
          const n = box.children.length;
          if (e.key === "ArrowDown") state.suggestIndex = (state.suggestIndex + 1) % n;
          if (e.key === "ArrowUp") state.suggestIndex = (state.suggestIndex - 1 + n) % n;
          setActiveRow(box, state.suggestIndex);
          return;
        }

        if (open && e.key === "Enter" && state.suggestIndex >= 0) {
          e.preventDefault();
          const pickedLabel = box.children[state.suggestIndex]?.textContent;
          if (pickedLabel) {
            el.addrInput.value = pickedLabel;
            box.style.display = "none";
            onGo();
          }
          return;
        }

        if (e.key === "Enter") onGo();
      });

      el.addrInput.addEventListener("input", () => {
        const q = el.addrInput.value || "";
        const matches = getSuggestions(q, 12);
        renderSuggestions(state.suggestBox, matches, (picked) => {
          el.addrInput.value = picked.label;
          state.suggestIndex = -1;
          state.suggestBox.style.display = "none";
        });
      });

      el.addrInput.addEventListener("focus", () => {
        const q = el.addrInput.value || "";
        const matches = getSuggestions(q, 12);
        renderSuggestions(state.suggestBox, matches, (picked) => {
          el.addrInput.value = picked.label;
          state.suggestIndex = -1;
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

    // Reposition suggestions on resize/scroll
    window.addEventListener("resize", () => positionSuggestBox(state.suggestBox));
    window.addEventListener("scroll", () => positionSuggestBox(state.suggestBox), true);

    // View button
    state.viewBtn.addEventListener("click", () => {
      enableSatelliteMaskedToSnowZone();
    });

    // Store button
    state.storeBtn.addEventListener("click", () => {
      markSelectedAsStored();
    });

    // Manual satellite toggle
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

    // Load data
    try {
      setStatus("Loading parcels…");
      const parcelsGeo = await loadJSON(files.parcels);
      state.parcelsLayer = buildParcelsLayer(parcelsGeo, joinKey).addTo(state.map);

      setStatus("Loading +8m snow zone…");
      const snowGeo = await loadJSON(files.snowZone);
      state.snowLayer = buildSnowLayer(snowGeo, joinKey).addTo(state.map);

      // Bring parcels on top
      try { state.parcelsLayer.bringToFront(); } catch (_) {}

      setStatus("Loading addresses…");
      const addrGeo = await loadJSON(files.addresses);
      state.addresses = buildAddressIndex(addrGeo, joinKey);

      // Auto-center
      const b1 = state.parcelsLayer?.getBounds?.();
      const b2 = state.snowLayer?.getBounds?.();
      const all = unionBounds([b1, b2]);

      if (all && all.isValid && all.isValid()) {
        state.map.fitBounds(all, { padding: [20, 20] });
      } else {
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
