/* SnowBridge — ui/panel.js
   Draggable + resizable floating panel (GitHub Pages safe)
   - Owns: DOM creation, open/close, button wiring
   - Preserves app.js behavior + DOM IDs/styles:
       #sbPanel, #sbPanelHeader, #sbPanelBody
   - Uses "actions injection": panel calls injected actions (no feature imports)
   - UI position/size persistence goes through injected storage helpers (loadUI/saveUI)
*/

"use strict";

// DOM IDs (must match app.js + styles.css)
export const PANEL_ID = "sbPanel";
export const PANEL_HEADER_ID = "sbPanelHeader";
export const PANEL_BODY_ID = "sbPanelBody";

/** @returns {HTMLElement|null} */
function $(id) {
  try {
    return document.getElementById(id);
  } catch {
    return null;
  }
}

function noop() {}

/**
 * Ensure the SnowBridge panel exists in document.body.
 * Restores saved geometry via injected storage helpers.
 *
 * @param {object} deps
 * @param {()=>any} [deps.loadUI] - returns ui prefs object
 * @param {(partial:any)=>void} [deps.saveUI] - merges + saves ui prefs
 * @param {object} [opts]
 * @param {string} [opts.id] - panel id (default "sbPanel")
 * @returns {HTMLDivElement}
 */
export function ensurePanel(deps = {}, opts = {}) {
  const id = String(opts?.id || PANEL_ID).trim();

  /** @type {HTMLDivElement|null} */
  let p = null;
  try {
    p = /** @type {HTMLDivElement|null} */ ($(id));
  } catch {
    p = null;
  }
  if (p) return p;

  p = document.createElement("div");
  p.id = id;

  // Preserve app.js inline presentation (CSS also targets these IDs)
  p.style.position = "absolute";
  p.style.zIndex = "10001";
  p.style.display = "none";
  p.style.left = "14px";
  p.style.top = "74px";
  p.style.width = "320px";
  p.style.height = "340px";
  p.style.background = "#ffffff";
  p.style.border = "1px solid #d1d5db";
  p.style.borderRadius = "12px";
  p.style.boxShadow = "0 14px 34px rgba(0,0,0,0.16)";
  p.style.overflow = "auto";
  p.style.resize = "both";
  p.style.minWidth = "260px";
  p.style.minHeight = "220px";

  const header = document.createElement("div");
  header.id = PANEL_HEADER_ID;
  header.style.cursor = "move";
  header.style.padding = "10px 12px";
  header.style.borderBottom = "1px solid #e5e7eb";
  header.style.fontWeight = "600";
  header.textContent = "SnowBridge";

  const body = document.createElement("div");
  body.id = PANEL_BODY_ID;
  body.style.padding = "10px 12px";

  p.appendChild(header);
  p.appendChild(body);
  document.body.appendChild(p);

  const loadUI = typeof deps?.loadUI === "function" ? deps.loadUI : null;
  const saveUI = typeof deps?.saveUI === "function" ? deps.saveUI : null;

  // restore last panel position/size
  try {
    const ui = loadUI ? loadUI() : null;
    if (ui && typeof ui === "object") {
      if (ui.panelLeft) p.style.left = ui.panelLeft;
      if (ui.panelTop) p.style.top = ui.panelTop;
      if (ui.panelWidth) p.style.width = ui.panelWidth;
      if (ui.panelHeight) p.style.height = ui.panelHeight;
    }
  } catch {
    /* fail-soft */
  }

  const persist = () => {
    if (!saveUI) return;
    try {
      saveUI({
        panelLeft: p.style.left,
        panelTop: p.style.top,
        panelWidth: p.style.width,
        panelHeight: p.style.height,
      });
    } catch {
      /* fail-soft */
    }
  };

  // drag logic (preserved)
  let dragging = false;
  let startX = 0,
    startY = 0,
    startL = 0,
    startT = 0;

  header.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = p.getBoundingClientRect();
    startL = rect.left;
    startT = rect.top;
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    p.style.left = `${Math.round(startL + dx)}px`;
    p.style.top = `${Math.round(startT + dy)}px`;
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    persist();
  });

  // Resize persistence (preserved)
  try {
    new ResizeObserver(() => persist()).observe(p);
  } catch {
    /* optional */
  }

  return p;
}

