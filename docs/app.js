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
  polygonLatLngRingsFromGeoJSON,
  createOutsideMaskFromGeom,
  areaM2FromLayer,
  fmtArea,
  lockMapInteractions,
} from "./js/map/geometry.js";

/* SnowBridge — app.js (new interaction model)
   - Overview: address enter / left click / right click(View) enters "Query" stage
   - Query stage: zoom + slow blinking active parcel
   - Second left-click on active parcel opens draggable/resizable panel:
       View Size (area), View Satellite (masked to +8m), Draw (spray), Save/View/Delete Snowbridge, Request
   - Severity coloring persists (localStorage) and appears on overview
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
  // Panel wiring (ui/panel.js)
  // -----------------------------
  function openPanel() {
    uiOpenPanel(state, panelActions);
  }

  function closePanel() {
    uiClosePanel();
    exitQueryStage();
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
  // Drawing overlay (spray paint)
  // -----------------------------
  function ensureDrawCanvas() {
    let c = $("sbCanvas");
    if (c) return c;

    c = document.createElement("canvas");
    c.id = "sbCanvas";
    c.style.position = "absolute";
    c.style.left = "0";
    c.style.top = "0";
    c.style.zIndex = "8000";
    c.style.pointerEvents = "none";
    c.style.display = "none";

    el.map.appendChild(c);
    return c;
  }

  function resizeCanvasToMap() {
    const c = state.canvas;
    if (!c || !state.map) return;
    const size = state.map.getSize();
    c.width = size.x;
    c.height = size.y;
  }

  function clearCanvas() {
    const c = state.canvas;
    if (!c) return;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
  }

  function canvasToDataUrl() {
    const c = state.canvas;
    if (!c) return null;
    return c.toDataURL("image/png");
  }

  function loadDataUrlToCanvas(dataUrl) {
    return new Promise((resolve) => {
      const c = state.canvas;
      if (!c) return resolve(false);
      const ctx = c.getContext("2d");
      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0);
        resolve(true);
      };
      img.onerror = () => resolve(false);
      img.src = dataUrl;
    });
  }

  function enableDrawMode() {
    state.drawEnabled = true;

    if (!state.satOn) toggleSatellite(true);
    if (!state.satOn) return;

    lockMapInteractions(true, state.map);

    const roll = state.selectedRoll;
    const parcel = roll ? state.parcelByRoll.get(roll) : null;
    if (parcel) {
      const c = parcel.getBounds().getCenter();
      state.map.setView(c, 22, { animate: false });
    } else {
      state.map.setZoom(22, { animate: false });
    }

    state.canvas.style.display = "block";
    state.canvas.style.pointerEvents = "auto";
    state.canvas.style.cursor = "crosshair";

    setStatus1(`Draw ON • roll ${state.selectedRoll}`);

    let drawing = false;

    const brushR = 18;
    const dotsPerSpray = 26;

    const ctx = state.canvas.getContext("2d");
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgba(255,255,255,0.35)";

    const spray = (x, y) => {
      for (let i = 0; i < dotsPerSpray; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * brushR;
        const dx = Math.cos(a) * r;
        const dy = Math.sin(a) * r;
        ctx.beginPath();
        ctx.arc(x + dx, y + dy, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const toCanvasXY = (e) => {
      const rect = state.canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const onDown = (e) => {
      if (!state.drawEnabled) return;
      drawing = true;
      e.preventDefault();
      const { x, y } = toCanvasXY(e);
      spray(x, y);
      state.hasUnsavedDrawing = true;
    };

    const onMove = (e) => {
      if (!state.drawEnabled || !drawing) return;
      const { x, y } = toCanvasXY(e);
      spray(x, y);
      state.hasUnsavedDrawing = true;
    };

    const onUp = () => {
      drawing = false;
    };

    state.canvas.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);

    state._drawHandlers = { onDown, onMove, onUp };
  }

  function disableDrawMode() {
    state.drawEnabled = false;

    lockMapInteractions(false, state.map);

    state.canvas.style.pointerEvents = "none";
    state.canvas.style.cursor = "default";
    setStatus1(`Draw OFF • roll ${state.selectedRoll}`);

    const h = state._drawHandlers;
    if (h) {
      state.canvas.removeEventListener("mousedown", h.onDown);
      window.removeEventListener("mousemove", h.onMove);
      window.removeEventListener("mouseup", h.onUp);
    }
    state._drawHandlers = null;
  }

  // -----------------------------
  // Styling
  // -----------------------------
  const STYLE = {
    idleParcel: { weight: 1, opacity: 0.8, fillOpacity: 0.08, color: "#2563eb" },
    activeParcelA: { weight: 3, opacity: 1, fillOpacity: 0.18, color: "#f59e0b" },
    activeParcelB: { weight: 3, opacity: 0.65, fillOpacity: 0.03, color: "#f59e0b" },
    sizeOutline: { weight: 3, opacity: 1, fillOpacity: 0.0, color: "#111827" },
    snowOutline: { weight: 2, opacity: 1, fillOpacity: 0.0, color: "#ffffff" },
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
  // Address handling (data/addressIndex.js)
  // -----------------------------
  function onGo() {
    const q = el.addrInput?.value ?? "";
    const best = getSuggestions(q, state.addresses, 1)[0] || null;
    if (!best) return setStatus1("No match");
    enterQueryStage(best.roll, { center: [best.lat, best.lng], source: "address" });
  }

  // -----------------------------
  // Layers (IMPORTANT: snow layer non-interactive!)
  // -----------------------------
  function buildParcelsLayer(geojson, joinKey) {
    state.parcelByRoll.clear();

    return L.geoJSON(geojson, {
      style: STYLE.idleParcel,
      onEachFeature: (feature, layer) => {
        const roll = feature?.properties?.[joinKey];
        if (roll != null) state.parcelByRoll.set(String(roll), layer);

        layer.on("click", () => {
          if (roll == null) return;
          const r = String(roll);

          if (state.isQueryStage && state.selectedRoll === r) {
            openPanel();
            return;
          }

          enterQueryStage(r, { source: "left-click" });
        });

        layer.on("contextmenu", (e) => {
          if (roll == null) return;
          const r = String(roll);
          const px = e.originalEvent?.clientX ?? 0;
          const py = e.originalEvent?.clientY ?? 0;

          showContextMenuAt(
            px,
            py,
            [{ label: "View", onClick: () => enterQueryStage(r, { source: "right-click" }) }],
            { menu: state.ctxMenu }
          );
        });
      },
    });
  }

  function buildSnowLayer(geojson, joinKey) {
    state.snowByRoll.clear();

    return L.geoJSON(geojson, {
      interactive: false,
      style: { weight: 1, opacity: 0.35, fillOpacity: 0.0 },
      onEachFeature: (feature, layer) => {
        const roll = feature?.properties?.[joinKey];
        if (roll != null) state.snowByRoll.set(String(roll), layer);
      },
    });
  }

  // -----------------------------
  // Query stage (slow blink + zoom)
  // -----------------------------
  function stopBlink() {
    if (state.blinkTimer) window.clearInterval(state.blinkTimer);
    state.blinkTimer = null;
    state.blinkOn = false;
  }

  function startBlink() {
    stopBlink();
    state.blinkOn = true;
    state.blinkTimer = window.setInterval(() => {
      state.blinkOn = !state.blinkOn;
      if (state.selectedRoll) applyParcelStyle(state.selectedRoll);
    }, 650);
  }

  function fitToRoll(roll) {
    const padding = state.cfg?.map?.fitPaddingPx ?? 20;
    const target = state.parcelByRoll.get(roll);
    if (!target) return;
    state.map.fitBounds(target.getBounds(), { padding: [padding, padding] });
  }

  function zoomTight() {
    const z = Math.max(state.map.getZoom(), state.cfg?.map?.queryZoom ?? 19);
    state.map.setZoom(z);
  }

  function enterQueryStage(roll, { center = null, source = "" } = {}) {
    hideContextMenu(state.ctxMenu);

    const old = state.selectedRoll;

    state.selectedRoll = String(roll);
    state.isQueryStage = true;

    if (old) applyParcelStyle(old);
    applyParcelStyle(state.selectedRoll);

    if (center) state.map.setView(center, Math.max(state.map.getZoom(), 17));
    fitToRoll(state.selectedRoll);
    zoomTight();

    startBlink();
    setStatus1(`Query • roll ${state.selectedRoll}${source ? ` • ${source}` : ""}`);

    if (isPanelOpen()) openPanel();
  }

  function exitQueryStage() {
    stopBlink();
    toggleSatellite(false);
    toggleSize(false);
    if (state.drawEnabled) toggleDraw(false);

    const roll = state.selectedRoll;
    state.isQueryStage = false;
    state.selectedRoll = null;

    if (roll) applyParcelStyle(roll);
    setStatus1("Ready • search or click a parcel");
  }

  // -----------------------------
  // Size toggle
  // -----------------------------
  function clearSizeOverlays() {
    if (state.sizeOutlineLayer) {
      try {
        state.map.removeLayer(state.sizeOutlineLayer);
      } catch {}
      state.sizeOutlineLayer = null;
    }
    if (state.sizeLabelMarker) {
      try {
        state.map.removeLayer(state.sizeLabelMarker);
      } catch {}
      state.sizeLabelMarker = null;
    }
  }

  function toggleSize(force) {
    const next = typeof force === "boolean" ? force : !state.sizeOn;
    state.sizeOn = next;

    clearSizeOverlays();

    if (!next) {
      setStatus1(`Size OFF • roll ${state.selectedRoll}`);
      return;
    }

    const roll = state.selectedRoll;
    if (!roll) return setStatus1("Select a parcel first");

    const parcel = state.parcelByRoll.get(roll);
    if (!parcel) return setStatus1("Parcel not found");

    const areaM2 = areaM2FromLayer(parcel, { L, map: state.map });
    const txt = `Size • ${fmtArea(areaM2)}`;

    state.sizeOutlineLayer = L.geoJSON(parcel.toGeoJSON(), { style: STYLE.sizeOutline, interactive: false }).addTo(state.map);

    const c = parcel.getBounds().getCenter();
    state.sizeLabelMarker = L.marker(c, { interactive: false, opacity: 0.95 }).addTo(state.map);
    state.sizeLabelMarker.bindTooltip(txt, { permanent: true, direction: "top", offset: [0, -8] }).openTooltip();

    setStatus1(`${txt} • roll ${roll}`);
  }

  // -----------------------------
  // Satellite masked toggle (ONLY via panel)
  // -----------------------------
  function clearViewOverlays() {
    if (state.maskLayer) {
      try {
        state.map.removeLayer(state.maskLayer);
      } catch {}
      state.maskLayer = null;
    }
    if (state.snowOutlineLayer) {
      try {
        state.map.removeLayer(state.snowOutlineLayer);
      } catch {}
      state.snowOutlineLayer = null;
    }
  }

  function toggleSatellite(force) {
    const next = typeof force === "boolean" ? force : !state.satOn;
    state.satOn = next;

    clearViewOverlays();

    if (!next) {
      if (state.map.hasLayer(state.satellite)) state.map.removeLayer(state.satellite);
      setStatus1(`Satellite OFF • roll ${state.selectedRoll ?? ""}`.trim());
      return;
    }

    const roll = state.selectedRoll;
    if (!roll) return setStatus1("Select a parcel first");

    const minz = state.cfg?.map?.satelliteEnableMinZoom ?? 16;
    if (state.map.getZoom() < minz) state.map.setZoom(minz, { animate: false });

    const snow = state.snowByRoll.get(roll);
    if (!snow) {
      state.satOn = false;
      setStatus1("Snow zone not found (+8m join mismatch?)");
      return;
    }

    if (!state.map.hasLayer(state.satellite)) state.satellite.addTo(state.map);

    const gj = snow.toGeoJSON();
    const geom = gj?.geometry;
    const rings = polygonLatLngRingsFromGeoJSON(geom);
    if (!rings) {
      state.satOn = false;
      setStatus1("Unable to build mask from snow zone geometry");
      return;
    }

    const mask = createOutsideMaskFromGeom(geom, rings, L);
    if (!mask) {
      state.satOn = false;
      setStatus1("Unable to create mask layer");
      return;
    }

    state.maskLayer = mask.addTo(state.map);
    state.snowOutlineLayer = L.geoJSON(gj, { style: STYLE.snowOutline, interactive: false }).addTo(state.map);

    setStatus1(`Satellite ON • roll ${roll}`);
  }

  // -----------------------------
  // Draw toggle
  // -----------------------------
  function toggleDraw(force) {
    const next = typeof force === "boolean" ? force : !state.drawEnabled;

    if (next) {
      if (!state.satOn) toggleSatellite(true);
      if (!state.satOn) return;
      enableDrawMode();
      return;
    }

    disableDrawMode();
    state.canvas.style.display = "none";
    setStatus1(`Draw OFF • roll ${state.selectedRoll}`);
  }

  // -----------------------------
  // Save / View / Delete snowbridge
  // -----------------------------
  async function viewSnowbridge() {
    const roll = state.selectedRoll;
    if (!roll) return setStatus1("Select a parcel first");

    const rec = getRecord(roll);
    if (!rec?.drawingDataUrl) return setStatus1("No saved snowbridge for this parcel");

    if (!state.satOn) toggleSatellite(true);
    if (!state.satOn) return;

    state.canvas.style.display = "block";
    resizeCanvasToMap();
    await loadDataUrlToCanvas(rec.drawingDataUrl);
    setStatus1(`Loaded snowbridge • roll ${roll}`);
  }

  function saveSnowbridge() {
    const roll = state.selectedRoll;
    if (!roll) return setStatus1("Select a parcel first");

    if (!state.hasUnsavedDrawing && !getRecord(roll)?.drawingDataUrl) {
      return setStatus1("Error • no drawing to save");
    }

    const dataUrl = canvasToDataUrl();
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
    clearCanvas();
    state.hasUnsavedDrawing = false;
    restyleAllParcels();
    setStatus1(`Deleted snowbridge • roll ${roll}`);
  }

  // -----------------------------
  // Request form (modal-ish prompt)
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

    // Keep satellite + mask sticky once enabled
    state.map.on("zoomend", () => {
      if (!state.satOn) return;

      if (!state.map.hasLayer(state.satellite)) state.satellite.addTo(state.map);

      const roll = state.selectedRoll;
      if (!roll) return;

      const snow = state.snowByRoll.get(roll);
      if (!snow) return;

      if (!state.maskLayer || !state.snowOutlineLayer) {
        clearViewOverlays();

        const gj = snow.toGeoJSON();
        const geom = gj?.geometry;
        const rings = polygonLatLngRingsFromGeoJSON(geom);
        if (!rings) return;

        const mask = createOutsideMaskFromGeom(geom, rings, L);
        if (!mask) return;

        state.maskLayer = mask.addTo(state.map);
        state.snowOutlineLayer = L.geoJSON(gj, { style: STYLE.snowOutline, interactive: false }).addTo(state.map);
      }
    });

    // UI
    state.suggestBox = ensureSuggestBox();
    state.ctxMenu = ensureContextMenu();
    state.panel = ensurePanel({ loadUI, saveUI });
    state.canvas = ensureDrawCanvas();

    // Canvas sizing
    state.map.on("resize", () => resizeCanvasToMap());
    state.map.on("move", () => {
      /* keep canvas fixed to container */
    });
    resizeCanvasToMap();

    // Hide ctx menu on click elsewhere
    document.addEventListener("click", (e) => {
      if (state.ctxMenu && state.ctxMenu.style.display !== "none" && !state.ctxMenu.contains(e.target)) {
        hideContextMenu(state.ctxMenu);
      }
    });

    // Address UI
    if (el.addrBtn) el.addrBtn.addEventListener("click", onGo);

    if (el.addrInput) {
      // Create injected suggest wiring (preserves previous behavior)
      const suggest = createSuggestHandlers(el.addrInput, /** @type {HTMLDivElement} */ (state.suggestBox), {
        getMatches: (q) => getSuggestions(q || "", state.addresses, 12),
        onPick: () => {
          // app.js previously only filled input + hid; no extra side effects here
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
      state.parcelsLayer = buildParcelsLayer(parcelsGeo, joinKey).addTo(state.map);

      setStatus1("Loading +8m snow zone…");
      const snowGeo = await loadJSON(files.snowZone);
      state.snowLayer = buildSnowLayer(snowGeo, joinKey).addTo(state.map);

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
