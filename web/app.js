/* SnowBridge — app.js (config-first, static-host friendly)
   - Loads ./config.json
   - Loads GeoJSON layers (parcels, snowZone (+8m), addresses, optional centroids)
   - Address search -> zoom -> select by ROLLNUMSHO
   - Parcel click -> select by ROLLNUMSHO
   - Mode toggle: parcel vs snow zone highlighting
   - Satellite toggle: independent layer, optionally gated by min zoom + selection
*/

(() => {
  "use strict";

  // -----------------------------
  // DOM helpers
  // -----------------------------
  const $ = (id) => document.getElementById(id);

  const el = {
    addrInput: $("addrInput"),
    addrBtn: $("addrBtn"),
    modeToggle: $("modeToggle"),
    satToggle: $("satToggle"),
    status: $("status"),
  };

  function safeText(s) {
    return String(s ?? "");
  }

  function truncateOneLine(s, maxChars) {
    const one = safeText(s).replace(/\s+/g, " ").trim();
    if (!maxChars || one.length <= maxChars) return one;
    return one.slice(0, Math.max(0, maxChars - 1)) + "…";
  }

  // status updates must stay on one line
  function makeStatus(maxChars) {
    return (msg) => {
      if (!el.status) return;
      el.status.textContent = truncateOneLine(msg, maxChars);
    };
  }

  // -----------------------------
  // Normalization + search
  // -----------------------------
  function normalizeAddress(s) {
    return safeText(s)
      .toUpperCase()
      .replace(/[.,]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Soft match: exact first, then contains
  function findAddressMatch(addressRows, query) {
    const q = normalizeAddress(query);
    if (!q) return null;

    let exact = null;
    for (const r of addressRows) {
      if (r.norm === q) {
        exact = r;
        break;
      }
    }
    if (exact) return exact;

    // contains match
    for (const r of addressRows) {
      if (r.norm.includes(q)) return r;
    }
    return null;
  }

  // -----------------------------
  // GeoJSON loading
  // -----------------------------
  async function loadJSON(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${url} → ${res.status} ${res.statusText}`);
    return res.json();
  }

  function pickFirstField(properties, candidates) {
    if (!properties) return null;
    for (const k of candidates || []) {
      if (properties[k] != null && String(properties[k]).trim() !== "") return k;
    }
    return null;
  }

  // -----------------------------
  // App state
  // -----------------------------
  const state = {
    cfg: null,
    map: null,
    basemap: null,
    satellite: null,
    // layers
    layers: {
      parcels: null,
      snowZone: null,
      addresses: null,
      centroids: null,
    },
    // lookup maps
    parcelByRoll: new Map(),
    snowByRoll: new Map(),
    centroidByRoll: new Map(),
    // address search index
    addressRows: [], // { label, norm, roll, lat, lng }
    // selection
    selected: {
      roll: null,
      source: null, // "address" | "parcel"
      lastAction: "",
    },
    // transient markers
    flashMarker: null,
  };

  // -----------------------------
  // Selection + styling
  // -----------------------------
  function getHighlightMode() {
    // checkbox = Snow zone ON
    const allow = state.cfg?.ui?.allowSnowZoneMode !== false;
    if (!allow) return "parcel";
    return el.modeToggle && el.modeToggle.checked ? "snowZone" : "parcel";
  }

  function styleFor(mode, variant) {
    const s = state.cfg?.style?.[mode]?.[variant] || {};
    return {
      weight: s.weight ?? 1,
      opacity: s.opacity ?? 0.7,
      fillOpacity: s.fillOpacity ?? 0.08,
    };
  }

  function clearSelectionStyles() {
    const prevRoll = state.selected.roll;
    if (!prevRoll) return;

    const parcelLayer = state.parcelByRoll.get(prevRoll);
    const snowLayer = state.snowByRoll.get(prevRoll);

    if (parcelLayer) parcelLayer.setStyle(styleFor("parcel", "default"));
    if (snowLayer) snowLayer.setStyle(styleFor("snowZone", "default"));
  }

  function applySelectionStyles(roll) {
    if (!roll) return;

    // Always keep parcels visible; only "selected" highlight depends on mode.
    const mode = getHighlightMode();

    const parcelLayer = state.parcelByRoll.get(roll);
    const snowLayer = state.snowByRoll.get(roll);

    // Reset both to defaults first (in case user toggles mode)
    if (parcelLayer) parcelLayer.setStyle(styleFor("parcel", "default"));
    if (snowLayer) snowLayer.setStyle(styleFor("snowZone", "default"));

    // Apply selected style to active mode layer
    if (mode === "snowZone") {
      if (snowLayer) {
        snowLayer.setStyle(styleFor("snowZone", "selected"));
        snowLayer.bringToFront();
      }
      // keep parcel subtle
      if (parcelLayer) parcelLayer.bringToFront();
    } else {
      if (parcelLayer) {
        parcelLayer.setStyle(styleFor("parcel", "selected"));
        parcelLayer.bringToFront();
      }
      // keep snow zone subtle (still useful visual, but not emphasized)
      if (snowLayer) snowLayer.bringToFront();
    }
  }

  function fitToSelected(roll) {
    const mode = getHighlightMode();
    const padding = state.cfg?.map?.fitPaddingPx ?? 20;

    const primary =
      mode === "snowZone"
        ? state.snowByRoll.get(roll) || state.parcelByRoll.get(roll)
        : state.parcelByRoll.get(roll) || state.snowByRoll.get(roll);

    if (!primary) return;

    const b = primary.getBounds();
    state.map.fitBounds(b, { padding: [padding, padding] });
  }

  function setSelectedParcel(roll, source) {
    const STATUS = makeStatus(state.cfg?.ui?.statusLineMaxChars ?? 120);

    // clear previous selection styling
    clearSelectionStyles();

    state.selected.roll = roll ? String(roll) : null;
    state.selected.source = source || null;

    if (!state.selected.roll) {
      STATUS("Ready");
      return;
    }

    applySelectionStyles(state.selected.roll);

    // expose in console for future logging pipelines
    console.log("SnowBridge selection:", {
      roll: state.selected.roll,
      source: state.selected.source,
      mode: getHighlightMode(),
    });

    STATUS(`Selected: ${state.selected.roll}`);

    // hone-in behavior (fit to bounds)
    fitToSelected(state.selected.roll);

    // satellite gating: if toggle is ON but zoom too low, nudge zoom after fit
    maybeGateSatellite();
  }

  // -----------------------------
  // Satellite gating (selection + zoom)
  // -----------------------------
  function isSatelliteEnabled() {
    return !!(el.satToggle && el.satToggle.checked);
  }

  function addSatelliteIfAllowed() {
    if (!state.satellite) return;

    // Must have toggle on
    if (!isSatelliteEnabled()) {
      if (state.map.hasLayer(state.satellite)) state.map.removeLayer(state.satellite);
      return;
    }

    // Optional rule: only show after selection
    // If you want "only after selection", uncomment the next 3 lines:
    // if (!state.selected.roll) {
    //   if (state.map.hasLayer(state.satellite)) state.map.removeLayer(state.satellite);
    //   return;
    // }

    // Optional gating by zoom
    const minZ = state.cfg?.map?.satelliteEnableMinZoom ?? 16;
    if (state.map.getZoom() < minZ) {
      if (state.map.hasLayer(state.satellite)) state.map.removeLayer(state.satellite);
      return;
    }

    if (!state.map.hasLayer(state.satellite)) state.satellite.addTo(state.map);
  }

  function maybeGateSatellite() {
    addSatelliteIfAllowed();
  }

  // -----------------------------
  // Address search behavior
  // -----------------------------
  function flashAt(lat, lng) {
    if (!state.map) return;

    if (state.flashMarker) {
      try {
        state.map.removeLayer(state.flashMarker);
      } catch (_) {}
      state.flashMarker = null;
    }

    state.flashMarker = L.circleMarker([lat, lng], { radius: 8, weight: 2 });
    state.flashMarker.addTo(state.map);

    setTimeout(() => {
      if (state.flashMarker) {
        try {
          state.map.removeLayer(state.flashMarker);
        } catch (_) {}
        state.flashMarker = null;
      }
    }, 900);
  }

  function goToAddress() {
    const STATUS = makeStatus(state.cfg?.ui?.statusLineMaxChars ?? 120);
    const q = el.addrInput?.value ?? "";
    const match = findAddressMatch(state.addressRows, q);

    if (!match) {
      STATUS("No match");
      return;
    }

    // zoom near the address point (then fitBounds from selected polygon)
    const currentZ = state.map.getZoom();
    const targetZ = Math.max(currentZ, 17);
    state.map.setView([match.lat, match.lng], targetZ);

    flashAt(match.lat, match.lng);
    setSelectedParcel(match.roll, "address");

    console.log("Address match:", match);
  }

  // -----------------------------
  // Layer builders
  // -----------------------------
  function buildParcelLayer(geojson, joinKey) {
    // main parcels
    return L.geoJSON(geojson, {
      style: () => styleFor("parcel", "default"),
      onEachFeature: (feature, layer) => {
        const roll = feature?.properties?.[joinKey];
        if (roll != null) state.parcelByRoll.set(String(roll), layer);

        layer.on("click", () => {
          if (roll == null) return;
          setSelectedParcel(String(roll), "parcel");
        });
      },
    });
  }

  function buildSnowZoneLayer(geojson, joinKey) {
    // +8m buffer polygons
    return L.geoJSON(geojson, {
      style: () => styleFor("snowZone", "default"),
      onEachFeature: (feature, layer) => {
        const roll = feature?.properties?.[joinKey];
        if (roll != null) state.snowByRoll.set(String(roll), layer);

        // allow clicking snow zone too
        layer.on("click", () => {
          if (roll == null) return;
          setSelectedParcel(String(roll), "parcel");
        });
      },
    });
  }

  function buildCentroidsLayer(geojson, joinKey) {
    return L.geoJSON(geojson, {
      pointToLayer: (feature, latlng) => L.circleMarker(latlng, { radius: 3, weight: 1 }),
      onEachFeature: (feature, layer) => {
        const roll = feature?.properties?.[joinKey];
        if (roll != null) state.centroidByRoll.set(String(roll), layer);
      },
    });
  }

  function buildAddressIndex(addrGeojson, joinKey, labelPriority) {
    const rows = [];
    for (const f of addrGeojson.features || []) {
      const p = f.properties || {};
      const g = f.geometry;

      if (!g || g.type !== "Point" || !Array.isArray(g.coordinates)) continue;

      const roll = p[joinKey];
      if (roll == null) continue;

      const labelField = pickFirstField(p, labelPriority);
      const label = labelField ? String(p[labelField]).trim() : "";

      const [lng, lat] = g.coordinates;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      const finalLabel = label || `ROLL ${roll}`;
      rows.push({
        label: finalLabel,
        norm: normalizeAddress(finalLabel),
        roll: String(roll),
        lat,
        lng,
      });
    }
    return rows;
  }

  // -----------------------------
  // Init
  // -----------------------------
  async function init() {
    const STATUS = makeStatus(120);
    try {
      STATUS("Loading config…");
      state.cfg = await loadJSON("./config.json");

      // rebind status with configured max chars
      const STATUS2 = makeStatus(state.cfg?.ui?.statusLineMaxChars ?? 120);

      // init map
      const sv = state.cfg.map?.startView || { lat: 0, lng: 0, zoom: 2 };
      state.map = L.map("map", { zoomControl: true }).setView(
        [sv.lat, sv.lng],
        sv.zoom
      );

      // zoom constraints
      const minZoom = state.cfg.map?.minZoom ?? 0;
      const maxZoom = state.cfg.map?.maxZoom ?? 19;
      state.map.setMinZoom(minZoom);
      state.map.setMaxZoom(maxZoom);

      // basemap
      const baseCfg = state.cfg.basemaps?.base;
      if (!baseCfg?.url) throw new Error("Missing basemaps.base.url in config.json");

      state.basemap = L.tileLayer(baseCfg.url, {
        maxZoom: baseCfg.options?.maxZoom ?? maxZoom,
        attribution: baseCfg.options?.attribution ?? "",
      }).addTo(state.map);

      // satellite (not added by default)
      const satCfg = state.cfg.basemaps?.satellite;
      if (satCfg?.url) {
        state.satellite = L.tileLayer(satCfg.url, {
          maxZoom: satCfg.options?.maxZoom ?? maxZoom,
          attribution: satCfg.options?.attribution ?? "",
        });
      }

      // data paths
      const files = state.cfg.data?.files || {};
      const joinKey = state.cfg.data?.joinKey || "ROLLNUMSHO";

      // load parcels first (so clicks/select works immediately)
      STATUS2("Loading parcels…");
      const parcelsGeo = await loadJSON(files.parcels);
      state.layers.parcels = buildParcelLayer(parcelsGeo, joinKey).addTo(state.map);

      // load snow zone (+8m)
      STATUS2("Loading snow zone…");
      const snowGeo = await loadJSON(files.snowZone);
      state.layers.snowZone = buildSnowZoneLayer(snowGeo, joinKey).addTo(state.map);

      // keep parcel layer above snow zone by default (until selection)
      try {
        state.layers.parcels.bringToFront();
      } catch (_) {}

      // load addresses (search index)
      STATUS2("Loading addresses…");
      const addrGeo = await loadJSON(files.addresses);
      state.addressRows = buildAddressIndex(
        addrGeo,
        joinKey,
        state.cfg.data?.addressLabelFieldsPriority || []
      );

      // optional centroids
      if (state.cfg.ui?.showCentroids && files.centroids) {
        STATUS2("Loading centroids…");
        const centGeo = await loadJSON(files.centroids);
        state.layers.centroids = buildCentroidsLayer(centGeo, joinKey).addTo(state.map);
      }

      // bind UI behaviors
      bindUI();

      STATUS2(`Ready • ${state.addressRows.length} addresses • click a parcel or search`);
    } catch (err) {
      console.error(err);
      const STATUS3 = makeStatus(state.cfg?.ui?.statusLineMaxChars ?? 120);
      STATUS3(`Load error: ${err.message}`);
    }
  }

  function bindUI() {
    const STATUS = makeStatus(state.cfg?.ui?.statusLineMaxChars ?? 120);

    // address search
    if (el.addrBtn) el.addrBtn.addEventListener("click", goToAddress);
    if (el.addrInput) {
      el.addrInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") goToAddress();
      });
    }

    // mode toggle: re-apply styles for current selection
    if (el.modeToggle) {
      const allow = state.cfg?.ui?.allowSnowZoneMode !== false;
      el.modeToggle.disabled = !allow;

      // set default mode from config
      const defaultMode = state.cfg?.ui?.defaultHighlightMode || "parcel";
      el.modeToggle.checked = allow && defaultMode === "snowZone";

      el.modeToggle.addEventListener("change", () => {
        if (!state.selected.roll) {
          STATUS(el.modeToggle.checked ? "Snow zone mode" : "Parcel mode");
          return;
        }
        // re-apply highlight to selected roll for new mode
        applySelectionStyles(state.selected.roll);
        fitToSelected(state.selected.roll);
        STATUS(
          `Selected: ${state.selected.roll} • ${
            el.modeToggle.checked ? "Snow zone" : "Parcel"
          }`
        );
      });
    }

    // satellite toggle
    if (el.satToggle) {
      el.satToggle.addEventListener("change", () => {
        maybeGateSatellite();
        STATUS(el.satToggle.checked ? "Satellite ON" : "Satellite OFF");
      });
    }

    // gate satellite on zoom changes
    if (state.map) {
      state.map.on("zoomend", () => {
        maybeGateSatellite();
      });
    }
  }

  // Boot
  init();
})();
