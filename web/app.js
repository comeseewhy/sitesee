/* SiteSee v1 — Leaflet + layer registry + geocode + shareable URL */

const statusEl = document.getElementById("status");
const searchInput = document.getElementById("searchInput");
const basemapSelect = document.getElementById("basemapSelect");
const yearSelect = document.getElementById("yearSelect");
const productSelect = document.getElementById("productSelect");

let layerRegistry = null;
let activeDataLayer = null;
let searchMarker = null;

// ---- Map + basemaps ----
const map = L.map("map").setView([42.85, -80.3], 10); // Norfolk-ish default

const streets = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
});

const satellite = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 19, attribution: "Tiles &copy; Esri" }
);

let activeBasemap = streets.addTo(map);

basemapSelect.addEventListener("change", () => {
  map.removeLayer(activeBasemap);
  activeBasemap = basemapSelect.value === "satellite" ? satellite : streets;
  activeBasemap.addTo(map);
  updateUrlState();
});

// ---- Load layer registry ----
async function loadRegistry() {
  const res = await fetch("./layers.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load layers.json: ${res.status}`);
  layerRegistry = await res.json();
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

// ---- Geocode (Nominatim) ----
async function geocode(query) {
  // Add a small location bias for Ontario/Canada
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "json");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "1");
  url.searchParams.set("countrycodes", "ca");
  url.searchParams.set("addressdetails", "1");

  // Nominatim prefers identifying User-Agent via headers, but browsers restrict this.
  // For a public project later, consider switching to a provider designed for client-side use.
  const res = await fetch(url.toString(), { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`Geocode failed: ${res.status}`);

  const data = await res.json();
  if (!data.length) return null;

  const item = data[0];
  return {
    lat: parseFloat(item.lat),
    lon: parseFloat(item.lon),
    displayName: item.display_name,
    bbox: item.boundingbox ? item.boundingbox.map(parseFloat) : null // [south, north, west, east]
  };
}

async function handleSearch() {
  const q = searchInput.value.trim();
  if (!q) return;

  setStatus(`Searching: ${q}`);
  try {
    const result = await geocode(q);
    if (!result) {
      setStatus("No results found.");
      return;
    }

    // Marker + zoom
    if (searchMarker) map.removeLayer(searchMarker);
    searchMarker = L.marker([result.lat, result.lon]).addTo(map);

    if (result.bbox && result.bbox.length === 4) {
      const [south, north, west, east] = result.bbox;
      map.fitBounds([[south, west], [north, east]]);
    } else {
      map.setView([result.lat, result.lon], 15);
    }

    setStatus(`Found: ${result.displayName}`);
    updateUrlState({ q, lat: result.lat, lon: result.lon });

  } catch (err) {
    console.error(err);
    setStatus(`Search error: ${err.message}`);
  }
}

document.getElementById("searchBtn").addEventListener("click", handleSearch);
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleSearch();
});

// ---- Layer loading ----
function pickLayer({ product, year }) {
  if (!layerRegistry?.layers?.length) return null;

  const tagsNeeded = [product];
  if (year) tagsNeeded.push(year);

  // match if all tags are present
  const matches = layerRegistry.layers.filter(l =>
    tagsNeeded.every(t => (l.tags || []).includes(t))
  );

  // fallback: product-only match
  if (!matches.length) {
    return layerRegistry.layers.find(l => (l.tags || []).includes(product)) || null;
  }

  return matches[0];
}

async function loadGeoJsonLayer(layerDef) {
  const res = await fetch(layerDef.url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${layerDef.id}: ${res.status}`);
  const gj = await res.json();

  // simple styling hooks
  if (layerDef.style?.radius) {
    return L.geoJSON(gj, {
      pointToLayer: (_, latlng) => L.circleMarker(latlng, { radius: layerDef.style.radius })
    });
  }

  return L.geoJSON(gj, { style: layerDef.style || {} });
}

async function applyLayerSelection() {
  const product = productSelect.value; // e.g., "boundary" or "sample"
  const year = yearSelect.value;       // e.g., "2020"

  const layerDef = pickLayer({ product, year });

  if (!layerDef) {
    setStatus(`No layer found for product="${product}" year="${year || "any"}"`);
    return;
  }

  setStatus(`Loading layer: ${layerDef.name}`);
  try {
    if (activeDataLayer) map.removeLayer(activeDataLayer);

    if (layerDef.type === "geojson") {
      activeDataLayer = await loadGeoJsonLayer(layerDef);
      activeDataLayer.addTo(map);

      // zoom to layer bounds if no search has happened
      try {
        const b = activeDataLayer.getBounds();
        if (b.isValid()) map.fitBounds(b);
      } catch (_) {}

      setStatus(`Loaded: ${layerDef.name}`);
      updateUrlState();
      return;
    }

    setStatus(`Unsupported layer type: ${layerDef.type} (v1 supports geojson)`);
  } catch (err) {
    console.error(err);
    setStatus(`Layer error: ${err.message}`);
  }
}

document.getElementById("applyLayerBtn").addEventListener("click", applyLayerSelection);

// ---- URL state (shareable links) ----
function updateUrlState(partial = {}) {
  const center = map.getCenter();
  const z = map.getZoom();

  const params = new URLSearchParams(window.location.search);

  // map state
  params.set("z", String(z));
  params.set("lat", String(partial.lat ?? center.lat));
  params.set("lon", String(partial.lon ?? center.lng));

  // search query (optional)
  if (partial.q) params.set("q", partial.q);

  // ui state
  params.set("basemap", basemapSelect.value);
  params.set("year", yearSelect.value || "");
  params.set("product", productSelect.value || "");

  const newUrl = `${window.location.pathname}?${params.toString()}`;
  window.history.replaceState({}, "", newUrl);
}

function restoreFromUrl() {
  const params = new URLSearchParams(window.location.search);

  const basemap = params.get("basemap");
  const year = params.get("year");
  const product = params.get("product");
  const lat = parseFloat(params.get("lat"));
  const lon = parseFloat(params.get("lon"));
  const z = parseInt(params.get("z"), 10);
  const q = params.get("q");

  if (basemap) basemapSelect.value = basemap;
  if (year !== null) yearSelect.value = year;
  if (product) productSelect.value = product;

  // set basemap
  map.removeLayer(activeBasemap);
  activeBasemap = basemapSelect.value === "satellite" ? satellite : streets;
  activeBasemap.addTo(map);

  // restore map position
  if (Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(z)) {
    map.setView([lat, lon], z);
  }

  if (q) searchInput.value = q;
}

// Copy link
document.getElementById("copyLinkBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(window.location.href);
    setStatus("Link copied.");
  } catch {
    setStatus("Couldn’t copy link (clipboard blocked).");
  }
});

// ---- Boot ----
(async function main() {
  try {
    restoreFromUrl();
    await loadRegistry();
    setStatus("Ready.");

    // If URL encodes a product/year, auto-load it
    const params = new URLSearchParams(window.location.search);
    const product = params.get("product");
    if (product) await applyLayerSelection();

  } catch (err) {
    console.error(err);
    setStatus(`Startup error: ${err.message}`);
  }
})();
