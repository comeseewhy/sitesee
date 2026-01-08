// docs/app.js
import { loadDB, saveDB, getRecord, setRecord, deleteRecord, loadUI, saveUI } from "./js/core/storage.js";
import { FALLBACK_CFG, loadConfigOrFallback, loadJSON } from "./js/core/config.js";
import { createState } from "./js/core/state.js";
import { buildAddressIndex, getSuggestions } from "./js/data/addressIndex.js";

import { setStatus, hardFail } from "./js/ui/status.js";
import { ensureSuggestBox, positionSuggestBox, createSuggestHandlers } from "./js/ui/suggest.js";
import { ensureContextMenu, hideContextMenu, showContextMenuAt } from "./js/ui/contextMenu.js";
import { ensurePanel, openPanel as uiOpenPanel, closePanel as uiClosePanel, isPanelOpen } from "./js/ui/panel.js";

import {
  areaM2FromLayer, // (still used by other inline features if any; safe to keep)
  fmtArea,         // (still used by other inline features if any; safe to keep)
} from "./js/map/geometry.js";
import { buildParcelsLayer, buildSnowLayer } from "./js/map/layers.js";
import { enterQueryStage, exitQueryStage } from "./js/map/queryStage.js";

import { installSatelliteStickyZoom, toggleSatellite as featureToggleSatellite } from "./js/features/satellite.js";
import { toggleSize as featureToggleSize } from "./js/features/size.js";
import {
  ensureDrawCanvas as featureEnsureDrawCanvas,
  resizeCanvasToMap as featureResizeCanvasToMap,
  clearCanvas as featureClearCanvas,
  canvasToDataUrl as featureCanvasToDataUrl,
  loadDataUrlToCanvas as featureLoadDataUrlToCanvas,
  toggleDraw as featureToggleDraw,
} from "./js/features/draw.js";

