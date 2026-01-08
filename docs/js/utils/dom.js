/* SnowBridge — utils/dom.js
   Tiny DOM helpers (GitHub Pages safe)
   - Keep minimal and predictable.
   - No app-specific side effects beyond safe DOM access.
   - Designed to match existing inline helpers used across modules.
*/

"use strict";

/**
 * Get element by id (fail-soft).
 * Mirrors the old app.js helper: const $ = (id) => document.getElementById(id);
 *
 * @param {string} id
 * @returns {HTMLElement|null}
 */
export function $(id) {
  try {
    return document.getElementById(String(id ?? ""));
  } catch {
    return null;
  }
}

/**
 * Get first match via querySelector (fail-soft).
 * @param {string} sel
 * @param {ParentNode|Document} [root=document]
 * @returns {Element|null}
 */
export function qs(sel, root = document) {
  try {
    const r = root && typeof root.querySelector === "function" ? root : document;
    return r.querySelector(String(sel ?? ""));
  } catch {
    return null;
  }
}

/**
 * Get all matches via querySelectorAll (fail-soft).
 * Returns a real array (not a NodeList) for convenience.
 * @param {string} sel
 * @param {ParentNode|Document} [root=document]
 * @returns {Element[]}
 */
export function qsa(sel, root = document) {
  try {
    const r = root && typeof root.querySelectorAll === "function" ? root : document;
    return Array.from(r.querySelectorAll(String(sel ?? "")));
  } catch {
    return [];
  }
}

/**
 * Add an event listener safely and return an unbind function.
 * @param {EventTarget|null|undefined} target
 * @param {string} type
 * @param {EventListenerOrEventListenerObject} handler
 * @param {any} [opts]
 * @returns {()=>void} unbind
 */
export function on(target, type, handler, opts) {
  if (!target || typeof target.addEventListener !== "function") return () => {};
  const t = String(type ?? "");
  if (!t) return () => {};

  try {
    target.addEventListener(t, handler, opts);
  } catch {
    return () => {};
  }

  return () => {
    try {
      target.removeEventListener(t, handler, opts);
    } catch {
      /* no-op */
    }
  };
}

/**
 * Set textContent safely.
 * @param {Node|null|undefined} el
 * @param {any} text
 * @returns {string} written string (or "" if no-op)
 */
export function setText(el, text) {
  if (!el || !("textContent" in el)) return "";
  const s = String(text ?? "");
  try {
    el.textContent = s;
  } catch {
    return "";
  }
  return s;
}

/**
 * Create an element with optional props (minimal helper).
 * - props.className (string)
 * - props.id (string)
 * - props.text (sets textContent)
 * - props.attrs (object of attributes)
 *
 * @param {string} tag
 * @param {object} [props]
 * @returns {HTMLElement|null}
 */
export function createEl(tag, props = {}) {
  const t = String(tag ?? "").trim();
  if (!t) return null;

  /** @type {HTMLElement|null} */
  let el = null;
  try {
    el = /** @type {HTMLElement} */ (document.createElement(t));
  } catch {
    return null;
  }

  try {
    if (props && typeof props === "object") {
      if (props.id != null) el.id = String(props.id);
      if (props.className != null) el.className = String(props.className);
      if (props.text != null) el.textContent = String(props.text);

      const attrs = props.attrs && typeof props.attrs === "object" ? props.attrs : null;
      if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
          if (v == null) continue;
          try {
            el.setAttribute(String(k), String(v));
          } catch {
            /* ignore bad attrs */
          }
        }
      }
    }
  } catch {
    /* fail-soft */
  }

  return el;
}

/**
 * Tiny RAF helper with fallback.
 * @param {()=>void} fn
 * @returns {number} id (or 0)
 */
export function raf(fn) {
  const cb = typeof fn === "function" ? fn : () => {};
  try {
    const r = typeof window !== "undefined" && window.requestAnimationFrame;
    if (typeof r === "function") return r(cb);
  } catch {}
  try {
    return window.setTimeout(cb, 0);
  } catch {
    return 0;
  }
}
