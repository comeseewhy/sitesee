/* SnowBridge — ui/suggest.js
   Suggest dropdown (GitHub Pages safe)
   - Owns: DOM creation, positioning, rendering, active row highlighting, keyboard helpers.
   - Keeps DOM ID stable: #addrSuggest
   - No Leaflet, no map imports. Uses injected callbacks.
   - Behavior preserved from app.js:
       - absolute positioned box under #addrInput
       - rows are <div> children, textContent = label
       - hover highlight + click to pick
       - setActiveRow sets background on the active index
*/

"use strict";

// DOM IDs (must match app.js + styles.css)
export const SUGGEST_ID = "addrSuggest";

/**
 * Ensure the suggest box exists in document.body.
 * Preserves app.js inline styles (even though styles.css also targets #addrSuggest).
 * @param {object} [opts]
 * @param {string} [opts.id] - default "addrSuggest"
 * @returns {HTMLDivElement}
 */
export function ensureSuggestBox(opts = {}) {
  const id = (opts?.id || SUGGEST_ID).trim();
  let box = null;

  try {
    box = /** @type {HTMLDivElement|null} */ (document.getElementById(id));
  } catch {
    box = null;
  }
  if (box) return box;

  box = document.createElement("div");
  box.id = id;

  // Preserve the old inlined presentation (safe even if CSS exists)
  box.style.position = "absolute";
  box.style.zIndex = "9999";
  box.style.display = "none";
  box.style.maxHeight = "260px";
  box.style.overflow = "auto";
  box.style.background = "#fff";
  box.style.border = "1px solid #d1d5db";
  box.style.borderRadius = "8px";
  box.style.boxShadow = "0 6px 18px rgba(0,0,0,0.10)";
  box.style.fontFamily = "system-ui, Arial, sans-serif";
  box.style.fontSize = "14px";

  document.body.appendChild(box);
  return box;
}

/**
 * Position the suggest box under an input element.
 * Mirrors app.js: left aligned to input, 6px below, same width.
 * @param {HTMLElement} inputEl
 * @param {HTMLElement} box
 */
export function positionSuggestBox(inputEl, box) {
  if (!inputEl || !box) return;
  try {
    const r = inputEl.getBoundingClientRect();
    box.style.left = `${Math.round(r.left)}px`;
    box.style.top = `${Math.round(r.bottom + 6)}px`;
    box.style.width = `${Math.round(r.width)}px`;
  } catch {
    /* no-op */
  }
}

/**
 * Highlight a child row by index (background only) and clear others.
 * Mirrors app.js behavior.
 * @param {HTMLElement} box
 * @param {number} idx
 */
export function setActiveRow(box, idx) {
  if (!box) return;
  const kids = Array.from(box.children);
  kids.forEach((node, i) => {
    if (node && node.style) node.style.background = i === idx ? "#e5e7eb" : "transparent";
  });
}

/**
 * Render a list of suggestion items into the box.
 * - items: array of { label, ... }
 * - onPick: callback receives item
 * Mirrors app.js: rows are divs with inline styles + mouseenter/mouseleave + click.
 *
 * @param {HTMLElement} box
 * @param {Array<{label:string,[k:string]:any}>} items
 * @param {(item:any)=>void} onPick
 * @param {object} [opts]
 * @param {HTMLElement} [opts.inputEl] - if provided, box will be positioned after rendering
 */
export function renderSuggestions(box, items, onPick, opts = {}) {
  if (!box) return;

  const list = Array.isArray(items) ? items : [];
  box.innerHTML = "";

  if (!list.length) {
    box.style.display = "none";
    return;
  }

  for (const it of list) {
    const row = document.createElement("div");
    row.textContent = String(it?.label ?? "");

    // Preserve row styling from app.js
    row.style.padding = "10px 10px";
    row.style.cursor = "pointer";
    row.style.whiteSpace = "nowrap";
    row.style.overflow = "hidden";
    row.style.textOverflow = "ellipsis";

    row.addEventListener("mouseenter", () => (row.style.background = "#f3f4f6"));
    row.addEventListener("mouseleave", () => (row.style.background = "transparent"));
    row.addEventListener("click", () => {
      try {
        if (typeof onPick === "function") onPick(it);
      } catch (e) {
        console.warn("Suggest onPick failed", e);
      }
    });

    box.appendChild(row);
  }

  if (opts?.inputEl) positionSuggestBox(opts.inputEl, box);
  box.style.display = "block";
}

