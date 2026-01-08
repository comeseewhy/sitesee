/* SnowBridge — core/state.js
   Shared app state (no side effects)
   - Exports createState() which returns the full state shape used by app.js today.
   - No DOM, no Leaflet. GitHub Pages safe (native ES module).
*/

"use strict";

/**
 * Create a fresh SnowBridge state object.
 * IMPORTANT: Keep keys/shape stable to avoid silent regressions.
 * @returns {object}
 */
export function createState() {
  return {
    // config + map
    cfg: null,
    map: null,

    // basemaps
    basemap: null,
    satellite: null,

    // layers
    parcelsLayer: null,
    snowLayer: null,

    // indexes (join-key logic sacred: always treat roll as string at call sites)
    parcelByRoll: new Map(),
    snowByRoll: new Map(),

    // address rows (built from address geojson)
    addresses: [],

    // selection / stage
    selectedRoll: null,
    isQueryStage: false,

    // blinking
    blinkTimer: null,
    blinkOn: false,

    // overlays
    maskLayer: null,
    snowOutlineLayer: null,
    sizeOutlineLayer: null,
    sizeLabelMarker: null,

    // ui
    suggestBox: null,
    suggestIndex: -1,
    ctxMenu: null,
    panel: null,

    // drawing
    canvas: null,
    drawEnabled: false,
    hasUnsavedDrawing: false,
    _drawHandlers: null,

    // toggles in panel
    satOn: false,
    sizeOn: false,
  };
}
