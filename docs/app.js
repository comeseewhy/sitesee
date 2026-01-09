/* SnowBridge — docs/app.js
   Orchestrator for /docs/js/** modular structure (GitHub Pages safe)

   Goals:
   - Keep config.json as real JSON (fetched + parsed via res.json()).
   - Keep status updates single-line, concise, and fail-soft.
   - Delegate features to modules; app.js wires dependencies + state.

   Assumptions are listed after the code.
*/

"use strict";

// -----------------------------
// Imports (ES modules under /docs/js/**)
// -----------------------------
import { loadConfigOrFallback, loadJSON } from "./js/core/config.js";
import {
  loadDB,
  saveDB,
  getRecord,
  setRecord,
  deleteRecord,
  loadUI,
  saveUI,
} from "./js/core/storage.js";

import { buildAddressIndex, getSuggestions } from "./js/data/addressIndex.js";

import {
  ensureSuggestBox,
  createSuggestHandlers,
  hideSuggestions,
  isSuggestOpen,
} from "./js/ui/suggest.js";

import {
  ensurePanel,
  openPanel,
  closePanel,
  isPanelOpen,
} from "./js/ui/panel.js";

import {
  ensureContextMenu,
  showContextMenuAt,
  hideContextMenu,
  isContextMenuOpen,
} from "./js/ui/contextMenu.js";

import { buildParcelsLayer, buildSnowLayer } from "./js/map/layers.js";

import {
  enterQueryStage,
  exitQueryStage,
  fitToRoll,
} from "./js/map/queryStage.js";

import {
  installSatelliteStickyZoom,
  toggleSatellite,
  clearViewOverlays,
} from "./js/features/satellite.js";

import { toggleSize, clearSizeOverlays } from "./js/features/size.js";

import {
  ensureDrawCanvas,
  resizeCanvasToMap,
  clearCanvas,
  canvasToDataUrl,
  loadDataUrlToCanvas,
  toggleDraw,
} from "./js/features/draw.js";

// NOTE: records.js exists in your tree, but its export surface isn’t in the evidence pack.
// This app.js keeps “records” minimal using storage.js directly, and leaves a clean hook
// where you can wire records.js later if desired.

// -----------------------------
// DOM helpers
// -----------------------------
const $ = (id) => {
  try {
    return document.getElementById(id);
  } catch {
    return null;
  }
};

function on(el, ev, fn, opt) {
  if (!el) return;
  try {
    el.addEventListener(ev, fn, opt);
  } catch {}
}

function safeOneLine(s) {
  const x = String(s ?? "");
  // Collapse whitespace/newlines to single spaces, trim
  return x.replace(/\s+/g, " ").trim();
}

// -----------------------------
// Status bar (single line, truncated)
// -----------------------------
function makeStatusSetter(cfg) {
  const el = $("status");
  const max = Math.max(20, Number(cfg?.ui?.statusLineMaxChars) || 120);

  return function setStatus1(msg) {
    const t = safeOneLine(msg);
    const out = t.length > max ? `${t.slice(0, max - 1)}…` : t;
    try {
      if (el) el.textContent = out;
    } catch {}
  };
}

// -----------------------------
// Leaflet resolver (Leaflet is loaded via <script> in index.html)
// -----------------------------
function getLeafletOrNull(setStatus1) {
  const L = /** @type {any} */ (globalThis?.L);
  if (!L) {
    if (setStatus1) setStatus1("Error: Leaflet not loaded.");
    try {
      console.error("Leaflet global L not found. Ensure leaflet.js is loaded before app.js.");
    } catch {}
    return null;
  }
  return L;
}

// -----------------------------
// Roll/join helpers
// -----------------------------
function asRoll(v) {
  if (v == null) return "";
  return String(v);
}

// Extract roll from a Leaflet layer/feature (works for GeoJSON layers)
function getRollFromLayer(layer, joinKey) {
  try {
    const p = layer?.feature?.properties;
    if (!p) return "";
    return asRoll(p?.[joinKey]);
  } catch {
    return "";
  }
}

