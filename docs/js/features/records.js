/* SnowBridge — features/records.js
   CRUD actions + request flow (GitHub Pages safe)
   - Exports: viewSnowbridge, saveSnowbridge, deleteSnowbridge, openRequestForm
   - Hard constraint: storage is injected (getRecord/setRecord/deleteRecord)
   - Preserves app.js behavior + one-line status messaging.
*/

"use strict";

/**
 * View the stored snowbridge drawing for the selected roll (behavior preserved).
 *
 * deps (injected):
 * - getRecord(roll)
 * - setStatus1(msg)
 * - toggleSatellite(force)
 * - resizeCanvasToMap(state)
 * - loadDataUrlToCanvas(state, dataUrl) => Promise<boolean>
 *
 * @param {object} state
 * @param {object} deps
 */
export async function viewSnowbridge(state, deps = {}) {
  const st = state;

  const getRecord = typeof deps.getRecord === "function" ? deps.getRecord : null;
  const setStatus1 = typeof deps.setStatus1 === "function" ? deps.setStatus1 : null;
  const toggleSatellite = typeof deps.toggleSatellite === "function" ? deps.toggleSatellite : null;

  const resizeCanvasToMap = typeof deps.resizeCanvasToMap === "function" ? deps.resizeCanvasToMap : null;
  const loadDataUrlToCanvas = typeof deps.loadDataUrlToCanvas === "function" ? deps.loadDataUrlToCanvas : null;

  const roll = st?.selectedRoll ? String(st.selectedRoll) : null;
  if (!roll) return setStatus1 ? setStatus1("Select a parcel first") : undefined;

  if (!getRecord) return setStatus1 ? setStatus1("Error • storage unavailable") : undefined;

  const rec = getRecord(roll);
  if (!rec?.drawingDataUrl) return setStatus1 ? setStatus1("No saved snowbridge for this parcel") : undefined;

  // Preserve: viewing forces satellite ON (masked)
  if (!st.satOn && toggleSatellite) toggleSatellite(true);
  if (!st.satOn) return; // preserve: app.js bails if still not on

  if (st.canvas) st.canvas.style.display = "block";

  try {
    if (resizeCanvasToMap) resizeCanvasToMap(st);
    if (loadDataUrlToCanvas) await loadDataUrlToCanvas(st, rec.drawingDataUrl);
  } catch {
    // preserve fail-soft behavior (app.js didn’t show a special message here)
  }

  if (setStatus1) setStatus1(`Loaded snowbridge • roll ${roll}`);
}

/**
 * Save current canvas drawing to storage for the selected roll (behavior preserved).
 *
 * deps (injected):
 * - getRecord(roll)
 * - setRecord(roll, rec)
 * - setStatus1(msg)
 * - restyleAllParcels()
 * - canvasToDataUrl(state) => string|null
 * - toggleDraw(force)
 *
 * @param {object} state
 * @param {object} deps
 */
export function saveSnowbridge(state, deps = {}) {
  const st = state;

  const getRecord = typeof deps.getRecord === "function" ? deps.getRecord : null;
  const setRecord = typeof deps.setRecord === "function" ? deps.setRecord : null;
  const setStatus1 = typeof deps.setStatus1 === "function" ? deps.setStatus1 : null;

  const restyleAllParcels = typeof deps.restyleAllParcels === "function" ? deps.restyleAllParcels : null;
  const canvasToDataUrl = typeof deps.canvasToDataUrl === "function" ? deps.canvasToDataUrl : null;
  const toggleDraw = typeof deps.toggleDraw === "function" ? deps.toggleDraw : null;

  const roll = st?.selectedRoll ? String(st.selectedRoll) : null;
  if (!roll) return setStatus1 ? setStatus1("Select a parcel first") : undefined;

  if (!getRecord || !setRecord) return setStatus1 ? setStatus1("Error • storage unavailable") : undefined;

  // Preserve: if nothing unsaved and nothing already stored, error
  if (!st.hasUnsavedDrawing && !getRecord(roll)?.drawingDataUrl) {
    return setStatus1 ? setStatus1("Error • no drawing to save") : undefined;
  }

  const dataUrl = canvasToDataUrl ? canvasToDataUrl(st) : null;
  if (!dataUrl || dataUrl.length < 200) return setStatus1 ? setStatus1("Error • drawing capture failed") : undefined;

  const existing = getRecord(roll);

  // Preserve: must have Request before saving
  if (!existing?.request) return setStatus1 ? setStatus1("Error • add Request before saving") : undefined;

  setRecord(roll, { ...existing, drawingDataUrl: dataUrl, updatedAt: Date.now() });
  st.hasUnsavedDrawing = false;

  try {
    if (restyleAllParcels) restyleAllParcels();
  } catch {
    /* no-op */
  }

  if (setStatus1) setStatus1(`Saved snowbridge • roll ${roll}`);

  // Preserve: if draw is on, toggle it off after saving
  if (st.drawEnabled && toggleDraw) toggleDraw(false);
}

