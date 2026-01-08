/* SnowBridge — core/storage.js
   Local-only persistence (GitHub Pages safe)
   - DB records: loadDB/saveDB/getRecord/setRecord/deleteRecord
   - UI prefs:   loadUI/saveUI
   - Fail-soft: corrupt/empty localStorage resets to defaults ({}).
   - No DOM, no Leaflet.
*/

"use strict";

// -----------------------------
// Keys (must match app.js today)
// -----------------------------
export const LS_KEY = "snowbridge_v1";
export const LS_UI_KEY = "snowbridge_ui_v1";

// -----------------------------
// Internal helpers
// -----------------------------
function safeParseJSON(raw, fallbackObj = {}) {
  if (!raw) return fallbackObj;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : fallbackObj;
  } catch {
    return fallbackObj;
  }
}

function safeStringifyJSON(obj, fallback = "{}") {
  try {
    return JSON.stringify(obj);
  } catch {
    return fallback;
  }
}

function canUseLocalStorage() {
  try {
    return typeof localStorage !== "undefined";
  } catch {
    return false;
  }
}

function getLSItem(key) {
  if (!canUseLocalStorage()) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setLSItem(key, value) {
  if (!canUseLocalStorage()) return false;
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

// -----------------------------
// DB (records) — API preserved
// -----------------------------
export function loadDB() {
  const raw = getLSItem(LS_KEY);
  return safeParseJSON(raw, {});
}

export function saveDB(db) {
  setLSItem(LS_KEY, safeStringifyJSON(db, "{}"));
}

// schema:
// db[roll] = { drawingDataUrl: string, request: {...}, updatedAt:number }
export function getRecord(roll) {
  const db = loadDB();
  return db[String(roll)] || null;
}

export function setRecord(roll, rec) {
  const db = loadDB();
  db[String(roll)] = rec;
  saveDB(db);
}

export function deleteRecord(roll) {
  const db = loadDB();
  delete db[String(roll)];
  saveDB(db);
}

// -----------------------------
// UI prefs (panel geometry) — API preserved
// -----------------------------
export function loadUI() {
  const raw = getLSItem(LS_UI_KEY);
  return safeParseJSON(raw, {});
}

export function saveUI(partial) {
  const cur = loadUI();
  const next = { ...cur, ...(partial || {}) };
  setLSItem(LS_UI_KEY, safeStringifyJSON(next, "{}"));
}

// Optional small shim (harmless)
export const storageKeys = Object.freeze({ LS_KEY, LS_UI_KEY });
