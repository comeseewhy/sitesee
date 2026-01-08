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
    // Accessing localStorage can throw in some privacy modes
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

/**
 * Loads the whole records DB object from localStorage.
 * Returns {} on missing/corrupt/unavailable storage.
 */
export function loadDB() {
  const raw = getLSItem(LS_KEY);
  return safeParseJSON(raw, {});
}

/**
 * Saves the whole records DB object to localStorage.
 * No-op if localStorage is unavailable.
 */
export function saveDB(db) {
  // Preserve behavior: app.js assumes JSON.stringify(db) always happens.
  // Fail-soft: if stringify fails, store "{}" rather than throwing.
  setLSItem(LS_KEY, safeStringifyJSON(db, "{}"));
}

/**
 * Returns a record object for a roll, or null if missing.
 * Join-key logic is sacred: always treat roll as string.
 */
export function getRecord(roll) {
  const db = loadDB();
  return db[String(roll)] || null;
}

/**
 * Sets/overwrites a record for a roll.
 * Join-key logic is sacred: always treat roll as string.
 */
export function setRecord(roll, rec) {
  const db = loadDB();
  db[String(roll)] = rec;
  saveDB(db);
}

/**
 * Deletes a record for a roll (if present).
 * Join-key logic is sacred: always treat roll as string.
 */
export function deleteRecord(roll) {
  const db = loadDB();
  delete db[String(roll)];
  saveDB(db);
}

// -----------------------------
// UI prefs (panel geometry) — API preserved
// -----------------------------

/**
 * Loads UI prefs object from localStorage.
 * Returns {} on missing/corrupt/unavailable storage.
 */
export function loadUI() {
  const raw = getLSItem(LS_UI_KEY);
  return safeParseJSON(raw, {});
}

/**
 * Merges partial UI prefs into stored UI prefs object.
 * No-op if localStorage is unavailable.
 */
export function saveUI(partial) {
  const cur = loadUI();
  // Preserve behavior: shallow merge with spread
  const next = { ...cur, ...(partial || {}) };
  setLSItem(LS_UI_KEY, safeStringifyJSON(next, "{}"));
}

/**
 * Optional compatibility shim (some future rename safety):
 * Allows code to import `storageKeys` if desired later.
 * Not used by current app.js, harmless to keep.
 */
export const storageKeys = Object.freeze({
  LS_KEY,
  LS_UI_KEY,
});