// -----------------------------
// Main
// -----------------------------
(async function main() {
  // 1) Load config (real JSON)
  const cfg = await loadConfigOrFallback({
    url: "./config.json",
    onStatus: (m) => {
      // status element might not be ready yet; just console for now
      try {
        console.log(m);
      } catch {}
    },
  });

  const setStatus1 = makeStatusSetter(cfg);
  setStatus1("Loading…");

  // 2) Leaflet
  const L = getLeafletOrNull(setStatus1);
  if (!L) return;

  // 3) DOM refs
  const mapEl = $("map");
  const addrInput = $("addrInput");
  const addrBtn = $("addrBtn");
  const modeToggle = $("modeToggle");
  const satToggle = $("satToggle");

  if (!mapEl) {
    setStatus1("Error: #map not found.");
    return;
  }

  // 4) State (single mutable object passed into feature modules)
  const st = {
    cfg,
    L,
    map: null,

    // Data
    parcelsGeo: null,
    snowGeo: null,
    addressesGeo: null,
    centroidsGeo: null,

    // Layers + maps by roll
    parcelsLayer: null,
    snowLayer: null,
    parcelsByRoll: new Map(),
    snowByRoll: new Map(),

    // Selection + modes
    selectedRoll: "",
    highlightMode: String(cfg?.ui?.defaultHighlightMode || "parcel"),
    satOn: false,
    sizeOn: false,
    drawOn: false,

    // UI module-owned elements
    suggest: null,
    panel: null,
    ctx: null,

    // Draw feature state (feature module can attach to this)
    canvas: null,

    // Address index
    addrIndex: null,

    // Local DB + UI prefs
    db: {},
    uiPrefs: {},
  };

  // 5) Load persisted UI + DB
  try {
    st.db = loadDB() || {};
  } catch {
    st.db = {};
  }

  try {
    st.uiPrefs = loadUI() || {};
  } catch {
    st.uiPrefs = {};
  }

  // Restore a few optional prefs if present (fail-soft)
  try {
    if (st.uiPrefs?.highlightMode) st.highlightMode = String(st.uiPrefs.highlightMode);
  } catch {}

  try {
    if (typeof st.uiPrefs?.satOn === "boolean") st.satOn = st.uiPrefs.satOn;
    if (typeof st.uiPrefs?.sizeOn === "boolean") st.sizeOn = st.uiPrefs.sizeOn;
    if (typeof st.uiPrefs?.drawOn === "boolean") st.drawOn = st.uiPrefs.drawOn;
  } catch {}

  // 6) Init Leaflet map
  const start = cfg?.map?.startView || { lat: 42.93, lng: -80.28, zoom: 14 };
  const minZoom = Number(cfg?.map?.minZoom) || 11;
  const maxZoom = Number(cfg?.map?.maxZoom) || 22;

  const map = L.map(mapEl, {
    zoomControl: true,
    preferCanvas: false,
    minZoom,
    maxZoom,
  }).setView([Number(start.lat) || 0, Number(start.lng) || 0], Number(start.zoom) || 14);

  st.map = map;

  // Basemaps
  const baseCfg = cfg?.basemaps?.base;
  const satCfg = cfg?.basemaps?.satellite;

  let baseLayer = null;
  let satBaseLayer = null;

  try {
    if (baseCfg?.type === "xyz" && baseCfg?.url) {
      baseLayer = L.tileLayer(baseCfg.url, baseCfg.options || {});
      baseLayer.addTo(map);
    }
  } catch (e) {
    console.warn("Base layer failed", e);
  }

  try {
    if (satCfg?.type === "xyz" && satCfg?.url) {
      satBaseLayer = L.tileLayer(satCfg.url, satCfg.options || {});
      // NOTE: satellite feature module will manage when/if this is shown.
      // We keep a reference so satellite.js can re-use it if it accepts injected layer.
    }
  } catch (e) {
    console.warn("Satellite base layer init failed", e);
  }

  // 7) Ensure UI modules (panel, suggest, context menu)
  try {
    st.panel = ensurePanel({
      // Panel module uses injected storage helpers for persistence (per evidence pack)
      loadUI,
      saveUI,
      // Actions are injected later once we define them
    });
  } catch (e) {
    console.warn("Panel init failed", e);
  }

  try {
    st.suggest = ensureSuggestBox();
  } catch (e) {
    console.warn("Suggest init failed", e);
  }

  try {
    st.ctx = ensureContextMenu();
  } catch (e) {
    console.warn("Context menu init failed", e);
  }

  // 8) Load GeoJSONs
  const files = cfg?.data?.files || {};
  const joinKey = String(cfg?.data?.joinKey || "ROLLNUMSHO");

  async function loadGeo(path, label) {
    if (!path) return null;
    try {
      const g = await loadJSON(path);
      return g;
    } catch (e) {
      console.warn(`Failed loading ${label}:`, path, e);
      setStatus1(`Error • missing ${label}`);
      return null;
    }
  }

  st.parcelsGeo = await loadGeo(files?.parcels, "parcels");
  st.snowGeo = await loadGeo(files?.snowZone, "snow zone");
  st.addressesGeo = await loadGeo(files?.addresses, "addresses");
  st.centroidsGeo = await loadGeo(files?.centroids, "centroids");

  if (!st.parcelsGeo) {
    setStatus1("Error: parcels not loaded.");
    return;
  }

  // 9) Build address index (if addresses loaded)
  try {
    if (st.addressesGeo) {
      const labelFields = Array.isArray(cfg?.data?.addressLabelFieldsPriority)
        ? cfg.data.addressLabelFieldsPriority
        : ["ADDR_FULL", "FULLADDR", "ADDRESS", "ADDR", "STREETADDR"];

      st.addrIndex = buildAddressIndex(st.addressesGeo, {
        joinKey,
        labelFieldsPriority: labelFields,
      });
    }
  } catch (e) {
    console.warn("Address index build failed", e);
    st.addrIndex = null;
  }

  // 10) Styling helpers
  const styleCfg = cfg?.style || {};
  const parcelStyleDefault = styleCfg?.parcel?.default || { weight: 1, opacity: 0.7, fillOpacity: 0.08 };
  const parcelStyleSelected = styleCfg?.parcel?.selected || { weight: 3, opacity: 1.0, fillOpacity: 0.18 };
  const snowStyleDefault = styleCfg?.snowZone?.default || { weight: 1, opacity: 0.6, fillOpacity: 0.06 };
  const snowStyleSelected = styleCfg?.snowZone?.selected || { weight: 3, opacity: 1.0, fillOpacity: 0.16 };

  function clearSelectionStyles() {
    try {
      if (st.parcelsLayer && st.parcelsLayer.setStyle) st.parcelsLayer.setStyle(parcelStyleDefault);
    } catch {}
    try {
      if (st.snowLayer && st.snowLayer.setStyle) st.snowLayer.setStyle(snowStyleDefault);
    } catch {}
  }

  function applyParcelStyle(roll) {
    const r = asRoll(roll);
    clearSelectionStyles();
    if (!r) return;

    if (st.highlightMode === "snowZone") {
      const layer = st.snowByRoll.get(r);
      if (layer?.setStyle) layer.setStyle(snowStyleSelected);
    } else {
      const layer = st.parcelsByRoll.get(r);
      if (layer?.setStyle) layer.setStyle(parcelStyleSelected);
    }
  }

  // 11) Selection orchestration
  function setSelectedRoll(nextRoll, reason) {
    const r = asRoll(nextRoll);
    st.selectedRoll = r;

    try {
      applyParcelStyle(r);
    } catch {}

    // Persist “last roll” optionally
    try {
      saveUI({ lastRoll: r });
    } catch {}

    if (r) {
      // Show a crisp single-line message; include reason if supplied
      const base = reason ? `${reason} • roll ${r}` : `Selected • roll ${r}`;
      setStatus1(base);
    }
  }

  // 12) Context menu actions (injected)
  function buildContextActions(roll) {
    const r = asRoll(roll);
    return [
      {
        label: "Open panel",
        onClick: () => {
          try {
            openPanel();
            setStatus1(`Panel opened • roll ${r}`.trim());
          } catch {}
        },
      },
      {
        label: "Toggle satellite",
        onClick: () => {
          doToggleSatellite();
        },
      },
      {
        label: "Toggle size",
        onClick: () => {
          doToggleSize();
        },
      },
      {
        label: "Toggle draw",
        onClick: () => {
          doToggleDraw();
        },
      },
      {
        label: "Clear draw",
        onClick: () => {
          doClearDraw();
        },
      },
      {
        label: "Clear selection",
        onClick: () => {
          doClearSelection();
        },
      },
    ];
  }

  function showCtxForEvent(e, roll) {
    const r = asRoll(roll);
    if (!r) return;
    try {
      if (isContextMenuOpen()) hideContextMenu(st.ctx);
    } catch {}

    try {
      const actions = buildContextActions(r);
      showContextMenuAt(st.ctx, {
        clientX: e?.originalEvent?.clientX ?? e?.clientX ?? 0,
        clientY: e?.originalEvent?.clientY ?? e?.clientY ?? 0,
        items: actions.map((a) => ({
          label: a.label,
          onClick: () => {
            try {
              hideContextMenu(st.ctx);
            } catch {}
            try {
              a.onClick();
            } catch {}
          },
        })),
      });
    } catch (err) {
      console.warn("Context menu show failed", err);
    }
  }

  // 13) Build layers (via module builders)
  function onParcelClick(e, layer) {
    const roll = getRollFromLayer(layer, joinKey);
    if (!roll) return;

    setSelectedRoll(roll, "Click");

    // Enter query stage (closes other modes as needed)
    try {
      enterQueryStage(st, {
        setStatus1,
        applyParcelStyle: (r) => applyParcelStyle(r),
        hideContextMenu: () => {
          try {
            hideContextMenu(st.ctx);
          } catch {}
        },
        isPanelOpen: () => {
          try {
            return isPanelOpen();
          } catch {
            return false;
          }
        },
        openPanel: () => {
          try {
            openPanel();
          } catch {}
        },
        toggleSatellite: (force) => doToggleSatellite(force),
        toggleSize: (force) => doToggleSize(force),
        toggleDraw: (force) => doToggleDraw(force),
      });
    } catch (err) {
      console.warn("enterQueryStage failed", err);
    }

    // Fit to roll (optional)
    try {
      fitToRoll(st, roll, { setStatus1 });
    } catch {}
  }

  function onParcelContextMenu(e, layer) {
    const roll = getRollFromLayer(layer, joinKey);
    if (!roll) return;
    setSelectedRoll(roll, "Menu");
    showCtxForEvent(e, roll);
  }

  // Build parcels
  try {
    const out = buildParcelsLayer(st.parcelsGeo, {
      L,
      joinKey,
      style: parcelStyleDefault,
      onClick: (feature, layer, e) => onParcelClick(e, layer),
      onContextMenu: (feature, layer, e) => onParcelContextMenu(e, layer),
    });

    // Allow both styles of return: either layer-only or { layer, byRoll }
    if (out?.addTo) {
      st.parcelsLayer = out;
    } else if (out?.layer) {
      st.parcelsLayer = out.layer;
      if (out?.byRoll) st.parcelsByRoll = out.byRoll;
    }

    if (st.parcelsLayer?.addTo) st.parcelsLayer.addTo(map);
  } catch (e) {
    console.warn("Parcels layer build failed", e);
    setStatus1("Error • parcels layer failed");
    return;
  }

  // Build snow zone (optional)
  try {
    if (st.snowGeo) {
      const out = buildSnowLayer(st.snowGeo, {
        L,
        joinKey,
        style: snowStyleDefault,
      });

      if (out?.addTo) {
        st.snowLayer = out;
      } else if (out?.layer) {
        st.snowLayer = out.layer;
        if (out?.byRoll) st.snowByRoll = out.byRoll;
      }

      // NOTE: Snow layer is typically shown/used as overlay; keep it on map for selection/highlight
      if (st.snowLayer?.addTo) st.snowLayer.addTo(map);
    }
  } catch (e) {
    console.warn("Snow zone layer build failed", e);
  }

  // If layers.js didn’t return byRoll maps, rebuild maps as a fallback.
  // (Your evidence pack suggests layers.js does build these maps, but this prevents regressions.)
  function rebuildByRollMapsFallback() {
    if (st.parcelsByRoll?.size > 0) return;

    try {
      if (st.parcelsLayer?.eachLayer) {
        const m = new Map();
        st.parcelsLayer.eachLayer((layer) => {
          const roll = getRollFromLayer(layer, joinKey);
          if (roll) m.set(roll, layer);
        });
        st.parcelsByRoll = m;
      }
    } catch {}

    try {
      if (st.snowLayer?.eachLayer) {
        const m = new Map();
        st.snowLayer.eachLayer((layer) => {
          const roll = getRollFromLayer(layer, joinKey);
          if (roll) m.set(roll, layer);
        });
        st.snowByRoll = m;
      }
    } catch {}
  }
  rebuildByRollMapsFallback();

  // 14) Satellite sticky zoom (optional helper)
  try {
    installSatelliteStickyZoom(st, {
      setStatus1,
      // pass in satBaseLayer if satellite.js supports it; harmless if ignored
      satBaseLayer,
    });
  } catch (e) {
    console.warn("installSatelliteStickyZoom failed", e);
  }

  // 15) Draw canvas boot (optional)
  try {
    ensureDrawCanvas(st, { setStatus1 });
    resizeCanvasToMap(st, { setStatus1 });
    on(map, "resize", () => {
      try {
        resizeCanvasToMap(st, { setStatus1 });
      } catch {}
    });
    on(map, "zoomend", () => {
      try {
        resizeCanvasToMap(st, { setStatus1 });
      } catch {}
    });
    on(map, "moveend", () => {
      try {
        resizeCanvasToMap(st, { setStatus1 });
      } catch {}
    });
  } catch (e) {
    console.warn("Draw canvas init failed", e);
  }

  // 16) Address search + suggest wiring
  function pickRoll(roll, reason) {
    const r = asRoll(roll);
    if (!r) return;

    if (!st.parcelsByRoll.has(r)) {
      setStatus1(`Not found • roll ${r}`);
      return;
    }

    setSelectedRoll(r, reason || "Go");

    try {
      enterQueryStage(st, {
        setStatus1,
        applyParcelStyle: (x) => applyParcelStyle(x),
        hideContextMenu: () => {
          try {
            hideContextMenu(st.ctx);
          } catch {}
        },
        isPanelOpen: () => {
          try {
            return isPanelOpen();
          } catch {
            return false;
          }
        },
        openPanel: () => {
          try {
            openPanel();
          } catch {}
        },
        toggleSatellite: (force) => doToggleSatellite(force),
        toggleSize: (force) => doToggleSize(force),
        toggleDraw: (force) => doToggleDraw(force),
      });
    } catch {}

    try {
      fitToRoll(st, r, { setStatus1 });
    } catch {}
  }

  function parseRollFromSuggestionRow(row) {
    // Address index rows often store roll in a field; try a few common names.
    if (!row || typeof row !== "object") return "";
    return asRoll(row.roll ?? row.ROLLNUMSHO ?? row.join ?? row.joinKey ?? row[joinKey]);
  }

  function getAddressSuggestions(q) {
    if (!st.addrIndex) return [];
    const query = safeOneLine(q);
    if (!query) return [];
    try {
      // If addressIndex.js expects the index object, pass it.
      // If it expects raw records, it should still fail-soft.
      return getSuggestions(st.addrIndex, query, { limit: 8 });
    } catch (e) {
      console.warn("getSuggestions failed", e);
      return [];
    }
  }

  function setAddrInputValue(v) {
    try {
      if (addrInput) addrInput.value = String(v ?? "");
    } catch {}
  }

  function onGoFromInput() {
    const q = safeOneLine(addrInput?.value || "");
    if (!q) {
      setStatus1("Ready • search or click a parcel");
      return;
    }

    // If user typed a roll exactly, try that first
    if (/^\d+$/.test(q) && st.parcelsByRoll.has(q)) {
      pickRoll(q, "Go");
      return;
    }

    // Otherwise use best suggestion
    const s = getAddressSuggestions(q);
    if (!s || s.length === 0) {
      setStatus1("No matches");
      return;
    }

    const best = s[0];
    const roll = parseRollFromSuggestionRow(best);
    if (!roll) {
      setStatus1("No roll found");
      return;
    }

    // Set input to label if present
    try {
      if (best.label) setAddrInputValue(best.label);
    } catch {}

    pickRoll(roll, "Go");
    try {
      hideSuggestions();
    } catch {}
  }

  let suggestHandlers = null;
  try {
    suggestHandlers = createSuggestHandlers({
      inputEl: addrInput,
      getSuggestions: (q) => getAddressSuggestions(q),
      onPick: (row) => {
        const roll = parseRollFromSuggestionRow(row);
        if (!roll) return;
        // Prefer showing the picked label in the input
        try {
          if (row?.label) setAddrInputValue(row.label);
        } catch {}
        pickRoll(roll, "Pick");
      },
      onGo: () => onGoFromInput(),
      setStatus1,
    });
  } catch (e) {
    console.warn("Suggest handler wiring failed", e);
  }

  // Bind input events (if suggest module wiring succeeded)
  if (suggestHandlers) {
    on(addrInput, "keydown", (e) => suggestHandlers.onKeyDown(e));
    on(addrInput, "input", () => suggestHandlers.onInput());
    on(addrInput, "focus", () => suggestHandlers.onFocus());
  }

  on(addrBtn, "click", () => onGoFromInput());

  // Clicking map hides suggestion + context menu
  on(map, "click", () => {
    try {
      if (isSuggestOpen()) hideSuggestions();
    } catch {}
    try {
      if (isContextMenuOpen()) hideContextMenu(st.ctx);
    } catch {}
  });

  // 17) Mode toggles (highlightMode + satellite button)
  function updateModeToggleText() {
    if (!modeToggle) return;
    const m = st.highlightMode === "snowZone" ? "Snow zone" : "Parcel";
    try {
      modeToggle.textContent = `Mode: ${m}`;
    } catch {}
  }

  function updateSatToggleText() {
    if (!satToggle) return;
    try {
      satToggle.textContent = st.satOn ? "Satellite: ON" : "Satellite: OFF";
    } catch {}
  }

  function doToggleHighlightMode(force) {
    const next =
      typeof force === "string"
        ? force
        : st.highlightMode === "snowZone"
          ? "parcel"
          : "snowZone";

    st.highlightMode = next === "snowZone" ? "snowZone" : "parcel";
    try {
      saveUI({ highlightMode: st.highlightMode });
    } catch {}

    updateModeToggleText();

    // Re-apply selection highlight under new mode
    try {
      applyParcelStyle(st.selectedRoll);
    } catch {}

    if (st.selectedRoll) {
      setStatus1(`Mode: ${st.highlightMode} • roll ${st.selectedRoll}`.replace("parcel", "Parcel").replace("snowZone", "Snow"));
    } else {
      setStatus1(`Mode: ${st.highlightMode}`.replace("parcel", "Parcel").replace("snowZone", "Snow"));
    }
  }

  on(modeToggle, "click", () => doToggleHighlightMode());

  // 18) Satellite / size / draw actions (centralized)
  function doToggleSatellite(force) {
    const want = typeof force === "boolean" ? force : !st.satOn;

    // Gate by zoom threshold (cfg.map.satelliteEnableMinZoom)
    const zMin = Number(cfg?.map?.satelliteEnableMinZoom) || 16;
    try {
      const z = st.map?.getZoom?.() ?? 0;
      if (want && z < zMin) {
        setStatus1(`Zoom in to enable satellite (min ${zMin})`);
        return;
      }
    } catch {}

    try {
      toggleSatellite(st, want, {
        setStatus1,
        // pass satBaseLayer if supported
        satBaseLayer,
      });
      st.satOn = want;
      updateSatToggleText();
      try {
        saveUI({ satOn: st.satOn });
      } catch {}
    } catch (e) {
      console.warn("toggleSatellite failed", e);
      setStatus1("Error • satellite toggle failed");
    }
  }

  function doToggleSize(force) {
    const want = typeof force === "boolean" ? force : !st.sizeOn;

    if (want && !st.selectedRoll) {
      setStatus1("Pick a parcel first");
      return;
    }

    try {
      toggleSize(st, want, { setStatus1 });
      st.sizeOn = want;
      try {
        saveUI({ sizeOn: st.sizeOn });
      } catch {}
    } catch (e) {
      console.warn("toggleSize failed", e);
      setStatus1("Error • size toggle failed");
    }
  }

  function doToggleDraw(force) {
    const want = typeof force === "boolean" ? force : !st.drawOn;

    if (want && !st.selectedRoll) {
      setStatus1("Pick a parcel first");
      return;
    }

    try {
      toggleDraw(st, want, { setStatus1 });
      st.drawOn = want;
      try {
        saveUI({ drawOn: st.drawOn });
      } catch {}
    } catch (e) {
      console.warn("toggleDraw failed", e);
      setStatus1("Error • draw toggle failed");
    }
  }

  function doClearDraw() {
    try {
      clearCanvas(st);
      // Persist cleared draw if you store it per-roll
      if (st.selectedRoll) {
        const r = st.selectedRoll;
        const rec = getRecord(r) || {};
        setRecord(r, { ...rec, draw: "" });
        saveDB(loadDB());
      }
      setStatus1(`Draw cleared • roll ${st.selectedRoll || ""}`.trim());
    } catch (e) {
      console.warn("Clear draw failed", e);
      setStatus1("Error • clear draw failed");
    }
  }

  function doClearSelection() {
    try {
      st.selectedRoll = "";
      clearSelectionStyles();
      try {
        clearViewOverlays(st);
      } catch {}
      try {
        clearSizeOverlays(st);
      } catch {}
      try {
        // keep draw canvas, just turn off draw mode
        doToggleDraw(false);
      } catch {}
      try {
        exitQueryStage(st, { setStatus1 });
      } catch {}
      setStatus1("Ready • search or click a parcel");
    } catch {}
  }

  on(satToggle, "click", () => doToggleSatellite());

  // 19) Panel actions wiring (if panel module supports injected actions)
  // We keep this fail-soft: if panel.js ignores actions, nothing breaks.
  try {
    ensurePanel({
      loadUI,
      saveUI,
      actions: {
        toggleSatellite: () => doToggleSatellite(),
        toggleSize: () => doToggleSize(),
        toggleDraw: () => doToggleDraw(),
        clearDraw: () => doClearDraw(),
        clearSelection: () => doClearSelection(),
        closePanel: () => {
          try {
            closePanel();
          } catch {}
        },
        // Minimal “records” hooks (per-roll note + draw persistence)
        getSelectedRoll: () => st.selectedRoll,
        getRecord: (roll) => {
          try {
            return getRecord(asRoll(roll)) || {};
          } catch {
            return {};
          }
        },
        setRecord: (roll, patch) => {
          const r = asRoll(roll);
          if (!r) return;
          try {
            const cur = getRecord(r) || {};
            setRecord(r, { ...cur, ...(patch || {}) });
            // Persist
            const db = loadDB() || {};
            saveDB(db);
          } catch (e) {
            console.warn("setRecord action failed", e);
          }
        },
        deleteRecord: (roll) => {
          const r = asRoll(roll);
          if (!r) return;
          try {
            deleteRecord(r);
            const db = loadDB() || {};
            saveDB(db);
          } catch {}
        },
      },
    });
  } catch (e) {
    // It’s okay if panel.js doesn’t accept this shape
    console.warn("Panel actions injection failed (safe to ignore)", e);
  }

  // 20) Restore last selection (optional)
  try {
    const last = asRoll(st.uiPrefs?.lastRoll);
    if (last && st.parcelsByRoll.has(last)) {
      setSelectedRoll(last, "Restore");
      // Restore persisted draw if stored in record (optional)
      try {
        const rec = getRecord(last) || {};
        if (rec?.draw && st.canvas) loadDataUrlToCanvas(st, rec.draw);
      } catch {}
    }
  } catch {}

  // 21) Optional: autosave draw per roll when turning draw off
  // (This respects your “single-line status” goal: no spam, just quiet persistence.)
  function persistDrawForSelectedRoll() {
    if (!st.selectedRoll) return;
    try {
      const url = canvasToDataUrl(st);
      const rec = getRecord(st.selectedRoll) || {};
      setRecord(st.selectedRoll, { ...rec, draw: url });
      // If your storage.js uses internal load/save, this might be redundant; safe anyway.
      const db = loadDB() || {};
      saveDB(db);
    } catch {}
  }

  // If draw.js emits events, great; otherwise we hook common moments:
  on(window, "beforeunload", () => {
    try {
      if (st.drawOn) persistDrawForSelectedRoll();
    } catch {}
  });

  // 22) Final UI text + ready state
  updateModeToggleText();
  updateSatToggleText();

  setStatus1("Ready • search or click a parcel");

  // If user had satellite on but is below threshold, don’t force enable.
  // If above threshold, enable it quietly.
  try {
    if (st.satOn) {
      const zMin = Number(cfg?.map?.satelliteEnableMinZoom) || 16;
      const z = st.map?.getZoom?.() ?? 0;
      if (z >= zMin) doToggleSatellite(true);
      else st.satOn = false;
      updateSatToggleText();
    }
  } catch {}

  // Same for size/draw: only restore if a roll is selected.
  try {
    if (st.sizeOn && st.selectedRoll) doToggleSize(true);
    else st.sizeOn = false;
  } catch {}
  try {
    if (st.drawOn && st.selectedRoll) doToggleDraw(true);
    else st.drawOn = false;
  } catch {}

  // Keep statuses tidy
  try {
    console.log("SnowBridge boot complete:", {
      version: cfg?.app?.version,
      parcels: !!st.parcelsGeo,
      snow: !!st.snowGeo,
      addresses: !!st.addressesGeo,
    });
  } catch {}
})();