/**
 * Delete stored snowbridge + request for the selected roll (behavior preserved).
 *
 * deps (injected):
 * - getRecord(roll)
 * - deleteRecord(roll)
 * - setStatus1(msg)
 * - restyleAllParcels()
 * - clearCanvas(state)
 *
 * @param {object} state
 * @param {object} deps
 */
export function deleteSnowbridge(state, deps = {}) {
  const st = state;

  const getRecord = typeof deps.getRecord === "function" ? deps.getRecord : null;
  const deleteRecord = typeof deps.deleteRecord === "function" ? deps.deleteRecord : null;
  const setStatus1 = typeof deps.setStatus1 === "function" ? deps.setStatus1 : null;

  const restyleAllParcels = typeof deps.restyleAllParcels === "function" ? deps.restyleAllParcels : null;
  const clearCanvas = typeof deps.clearCanvas === "function" ? deps.clearCanvas : null;

  const roll = st?.selectedRoll ? String(st.selectedRoll) : null;
  if (!roll) return setStatus1 ? setStatus1("Select a parcel first") : undefined;

  if (!getRecord || !deleteRecord) return setStatus1 ? setStatus1("Error • storage unavailable") : undefined;

  const rec = getRecord(roll);
  if (!rec) return setStatus1 ? setStatus1("Error • nothing stored for this parcel") : undefined;

  // Preserve confirm text
  const ok = typeof window !== "undefined" && typeof window.confirm === "function"
    ? window.confirm(`Delete stored snowbridge + request for ${roll}?`)
    : true;

  if (!ok) return;

  deleteRecord(roll);

  try {
    if (clearCanvas) clearCanvas(st);
  } catch {
    /* no-op */
  }

  st.hasUnsavedDrawing = false;

  try {
    if (restyleAllParcels) restyleAllParcels();
  } catch {
    /* no-op */
  }

  if (setStatus1) setStatus1(`Deleted snowbridge • roll ${roll}`);
}

/**
 * Prompt-based request form (modal-ish) — preserved.
 *
 * deps (injected):
 * - getRecord(roll)
 * - setRecord(roll, rec)
 * - setStatus1(msg)
 * - restyleAllParcels()
 *
 * @param {object} state
 * @param {object} deps
 */
export function openRequestForm(state, deps = {}) {
  const st = state;

  const getRecord = typeof deps.getRecord === "function" ? deps.getRecord : null;
  const setRecord = typeof deps.setRecord === "function" ? deps.setRecord : null;
  const setStatus1 = typeof deps.setStatus1 === "function" ? deps.setStatus1 : null;

  const restyleAllParcels = typeof deps.restyleAllParcels === "function" ? deps.restyleAllParcels : null;

  const roll = st?.selectedRoll ? String(st.selectedRoll) : null;
  if (!roll) return setStatus1 ? setStatus1("Select a parcel first") : undefined;

  if (!getRecord || !setRecord) return setStatus1 ? setStatus1("Error • storage unavailable") : undefined;

  // Preserve: require drawing (either unsaved on canvas OR already saved for roll)
  const hasDrawing = !!st.hasUnsavedDrawing || !!getRecord(roll)?.drawingDataUrl;
  if (!hasDrawing) return setStatus1 ? setStatus1("Error • draw snowbridge before Request") : undefined;

  // Preserve prompts + defaults
  const promptFn = typeof window !== "undefined" && typeof window.prompt === "function" ? window.prompt : null;

  const severityRaw = (promptFn ? promptFn("Severity (green / yellow / red):", "yellow") : "yellow") || "";
  const severity = String(severityRaw).toLowerCase().trim();
  const sev = severity === "green" || severity === "yellow" || severity === "red" ? severity : null;
  if (!sev) return setStatus1 ? setStatus1("Error • invalid severity") : undefined;

  const seniorsRaw = (promptFn ? promptFn("Seniors/at-risk on site? (yes/no):", "no") : "no") || "";
  const seniors = String(seniorsRaw).toLowerCase().startsWith("y");

  const estSnow = String((promptFn ? promptFn("Estimated snow (e.g. 10cm, 20cm):", "10cm") : "10cm") || "").trim();
  const notes = String((promptFn ? promptFn("Notes (optional):", "") : "") || "").trim();

  const existing = getRecord(roll) || {};
  setRecord(roll, {
    ...existing,
    request: { severity: sev, seniors, estSnow, notes },
    updatedAt: Date.now(),
  });

  try {
    if (restyleAllParcels) restyleAllParcels();
  } catch {
    /* no-op */
  }

  if (setStatus1) setStatus1(`Request saved • ${sev.toUpperCase()} • roll ${roll}`);
}