/**
 * Open the panel and render buttons. Panel calls injected actions.
 *
 * Hard constraint: actions must be accepted as:
 * { toggleSize, toggleSatellite, toggleDraw, saveSnowbridge, viewSnowbridge,
 *   openRequestForm, deleteSnowbridge, closePanel }
 *
 * @param {object} state - expects { selectedRoll }
 * @param {object} actions - injected action functions
 */
export function openPanel(state, actions = {}) {
  const p = /** @type {HTMLDivElement|null} */ ($(PANEL_ID));
  const body = /** @type {HTMLDivElement|null} */ ($(PANEL_BODY_ID));
  const header = /** @type {HTMLDivElement|null} */ ($(PANEL_HEADER_ID));
  if (!p || !body || !header) return;

  const roll = state?.selectedRoll;
  if (!roll) return;

  header.textContent = `SnowBridge • ${roll}`;
  body.innerHTML = "";

  const safeAction = (fn) => (typeof fn === "function" ? fn : noop);

  const a = {
    toggleSize: safeAction(actions.toggleSize),
    toggleSatellite: safeAction(actions.toggleSatellite),
    toggleDraw: safeAction(actions.toggleDraw),
    saveSnowbridge: safeAction(actions.saveSnowbridge),
    viewSnowbridge: safeAction(actions.viewSnowbridge),
    openRequestForm: safeAction(actions.openRequestForm),
    deleteSnowbridge: safeAction(actions.deleteSnowbridge),
    closePanel: safeAction(actions.closePanel),
  };

  const mkBtn = (label) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.display = "block";
    b.style.width = "100%";
    b.style.padding = "10px 10px";
    b.style.margin = "8px 0";
    b.style.borderRadius = "10px";
    b.style.border = "1px solid #d1d5db";
    b.style.background = "#f9fafb";
    b.style.cursor = "pointer";
    b.addEventListener("mouseenter", () => (b.style.background = "#f3f4f6"));
    b.addEventListener("mouseleave", () => (b.style.background = "#f9fafb"));
    return b;
  };

  const mkNote = (text) => {
    const d = document.createElement("div");
    d.textContent = text;
    d.style.fontSize = "13px";
    d.style.color = "#4b5563";
    d.style.marginTop = "6px";
    return d;
  };

  const bSize = mkBtn("View size (toggle)");
  bSize.onclick = () => a.toggleSize();
  body.appendChild(bSize);

  const bSat = mkBtn("View satellite (toggle)");
  bSat.onclick = () => a.toggleSatellite();
  body.appendChild(bSat);

  const bDraw = mkBtn("Draw snowbridge (toggle)");
  bDraw.onclick = () => a.toggleDraw();
  body.appendChild(bDraw);

  const bSave = mkBtn("Save snowbridge");
  bSave.onclick = () => a.saveSnowbridge();
  body.appendChild(bSave);

  const bView = mkBtn("View snowbridge");
  bView.onclick = () => a.viewSnowbridge();
  body.appendChild(bView);

  const bReq = mkBtn("Request");
  bReq.onclick = () => a.openRequestForm();
  body.appendChild(bReq);

  const bDel = mkBtn("Delete snowbridge");
  bDel.onclick = () => a.deleteSnowbridge();
  body.appendChild(bDel);

  const bExit = mkBtn("Exit");
  bExit.onclick = () => a.closePanel();
  body.appendChild(bExit);

  body.appendChild(mkNote("Tip: Right-click parcel → View. Left-click active parcel again → open this panel."));

  p.style.display = "block";
}

/**
 * Close/hide the panel (does not change map/query stage by itself).
 * Your injected closePanel action should handle any stage exit logic.
 */
export function closePanel() {
  const p = /** @type {HTMLDivElement|null} */ ($(PANEL_ID));
  if (!p) return;
  p.style.display = "none";
}

/**
 * Is the panel currently visible?
 * @returns {boolean}
 */
export function isPanelOpen() {
  const p = /** @type {HTMLDivElement|null} */ ($(PANEL_ID));
  if (!p) return false;
  return p.style.display !== "none";
}