/**
 * Hide and clear suggest box.
 * @param {HTMLElement} box
 */
export function hideSuggestions(box) {
  if (!box) return;
  box.style.display = "none";
  // Preserve existing behavior: app.js typically just hid; clearing is safe + avoids stale rows
  try {
    box.innerHTML = "";
  } catch {}
}

/**
 * Is the suggest box currently open (visible + has children)?
 * @param {HTMLElement} box
 * @returns {boolean}
 */
export function isSuggestOpen(box) {
  if (!box) return false;
  return box.style.display !== "none" && box.children && box.children.length > 0;
}

/**
 * Get the label text of the active row (by index).
 * Matches app.js: reads box.children[idx].textContent
 * @param {HTMLElement} box
 * @param {number} idx
 * @returns {string|null}
 */
export function getActiveLabel(box, idx) {
  if (!box) return null;
  const el = box.children?.[idx];
  const txt = el && "textContent" in el ? String(el.textContent || "") : "";
  return txt.trim() ? txt : null;
}

/**
 * Create handlers that wire input → suggestions.
 * This keeps suggest.js “UI only”: it doesn’t know how to compute suggestions.
 *
 * You pass:
 * - getMatches(query) => items[]
 * - onPick(item) called when a suggestion is clicked
 * - onGo() called when Enter should perform search/go
 * - setIndex(i)/getIndex() allow state to live in your app state
 *
 * Keyboard behavior preserved:
 * - If dropdown open and ArrowUp/Down: move index + highlight
 * - If open and Enter with active index: fill input with label, hide, then onGo()
 * - Else Enter: onGo()
 * - input/focus: recompute matches, reset index, render
 *
 * @param {HTMLInputElement} inputEl
 * @param {HTMLDivElement} box
 * @param {object} deps
 * @param {(q:string)=>Array<any>} deps.getMatches
 * @param {(item:any)=>void} deps.onPick
 * @param {()=>void} deps.onGo
 * @param {()=>number} deps.getIndex
 * @param {(i:number)=>void} deps.setIndex
 * @param {number} [deps.limit] - optional; your getMatches can ignore; provided for convenience
 * @returns {{ onKeyDown:(e:KeyboardEvent)=>void, onInput:()=>void, onFocus:()=>void, refresh:()=>void }}
 */
export function createSuggestHandlers(inputEl, box, deps) {
  const getMatches = typeof deps?.getMatches === "function" ? deps.getMatches : () => [];
  const onPick = typeof deps?.onPick === "function" ? deps.onPick : () => {};
  const onGo = typeof deps?.onGo === "function" ? deps.onGo : () => {};
  const getIndex = typeof deps?.getIndex === "function" ? deps.getIndex : () => -1;
  const setIndex = typeof deps?.setIndex === "function" ? deps.setIndex : () => {};

  const refresh = () => {
    const q = inputEl?.value || "";
    const matches = getMatches(q) || [];
    setIndex(-1);

    renderSuggestions(
      box,
      matches,
      (picked) => {
        // Preserve app.js: input value becomes picked.label; hide dropdown
        try {
          inputEl.value = String(picked?.label ?? "");
        } catch {}
        setIndex(-1);
        if (box) box.style.display = "none";
        try {
          onPick(picked);
        } catch (e) {
          console.warn("Suggest onPick failed", e);
        }
      },
      { inputEl }
    );
  };

  const onKeyDown = (e) => {
    const open = isSuggestOpen(box);

    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const n = box.children.length;
      if (!n) return;

      let idx = Number(getIndex());
      if (!Number.isFinite(idx)) idx = -1;

      if (e.key === "ArrowDown") idx = (idx + 1) % n;
      if (e.key === "ArrowUp") idx = (idx - 1 + n) % n;

      setIndex(idx);
      setActiveRow(box, idx);
      return;
    }

    if (open && e.key === "Enter" && Number(getIndex()) >= 0) {
      e.preventDefault();
      const pickedLabel = getActiveLabel(box, Number(getIndex()));
      if (pickedLabel) {
        inputEl.value = pickedLabel;
        box.style.display = "none";
        onGo();
      }
      return;
    }

    if (e.key === "Enter") onGo();
  };

  const onInput = () => refresh();
  const onFocus = () => refresh();

  return { onKeyDown, onInput, onFocus, refresh };
}
