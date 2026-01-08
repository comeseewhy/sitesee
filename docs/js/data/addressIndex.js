/* SnowBridge — data/addressIndex.js
   Address normalization + indexing + suggestion retrieval (GitHub Pages safe)
   - Exports: normalizeAddr, tokenizeNorm, scoreAddressCandidate, buildAddressIndex, getSuggestions
   - No DOM, no Leaflet.
   - Deterministic ordering for equal scores.
   - Preserves current app.js behavior by default.
*/

"use strict";

/**
 * Normalize an address string (behavior preserved from app.js)
 * @param {string} s
 * @returns {string}
 */
export function normalizeAddr(s) {
  return String(s ?? "")
    .toUpperCase()
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tokenize an already-normalized address
 * @param {string} norm
 * @returns {string[]}
 */
export function tokenizeNorm(norm) {
  return String(norm ?? "")
    .split(" ")
    .filter(Boolean);
}

/**
 * Score a candidate address against a query (behavior preserved from app.js)
 * @param {string} qNorm normalized query
 * @param {string} candNorm normalized candidate
 * @returns {number}
 */
export function scoreAddressCandidate(qNorm, candNorm) {
  if (!qNorm || !candNorm) return -Infinity;
  if (candNorm === qNorm) return 1000;
  if (candNorm.startsWith(qNorm)) return 800;

  const qTokens = tokenizeNorm(qNorm);
  const cTokens = tokenizeNorm(candNorm);

  let score = 0;
  for (const qt of qTokens) {
    if (!qt) continue;
    let best = 0;
    for (const ct of cTokens) {
      if (ct === qt) best = Math.max(best, 60);
      else if (ct.startsWith(qt)) best = Math.max(best, 40);
      else if (ct.includes(qt)) best = Math.max(best, 10);
    }
    score += best;
  }
  if (candNorm.includes(qNorm)) score += 120;
  return score;
}

/**
 * Build a flat address row list from an addresses GeoJSON FeatureCollection.
 * Default label-picking behavior matches app.js today.
 *
 * Row shape preserved:
 *   { label, norm, roll, lat, lng }
 *
 * @param {object} addrGeo GeoJSON
 * @param {string} joinKey property key for roll/join (treated as string)
 * @param {object} [opts]
 * @param {string[]} [opts.labelFieldsPriority] optional priority list for label fields (non-breaking enhancement)
 * @returns {Array<{label:string,norm:string,roll:string,lat:number,lng:number}>}
 */
export function buildAddressIndex(addrGeo, joinKey, opts = {}) {
  const labelFieldsPriority = Array.isArray(opts.labelFieldsPriority) ? opts.labelFieldsPriority : null;

  const rows = [];
  const feats = addrGeo?.features || [];
  for (const f of feats) {
    const p = f?.properties || {};
    const g = f?.geometry;

    if (!g || g.type !== "Point" || !Array.isArray(g.coordinates)) continue;

    const roll = p?.[joinKey];
    if (roll == null) continue;

    const [lng, lat] = g.coordinates;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    // --- Label selection ---
    // Preserve app.js default behavior exactly when no priority list provided.
    let label = "";
    if (labelFieldsPriority && labelFieldsPriority.length) {
      for (const k of labelFieldsPriority) {
        const v = p?.[k];
        if (v != null && String(v).trim()) {
          label = String(v).trim();
          break;
        }
      }
      // fallback to the old hardcoded set if priority list yields nothing
      if (!label) {
        label =
          p.full_addr ??
          p.FULL_ADDR ??
          p.FULLADDR ??
          p.ADDR_FULL ??
          p.ADDRESS ??
          "";
      }
    } else {
      label =
        p.full_addr ??
        p.FULL_ADDR ??
        p.FULLADDR ??
        p.ADDR_FULL ??
        p.ADDRESS ??
        "";
    }

    const txt = String(label).trim();
    if (!txt) continue;

    rows.push({
      label: txt,
      norm: normalizeAddr(txt),
      roll: String(roll),
      lat,
      lng,
    });
  }

  return rows;
}

/**
 * Get ranked suggestions for a query from an address rows list.
 * Deterministic tie-breaking: score desc → label asc → roll asc → lat asc → lng asc.
 *
 * @param {string} query
 * @param {Array<{label:string,norm:string,roll:string,lat:number,lng:number}>} rows
 * @param {number} [limit=12]
 * @returns {Array<{label:string,norm:string,roll:string,lat:number,lng:number}>}
 */
export function getSuggestions(query, rows, limit = 12) {
  const qNorm = normalizeAddr(query);
  if (!qNorm) return [];

  const list = Array.isArray(rows) ? rows : [];
  const scored = [];

  for (const r of list) {
    const s = scoreAddressCandidate(qNorm, r?.norm);
    if (s > 0) scored.push({ r, s });
  }

  scored.sort((a, b) => {
    // score desc
    if (b.s !== a.s) return b.s - a.s;

    // deterministic tiebreaks
    const al = String(a.r?.label ?? "");
    const bl = String(b.r?.label ?? "");
    const lc = al.localeCompare(bl);
    if (lc) return lc;

    const ar = String(a.r?.roll ?? "");
    const br = String(b.r?.roll ?? "");
    const rc = ar.localeCompare(br);
    if (rc) return rc;

    const alat = Number(a.r?.lat ?? 0);
    const blat = Number(b.r?.lat ?? 0);
    if (alat !== blat) return alat - blat;

    const alng = Number(a.r?.lng ?? 0);
    const blng = Number(b.r?.lng ?? 0);
    if (alng !== blng) return alng - blng;

    // last-resort stable string compare on norm (should be extremely rare)
    const an = String(a.r?.norm ?? "");
    const bn = String(b.r?.norm ?? "");
    return an.localeCompare(bn);
  });

  const out = [];
  const n = Math.max(0, Number(limit) || 0);
  for (let i = 0; i < scored.length && out.length < n; i++) out.push(scored[i].r);
  return out;
}