/* SnowBridge — app.js (structure-optimized, behavior preserved)
   - Orchestrator/wiring layer:
       - DOM lookup + event binding
       - State object + dependency injection
       - Leaflet map + layers + feature actions
   - GitHub Pages safe: native ES module; no build step.
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
    topbar: $("topbar"),

    // present in index.html (legacy toggles); app doesn’t rely on them
    modeToggle: $("modeToggle"),
    satToggle: $("satToggle"),
    status: $("status"),
  };

  if (typeof L === "undefined") {
    hardFail("Leaflet failed to load (L is undefined). Check Leaflet <script> tag.");
    return;
  }
  if (!el.map) {
    hardFail("Missing #map element in index.html");
    return;
  }

  // -----------------------------
  // State
  // -----------------------------
  const state = createState();

  // Single-line status wrapper (optional max chars from config; preserves behavior when unset)
  const setStatus1 = (msg) => setStatus(msg, { maxChars: state.cfg?.ui?.statusLineMaxChars });

  // -----------------------------
  // Styling (preserved)
  // -----------------------------
  const STYLE = {
    idleParcel: { weight: 1, opacity: 0.8, fillOpacity: 0.08, color: "#2563eb" },
    activeParcelA: { weight: 3, opacity: 1, fillOpacity: 0.18, color: "#f59e0b" },
    activeParcelB: { weight: 3, opacity: 0.65, fillOpacity: 0.03, color: "#f59e0b" },
    sizeOutline: { weight: 3, opacity: 1, fillOpacity: 0.0, color: "#111827" },
    snowOutline: { weight: 2, opacity: 1, fillOpacity: 0.0, color: "#ffffff" },
    // snow base layer style (matches prior buildSnowLayer defaults)
    snowBase: { weight: 1, opacity: 0.35, fillOpacity: 0.0 },
  };

  function severityStyleForRoll(roll) {
    const rec = getRecord(roll);
    const sev = rec?.request?.severity;
    if (sev === "red") return { fillColor: "#ef4444", fillOpacity: 0.28 };
    if (sev === "yellow") return { fillColor: "#f59e0b", fillOpacity: 0.22 };
    if (sev === "green") return { fillColor: "#10b981", fillOpacity: 0.2 };
    return { fillColor: null, fillOpacity: null };
  }

  function applyParcelStyle(roll) {
    const layer = state.parcelByRoll.get(roll);
    if (!layer) return;

    const sev = severityStyleForRoll(roll);
    const base = { ...STYLE.idleParcel };
    if (sev.fillColor) base.fillColor = sev.fillColor;
    if (sev.fillOpacity != null) base.fillOpacity = sev.fillOpacity;

    if (state.selectedRoll === roll && state.isQueryStage) {
      layer.setStyle(state.blinkOn ? { ...base, ...STYLE.activeParcelA } : { ...base, ...STYLE.activeParcelB });
    } else {
      layer.setStyle(base);
    }
  }

  function restyleAllParcels() {
    for (const roll of state.parcelByRoll.keys()) applyParcelStyle(roll);
  }

  // -----------------------------
  // Feature adapters (new structure)
  // -----------------------------
  // Keep app.js call sites stable (toggleSatellite(true/false), toggleSize(true/false), toggleDraw(true/false), etc.)
  const toggleSatellite = (force) =>
    featureToggleSatellite(state, force, { L, setStatus1, snowOutlineStyle: STYLE.snowOutline });

  const toggleSize = (force) =>
    featureToggleSize(state, force, { L, setStatus1, sizeOutlineStyle: STYLE.sizeOutline });

  const toggleDraw = (force) =>
    featureToggleDraw(state, force, { setStatus1, toggleSatellite: (f) => toggleSatellite(f) });

  // -----------------------------
  // Panel wiring (ui/panel.js)
  // -----------------------------
  function openPanel() {
    uiOpenPanel(state, panelActions);
  }

  function closePanel() {
    uiClosePanel();
    exitQueryStage(state, queryDeps.exit);
  }

  const panelActions = {
    toggleSize: () => toggleSize(),
    toggleSatellite: () => toggleSatellite(),
    toggleDraw: () => toggleDraw(),
    saveSnowbridge: () => saveSnowbridge(),
    viewSnowbridge: () => viewSnowbridge(),
    openRequestForm: () => openRequestForm(),
    deleteSnowbridge: () => deleteSnowbridge(),
    closePanel: () => closePanel(),
  };

  // -----------------------------
  // Query stage wiring (map/queryStage.js)
  // -----------------------------
  const queryDeps = {
    enter: {
      hideContextMenu: (menuEl) => hideContextMenu(menuEl),
      applyParcelStyle,
      setStatus1,
      isPanelOpen,
      openPanel,
    },
    exit: {
      toggleSatellite: (force) => toggleSatellite(force),
      toggleSize: (force) => toggleSize(force),
      toggleDraw: (force) => toggleDraw(force),
      applyParcelStyle,
      setStatus1,
    },
  };

  // -----------------------------
  // Address handling (data/addressIndex.js)
  // -----------------------------
  function onGo() {
    const q = el.addrInput?.value ?? "";
    const best = getSuggestions(q, state.addresses, 1)[0] || null;
    if (!best) return setStatus1("No match");
    enterQueryStage(state, best.roll, { center: [best.lat, best.lng], source: "address" }, queryDeps.enter);
  }

  // -----------------------------
  // Save / View / Delete snowbridge — preserved
  // -----------------------------
  async function viewSnowbridge() {
    const roll = state.selectedRoll;
    if (!roll) return setStatus1("Select a parcel first");

    const rec = getRecord(roll);
    if (!rec?.drawingDataUrl) return setStatus1("No saved snowbridge for this parcel");

    if (!state.satOn) toggleSatellite(true);
    if (!state.satOn) return;

    state.canvas.style.display = "block";
    featureResizeCanvasToMap(state);
    await featureLoadDataUrlToCanvas(state, rec.drawingDataUrl);
    setStatus1(`Loaded snowbridge • roll ${roll}`);
  }

  function saveSnowbridge() {
    const roll = state.selectedRoll;
    if (!roll) return setStatus1("Select a parcel first");

    if (!state.hasUnsavedDrawing && !getRecord(roll)?.drawingDataUrl) {
      return setStatus1("Error • no drawing to save");
    }

    const dataUrl = featureCanvasToDataUrl(state);
    if (!dataUrl || dataUrl.length < 200) return setStatus1("Error • drawing capture failed");

    const existing = getRecord(roll);
    if (!existing?.request) return setStatus1("Error • add Request before saving");

    setRecord(roll, { ...existing, drawingDataUrl: dataUrl, updatedAt: Date.now() });
    state.hasUnsavedDrawing = false;
    restyleAllParcels();
    setStatus1(`Saved snowbridge • roll ${roll}`);

    if (state.drawEnabled) toggleDraw(false);
  }

  function deleteSnowbridge() {
    const roll = state.selectedRoll;
    if (!roll) return setStatus1("Select a parcel first");

    const rec = getRecord(roll);
    if (!rec) return setStatus1("Error • nothing stored for this parcel");

    const ok = window.confirm(`Delete stored snowbridge + request for ${roll}?`);
    if (!ok) return;

    deleteRecord(roll);
    featureClearCanvas(state);
    state.hasUnsavedDrawing = false;
    restyleAllParcels();
    setStatus1(`Deleted snowbridge • roll ${roll}`);
  }

  // -----------------------------
  // Request form (modal-ish prompt) — preserved
  // -----------------------------
  function openRequestForm() {
    const roll = state.selectedRoll;
    if (!roll) return setStatus1("Select a parcel first");

    const hasDrawing = state.hasUnsavedDrawing || !!getRecord(roll)?.drawingDataUrl;
    if (!hasDrawing) return setStatus1("Error • draw snowbridge before Request");

    const severity = (prompt("Severity (green / yellow / red):", "yellow") || "").toLowerCase().trim();
    const sev = severity === "green" || severity === "yellow" || severity === "red" ? severity : null;
    if (!sev) return setStatus1("Error • invalid severity");

    const seniors = (prompt("Seniors/at-risk on site? (yes/no):", "no") || "").toLowerCase().startsWith("y");
    const estSnow = (prompt("Estimated snow (e.g. 10cm, 20cm):", "10cm") || "").trim();
    const notes = (prompt("Notes (optional):", "") || "").trim();

    const existing = getRecord(roll) || {};
    setRecord(roll, {
      ...existing,
      request: { severity: sev, seniors, estSnow, notes },
      updatedAt: Date.now(),
    });

    restyleAllParcels();
    setStatus1(`Request saved • ${sev.toUpperCase()} • roll ${roll}`);
  }

  // -----------------------------
  // Layer event handlers (injected into map/layers.js)
  // -----------------------------
  function onParcelClick({ roll }) {
    if (!roll) return;

    if (state.isQueryStage && state.selectedRoll === roll) {
      openPanel();
      return;
    }

    enterQueryStage(state, roll, { source: "left-click" }, queryDeps.enter);
  }

  function onParcelContextMenu({ roll, pxX, pxY }) {
    if (!roll) return;

    showContextMenuAt(
      pxX,
      pxY,
      [{ label: "View", onClick: () => enterQueryStage(state, roll, { source: "right-click" }, queryDeps.enter) }],
      { menu: state.ctxMenu }
    );
  }

  // -----------------------------
  // Init
  // -----------------------------
  async function init() {
    setStatus1("Loading…");

    state.cfg = await loadConfigOrFallback({ onStatus: setStatus1 });

    const joinKey = state.cfg?.data?.joinKey || FALLBACK_CFG.data.joinKey;
    const files = state.cfg?.data?.files || FALLBACK_CFG.data.files;

    // Map
    state.map = L.map("map", { zoomControl: true });
    state.map.setMinZoom(state.cfg?.map?.minZoom ?? FALLBACK_CFG.map.minZoom);
    state.map.setMaxZoom(state.cfg?.map?.maxZoom ?? FALLBACK_CFG.map.maxZoom);

    // Basemap + satellite (satellite not added until toggleSatellite)
    const baseUrl = state.cfg?.basemaps?.base?.url || FALLBACK_CFG.basemaps.base.url;
    const baseOpt = { ...(state.cfg?.basemaps?.base?.options || FALLBACK_CFG.basemaps.base.options) };
    baseOpt.maxNativeZoom ??= 19;
    baseOpt.maxZoom ??= state.cfg?.map?.maxZoom ?? 22;
    state.basemap = L.tileLayer(baseUrl, baseOpt).addTo(state.map);

    const satUrl = state.cfg?.basemaps?.satellite?.url || FALLBACK_CFG.basemaps.satellite.url;
    const satOpt = { ...(state.cfg?.basemaps?.satellite?.options || FALLBACK_CFG.basemaps.satellite.options) };
    satOpt.maxNativeZoom ??= 19;
    satOpt.maxZoom ??= state.cfg?.map?.maxZoom ?? 22;
    state.satellite = L.tileLayer(satUrl, satOpt);

    // NEW: install sticky zoom behavior (preserved behavior, now in features/satellite.js)
    installSatelliteStickyZoom(state, { L, snowOutlineStyle: STYLE.snowOutline });

    // UI
    state.suggestBox = ensureSuggestBox();
    state.ctxMenu = ensureContextMenu();
    state.panel = ensurePanel({ loadUI, saveUI });

    // Canvas (draw feature)
    state.canvas = featureEnsureDrawCanvas(state, { mapEl: el.map });

    // Canvas sizing
    state.map.on("resize", () => featureResizeCanvasToMap(state));
    state.map.on("move", () => {
      /* keep canvas fixed to container */
    });
    featureResizeCanvasToMap(state);

    // Hide ctx menu on click elsewhere
    document.addEventListener("click", (e) => {
      if (state.ctxMenu && state.ctxMenu.style.display !== "none" && !state.ctxMenu.contains(e.target)) {
        hideContextMenu(state.ctxMenu);
      }
    });

    // Address UI
    if (el.addrBtn) el.addrBtn.addEventListener("click", onGo);

    if (el.addrInput) {
      const suggest = createSuggestHandlers(el.addrInput, /** @type {HTMLDivElement} */ (state.suggestBox), {
        getMatches: (q) => getSuggestions(q || "", state.addresses, 12),
        onPick: () => {
          // preserved: app.js previously only filled input + hid; no extra side effects
        },
        onGo,
        getIndex: () => state.suggestIndex,
        setIndex: (i) => {
          state.suggestIndex = Number.isFinite(i) ? i : -1;
        },
      });

      el.addrInput.addEventListener("keydown", suggest.onKeyDown);
      el.addrInput.addEventListener("input", suggest.onInput);
      el.addrInput.addEventListener("focus", suggest.onFocus);

      // Keep dropdown aligned with the input on layout changes
      const reposition = () => positionSuggestBox(el.addrInput, state.suggestBox);
      window.addEventListener("resize", reposition);
      window.addEventListener("scroll", reposition, true);
    }

    // Load data
    try {
      setStatus1("Loading parcels…");
      const parcelsGeo = await loadJSON(files.parcels);

      state.parcelsLayer = buildParcelsLayer(parcelsGeo, joinKey, {
        L,
        state,
        style: STYLE.idleParcel,
        onClick: onParcelClick,
        onContextMenu: onParcelContextMenu,
      }).addTo(state.map);

      setStatus1("Loading +8m snow zone…");
      const snowGeo = await loadJSON(files.snowZone);

      state.snowLayer = buildSnowLayer(snowGeo, joinKey, {
        L,
        state,
        style: STYLE.snowBase,
      }).addTo(state.map);

      try {
        state.parcelsLayer.bringToFront();
      } catch {}

      setStatus1("Loading addresses…");
      const addrGeo = await loadJSON(files.addresses);

      state.addresses = buildAddressIndex(addrGeo, joinKey, {
        labelFieldsPriority: state.cfg?.data?.addressLabelFieldsPriority,
      });

      const b = state.parcelsLayer?.getBounds?.();
      if (b && b.isValid && b.isValid()) {
        state.map.fitBounds(b, { padding: [20, 20] });
      } else {
        const sv = state.cfg?.map?.startView ?? FALLBACK_CFG.map.startView;
        state.map.setView([sv.lat, sv.lng], sv.zoom);
      }

      restyleAllParcels();

      setStatus1(`Ready • ${state.addresses.length} addresses • search or click a parcel`);
      console.log("Loaded:", {
        parcels: state.parcelByRoll.size,
        snowZone: state.snowByRoll.size,
        addresses: state.addresses.length,
      });
    } catch (e) {
      hardFail(e.message, e, { maxChars: state.cfg?.ui?.statusLineMaxChars });
    }
  }

  init();
})();
