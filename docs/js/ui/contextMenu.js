/* SnowBridge — ui/contextMenu.js
   Context menu DOM creation + show/hide logic + positioning (GitHub Pages safe)
   - Exports: CTX_ID, ensureContextMenu, hideContextMenu, showContextMenuAt, isContextMenuOpen
   - Preserves app.js behavior:
       - element id: #sbCtx
       - inline styles (even though styles.css also targets #sbCtx)
       - rows are <div> children with hover background + click hides then calls onClick
       - positioning uses clientX/clientY → cm.style.left/top in px (rounded)
   - No global state. You pass the menu element (or it will resolve/create it).
*/

"use strict";

// DOM IDs (must match app.js + styles.css)
export const CTX_ID = "sbCtx";

/**
 * Ensure the context menu exists in document.body.
 * Preserves app.js inline styles.
 * @param {object} [opts]
 * @param {string} [opts.id] - default "sbCtx"
 * @returns {HTMLDivElement}
 */
export function ensureContextMenu(opts = {}) {
  const id = String(opts?.id || CTX_ID).trim();

  /** @type {HTMLDivElement|null} */
  let cm = null;
  try {
    cm = /** @type {HTMLDivElement|null} */ (document.getElementById(id));
  } catch {
    cm = null;
  }
  if (cm) return cm;

  cm = document.createElement("div");
  cm.id = id;

  // Preserve app.js inline presentation
  cm.style.position = "absolute";
  cm.style.display = "none";
  cm.style.zIndex = "10000";
  cm.style.background = "#fff";
  cm.style.border = "1px solid #d1d5db";
  cm.style.borderRadius = "8px";
  cm.style.boxShadow = "0 10px 22px rgba(0,0,0,0.14)";
  cm.style.fontFamily = "system-ui, Arial, sans-serif";
  cm.style.fontSize = "14px";
  cm.style.minWidth = "140px";
  cm.style.overflow = "hidden";

  document.body.appendChild(cm);
  return cm;
}

/**
 * Hide + clear the context menu.
 * Mirrors app.js: display none + innerHTML cleared.
 * @param {HTMLElement|string|null} cmOrId - menu element or id; defaults to #sbCtx
 */
export function hideContextMenu(cmOrId = null) {
  const cm = resolveMenu(cmOrId);
  if (!cm) return;

  cm.style.display = "none";
  try {
    cm.innerHTML = "";
  } catch {}
}

/**
 * Show a context menu at screen pixels with a list of items.
 * Mirrors app.js:
 *  - clears innerHTML
 *  - creates row <div> for each item
 *  - hover background changes
 *  - click hides menu then calls item.onClick()
 *  - positions using rounded pxX/pxY
 *
 * @param {number} pxX
 * @param {number} pxY
 * @param {Array<{label:string,onClick:()=>void}>} items
 * @param {object} [opts]
 * @param {HTMLElement|string} [opts.menu] - existing menu element or id
 * @returns {HTMLDivElement|null} - the menu element (or null if cannot resolve/create)
 */
export function showContextMenuAt(pxX, pxY, items, opts = {}) {
  const cm = resolveMenu(opts?.menu || null, { ensure: true });
  if (!cm) return null;

  const list = Array.isArray(items) ? items : [];
  cm.innerHTML = "";

  for (const it of list) {
    const row = document.createElement("div");
    row.textContent = String(it?.label ?? "");
    row.style.padding = "10px 12px";
    row.style.cursor = "pointer";

    row.addEventListener("mouseenter", () => (row.style.background = "#f3f4f6"));
    row.addEventListener("mouseleave", () => (row.style.background = "transparent"));
    row.addEventListener("click", () => {
      hideContextMenu(cm);
      try {
        if (typeof it?.onClick === "function") it.onClick();
      } catch (e) {
        console.warn("Context menu item onClick failed", e);
      }
    });

    cm.appendChild(row);
  }

  const x = Number(pxX);
  const y = Number(pxY);
  cm.style.left = `${Math.round(Number.isFinite(x) ? x : 0)}px`;
  cm.style.top = `${Math.round(Number.isFinite(y) ? y : 0)}px`;
  cm.style.display = "block";

  return cm;
}

/**
 * Is the context menu currently open (visible)?
 * @param {HTMLElement|string|null} cmOrId
 * @returns {boolean}
 */
export function isContextMenuOpen(cmOrId = null) {
  const cm = resolveMenu(cmOrId);
  if (!cm) return false;
  return cm.style.display !== "none";
}

// -----------------------------
// Internal helpers
// -----------------------------
/**
 * Resolve the menu element from element or id; optionally ensure it exists.
 * @param {HTMLElement|string|null} cmOrId
 * @param {object} [opts]
 * @param {boolean} [opts.ensure=false]
 * @returns {HTMLDivElement|null}
 */
function resolveMenu(cmOrId, opts = {}) {
  const ensure = !!opts.ensure;

  if (cmOrId && typeof cmOrId === "object" && cmOrId.nodeType === 1) {
    return /** @type {HTMLDivElement} */ (cmOrId);
  }

  const id =
    typeof cmOrId === "string" && cmOrId.trim()
      ? cmOrId.trim()
      : CTX_ID;

  try {
    const el = /** @type {HTMLDivElement|null} */ (document.getElementById(id));
    if (el) return el;
  } catch {}

  return ensure ? ensureContextMenu({ id }) : null;
}
