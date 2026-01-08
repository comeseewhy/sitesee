/* SnowBridge — ui/status.js
   One-line status messaging (GitHub Pages safe)
   - Exports: setStatus, hardFail
   - Preserves app.js behavior: whitespace-collapsed, trimmed, textContent write.
   - Optional: pass { el } or { id } to target a specific element; defaults to #status.
*/

"use strict";

const DEFAULT_STATUS_ID = "status";

/** @returns {HTMLElement|null} */
function resolveStatusEl(target) {
  if (target && typeof target === "object" && target.nodeType === 1) return /** @type {HTMLElement} */ (target);
  const id = typeof target === "string" && target.trim() ? target.trim() : DEFAULT_STATUS_ID;
  try {
    return document.getElementById(id);
  } catch {
    return null;
  }
}

/**
 * Set the status line to a single-line string.
 * @param {any} msg
 * @param {object} [opts]
 * @param {HTMLElement} [opts.el] - direct element target (preferred)
 * @param {string} [opts.id] - element id target (default "status")
 * @param {number} [opts.maxChars] - optional hard cap; omit to preserve current behavior
 * @returns {string} normalized status string (or "" if no element)
 */
export function setStatus(msg, opts = {}) {
  const el = resolveStatusEl(opts.el || opts.id);
  if (!el) return "";

  let s = String(msg ?? "").replace(/\s+/g, " ").trim();

  // Optional hard cap (kept opt-in to avoid silent behavior changes)
  const maxChars = Number(opts.maxChars);
  if (Number.isFinite(maxChars) && maxChars > 0 && s.length > maxChars) {
    s = maxChars >= 2 ? `${s.slice(0, maxChars - 1)}…` : "…";
  }

  el.textContent = s;
  return s;
}

/**
 * Log an error and show a single-line "Error: ..." message.
 * @param {string} msg
 * @param {any} [err]
 * @param {object} [opts] - forwarded to setStatus (el/id/maxChars)
 */
export function hardFail(msg, err, opts = {}) {
  try {
    // Preserve existing behavior: console.error(msg, err || "")
    console.error(msg, err || "");
  } catch {}
  setStatus(`Error: ${msg}`, opts);
}
