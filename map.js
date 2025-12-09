// ================== Basic config ==================
const API_BASE = "http://127.0.0.1:5001";
const MAPBOX_TOKEN =
  "pk.eyJ1Ijoic2FmZXBhdGg1NDAwIiwiYSI6ImNtaW9nc2k4ZjAxcjEzZG9rMGF3NnpvM3AifQ.pEtyF6khME7aLphKtQIIbw";
const REPORT_RADIUS_METERS = 200; // Consistent with the back end

mapboxgl.accessToken = MAPBOX_TOKEN;

let map;
let lastRoutes = [];       // routes array from backend
let currentRouteIdx = 0;   // 0 / 1 / 2

// ================== Init map ==================
function initMap() {
  map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/dark-v11",
    center: [-73.9857, 40.7484],
    zoom: 12,
    preserveDrawingBuffer: true
  });

  map.addControl(new mapboxgl.NavigationControl());

  // 👉 Click on the map to place/move an "incident Selection Point" marker + follow the circle
  map.on("click", (e) => {
    const lngLat = e.lngLat;

    if (!window.reportMarker) {
      window.reportMarker = new mapboxgl.Marker({ color: "#ffcc00" }) 
        .setLngLat(lngLat)
        .setPopup(new mapboxgl.Popup().setText("Incident location"))
        .addTo(map);
    } else {
      window.reportMarker.setLngLat(lngLat);
    }

    // The circle follows the pin in real time
    if (typeof drawNearbyCircle === "function") {
      drawNearbyCircle([lngLat.lng, lngLat.lat]);
    }
  });
}

// ================== Draw a circle with a nearby search radius==================
function drawNearbyCircle(centerLngLat) {
  
  if (typeof turf === "undefined") return;

  const sourceId       = "reports-radius-src";
  const fillLayerId    = "reports-radius-fill";
  const outlineLayerId = "reports-radius-outline";

 // Clean up the old circle
  if (map.getLayer(fillLayerId)) map.removeLayer(fillLayerId);
  if (map.getLayer(outlineLayerId)) map.removeLayer(outlineLayerId);
  if (map.getSource(sourceId)) map.removeSource(sourceId);

  // Generate an approximate circular polygon using turf.circle
  const circle = turf.circle(centerLngLat, REPORT_RADIUS_METERS / 1000, {
    steps: 64,
    units: "kilometers",
  });

  map.addSource(sourceId, {
    type: "geojson",
    data: circle,
  });

  // Semi-transparent filling
  map.addLayer({
    id: fillLayerId,
    type: "fill",
    source: sourceId,
    paint: {
      "fill-color": "#f1c40f",
      "fill-opacity": 0.10,
    },
  });

  // Outer circle outline
  map.addLayer({
    id: outlineLayerId,
    type: "line",
    source: sourceId,
    paint: {
      "line-color": "#f1c40f",
      "line-width": 2,
    },
  });
}

// ================== Call backend (multi routes) ==================
async function fetchMultiRoutes(startId, endId) {
  const statusEl = document.getElementById("status");
  if (statusEl) statusEl.textContent = "Status: requesting multiple paths…";

  const url = `${API_BASE}/routes_multi?start=${encodeURIComponent(
    startId
  )}&end=${encodeURIComponent(endId)}&k=3`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      if (statusEl) statusEl.textContent = `Status: HTTP error ${res.status}`;
      return null;
    }

    const data = await res.json();
    console.log("routes_multi response =>", data);

    if (data.error) {
      if (statusEl) statusEl.textContent = `Status: error: ${data.error}`;
      return null;
    }
    return data;
  } catch (err) {
    console.error(err);
    if (statusEl) statusEl.textContent = `Status: fetch error: ${err.message}`;
    return null;
  }
}

// ================== Render routes on the map ==================
function renderMultiRoutes(routesData) {
  const statusEl       = document.getElementById("status");
  const metricNode     = document.getElementById("metric-node");
  const metricEdge     = document.getElementById("metric-edge");
  const metricRisk     = document.getElementById("metric-risk");
  const metricStart    = document.getElementById("metric-start");
  const metricEnd      = document.getElementById("metric-end");
  const metricDistance = document.getElementById("metric-distance");

  const routes = routesData.routes || [];
  lastRoutes = routes;

  if (!routes.length) {
    if (statusEl) statusEl.textContent = "Status: no paths received.";
    if (metricNode) metricNode.textContent = "-";
    if (metricEdge) metricEdge.textContent = "-";
    if (metricRisk) metricRisk.textContent = "-";
    if (metricStart) metricStart.textContent = "-";
    if (metricEnd) metricEnd.textContent = "-";
    if (metricDistance) metricDistance.textContent = "-";
    return;
  }

  // remove old lines
  for (let i = 0; i < 3; i++) {
    const srcId = `route-src-${i}`;
    const layerId = `route-${i}`;
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(srcId)) map.removeSource(srcId);
  }

  let allCoords = [];

  // draw up to 3 routes
  routes.slice(0, 3).forEach((r, idx) => {
    const srcId = `route-src-${idx}`;
    const layerId = `route-${idx}`;
    const geo = r.geojson || r;

    if (!geo || geo.type !== "FeatureCollection") {
      console.warn("route geojson format error", r);
      return;
    }

    // collect coords for fitBounds
    geo.features.forEach((f) => {
      const g = f.geometry;
      if (!g) return;
      if (g.type === "LineString") {
        allCoords = allCoords.concat(g.coordinates);
      } else if (g.type === "MultiLineString") {
        g.coordinates.forEach((line) => {
          allCoords = allCoords.concat(line);
        });
      }
    });

    map.addSource(srcId, {
      type: "geojson",
      data: geo
    });

    const isMain = idx === 0;

    map.addLayer({
      id: layerId,
      type: "line",
      source: srcId,
      layout: {
        "line-join": "round",
        "line-cap": "round"
      },
      paint: {
        "line-color": "#009A44",
        "line-width": isMain ? 6 : 3,
        "line-opacity": isMain ? 0.9 : 0.3
      }
    });

    // risk label next to path name
    const riskSpan = document.getElementById(`path-risk-${idx}`);
    if (riskSpan) {
      const raw =
        r.total_risk ??
        (geo.properties && geo.properties.total_risk);
      const val = Number(raw);
      riskSpan.textContent = Number.isFinite(val)
        ? ` (${(val * 100).toFixed(2)}%)`
        : " (-)";
    }
  });

  // fit bounds
  if (allCoords.length >= 2) {
    const bounds = allCoords.reduce(
      (b, coord) => b.extend(coord),
      new mapboxgl.LngLatBounds(allCoords[0], allCoords[0])
    );
    map.fitBounds(bounds, { padding: 40 });
  }

  if (statusEl) statusEl.textContent = "Status: paths loaded.";

  // default select Path 1
  const firstRadio = document.querySelector('input.route-radio[value="0"]');
  if (firstRadio) firstRadio.checked = true;
  currentRouteIdx = 0;

  // 1) set markers once using the first route (fixed to start/end node)
  setMarkersFromFirstRoute(routes);

  // 2) update metrics for Path 1
  updateMetricsForRoute(0);
}

// ---- helper: set markers once from the first route ----
function setMarkersFromFirstRoute(routes) {
  if (!routes || !routes.length) return;

  const r0  = routes[0];
  const geo = r0.geojson || r0;
  if (!geo || !geo.features || !geo.features.length) return;

  const endpointMap = new Map();

  function keyForCoord(coord) {
    return `${coord[0].toFixed(6)},${coord[1].toFixed(6)}`;
  }

  function addEndpoint(coord) {
    const key = keyForCoord(coord);
    const existing = endpointMap.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      endpointMap.set(key, { coord, count: 1 });
    }
  }

  geo.features.forEach((f) => {
    const g = f.geometry;
    if (!g) return;
    if (g.type === "LineString" && g.coordinates.length) {
      const coords = g.coordinates;
      addEndpoint(coords[0]);
      addEndpoint(coords[coords.length - 1]);
    } else if (g.type === "MultiLineString") {
      g.coordinates.forEach((line) => {
        if (line.length) {
          addEndpoint(line[0]);
          addEndpoint(line[line.length - 1]);
        }
      });
    }
  });

  const endpoints = [];
  endpointMap.forEach((v) => {
    if (v.count === 1) endpoints.push(v.coord);
  });

  if (endpoints.length < 2) {
    console.warn("Could not determine unique endpoints for route 0.");
    return;
  }

  const startCoord = endpoints[0];
  const endCoord   = endpoints[1];

  updateStartEndMarkers(startCoord, endCoord);
}

// ---- helper: update only metrics (no markers here!) ----
function updateMetricsForRoute(idx) {
  const metricNode     = document.getElementById("metric-node");
  const metricEdge     = document.getElementById("metric-edge");
  const metricRisk     = document.getElementById("metric-risk");
  const metricStart    = document.getElementById("metric-start");
  const metricEnd      = document.getElementById("metric-end");
  const metricDistance = document.getElementById("metric-distance");

  const r = lastRoutes[idx];
  if (!r) {
    if (metricNode) metricNode.textContent = "-";
    if (metricEdge) metricEdge.textContent = "-";
    if (metricRisk) metricRisk.textContent = "-";
    if (metricStart) metricStart.textContent = "-";
    if (metricEnd) metricEnd.textContent = "-";
    if (metricDistance) metricDistance.textContent = "-";
    return;
  }

  const geo   = r.geojson || r;
  const props = geo.properties || {};

  const startNode = r.start_node ?? props.start ?? "";
  const endNode   = r.end_node   ?? props.end   ?? "";

  if (metricStart) metricStart.textContent = startNode || "-";
  if (metricEnd)   metricEnd.textContent   = endNode   || "-";

  if (metricNode) {
    metricNode.textContent =
      r.node_count ?? props.node_count ?? "-";
  }
  if (metricEdge) {
    metricEdge.textContent =
      r.edge_count ?? props.edge_count ?? "-";
  }

  const riskVal = Number(
    r.total_risk ?? props.total_risk
  );
  if (metricRisk) {
    metricRisk.textContent = Number.isFinite(riskVal)
      ? (riskVal * 100).toFixed(2) + "%"
      : "-";
  }

  let totalKm = 0;
  if (
    geo &&
    geo.features &&
    geo.features.length &&
    typeof turf !== "undefined"
  ) {
    geo.features.forEach((f) => {
      try {
        const len = turf.length(f, { units: "kilometers" });
        if (Number.isFinite(len)) totalKm += len;
      } catch (e) {
        console.warn("turf length error", e);
      }
    });
  }
  if (metricDistance) {
    metricDistance.textContent = Number.isFinite(totalKm)
      ? totalKm.toFixed(2) + " km"
      : "-";
  }
}

// ================== Highlight selected route ==================
function highlightRoute(selectedIdx) {
  currentRouteIdx = selectedIdx;

  for (let i = 0; i < 3; i++) {
    const layerId = `route-${i}`;
    if (!map.getLayer(layerId)) continue;

    if (i === selectedIdx) {
      map.setPaintProperty(layerId, "line-width", 6);
      map.setPaintProperty(layerId, "line-opacity", 0.9);
    } else {
      map.setPaintProperty(layerId, "line-width", 3);
      map.setPaintProperty(layerId, "line-opacity", 0.3);
    }
  }

  updateMetricsForRoute(selectedIdx);
}

// ================== Download current route as GeoJSON ==================
function downloadCurrentRouteGeoJSON() {
  if (!lastRoutes || !lastRoutes.length) {
    alert("No route to export. Please get a path first.");
    return;
  }

  const route = lastRoutes[currentRouteIdx];
  if (!route) {
    alert("No selected route to export.");
    return;
  }

  const geo = route.geojson || route;
  if (!geo || geo.type !== "FeatureCollection") {
    alert("Current route GeoJSON has invalid format.");
    return;
  }

  const jsonStr = JSON.stringify(geo, null, 2);
  const blob = new Blob([jsonStr], { type: "application/geo+json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `safepath_route_${currentRouteIdx + 1}.geojson`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ================== Download map screenshot ==================
function downloadMapScreenshot() {
  if (!map) {
    alert("Map is not ready yet.");
    return;
  }

  try {
    const dataURL = map.getCanvas().toDataURL("image/png");
    const a = document.createElement("a");
    a.href = dataURL;
    a.download = `safepath_map_${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (err) {
    console.error(err);
    alert("Failed to export map screenshot. Check console for details.");
  }
}

// ================== Draw reports with yellow dots and Popup ==================
function renderReportsOnMap(data) {
  if (!map) return;

  const features = (data || [])
    .filter(
      (r) =>
        r.location &&
        typeof r.location.lat === "number" &&
        typeof r.location.lon === "number"
    )
    .map((r) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [r.location.lon, r.location.lat],
      },
      properties: {
        category: r.category || "",
        severity: r.severity != null ? String(r.severity) : "",
        details: r.details || "",
        timestamp: r.timestamp || "",
      },
    }));

  const geojson = {
    type: "FeatureCollection",
    features,
  };

  if (map.getSource("reports")) {
    map.getSource("reports").setData(geojson);
  } else {
    map.addSource("reports", {
      type: "geojson",
      data: geojson,
    });

    const toggleEl = document.getElementById("toggle-reports");
    const visible =
      !toggleEl || toggleEl.checked ? "visible" : "none";

    // Yellow dot layer
    map.addLayer({
      id: "reports-layer",
      type: "circle",
      source: "reports",
      layout: {
        visibility: visible,
      },
      paint: {
        "circle-radius": 6,
        "circle-color": "#ffcc00",
        "circle-stroke-color": "#000000",
        "circle-stroke-width": 1.5,
      },
    });

    // click popup
    map.on("click", "reports-layer", (e) => {
      if (!e.features || !e.features.length) return;
      const props = e.features[0].properties || {};

      const title = props.category || props.type || "Incident";
      const severity = props.severity || "N/A";
      const details = props.details || "";
      const ts = props.timestamp
        ? new Date(props.timestamp).toLocaleString()
        : "";

      const html = `
        <div style="font-size: 12px; line-height: 1.4;">
          <strong>${title}</strong><br/>
          Severity: ${severity}<br/>
          ${details ? `Details: ${details}<br/>` : ""}
          ${ts ? `Time: ${ts}` : ""}
        </div>
      `;

      new mapboxgl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(html)
        .addTo(map);
    });

    map.on("mouseenter", "reports-layer", () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", "reports-layer", () => {
      map.getCanvas().style.cursor = "";
    });
  }

  const statusEl = document.getElementById("status");
  if (statusEl)
    statusEl.textContent = `Status: reports loaded (${features.length})`;

  const metricReports = document.getElementById("metric-reports");
  if (metricReports) metricReports.textContent = String(features.length);
}

// ================== Load Nearby Reports==================
async function loadNearbyReports() {
  const statusEl = document.getElementById("status");

  // Once "Load Nearby Reports" is clicked, "Show reported incidents" is automatically unchecked.
  const showAllCheckbox = document.getElementById("toggle-reports");
  if (showAllCheckbox) {
    showAllCheckbox.checked = false;
  }

  if (!map) {
    alert("Map is not ready yet.");
    return;
  }
  if (!window.reportMarker) {
    alert("Please click on the map to choose a location first.");
    return;
  }

  const center = window.reportMarker.getLngLat();
  const lat = center.lat;
  const lon = center.lng;
  const radius_km = REPORT_RADIUS_METERS / 1000;

  if (statusEl) statusEl.textContent = "Status: loading nearby reports...";

  try {
    const res = await fetch(
      `${API_BASE}/reports/nearby?lat=${lat}&lon=${lon}&km=${radius_km}`
    );
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const reports = await res.json();

    renderReportsOnMap(reports);              // Only display the nearby 
    drawNearbyCircle([lon, lat]);            // Circles surround pin

    const count = Array.isArray(reports) ? reports.length : 0;
    if (statusEl) {
      statusEl.textContent = `Status: reports loaded (${count})`;
    }

    const metricReports = document.getElementById("metric-reports");
    if (metricReports) {
      metricReports.textContent = String(count);
    }
  } catch (err) {
    console.error(err);
    if (statusEl) statusEl.textContent = "Status: failed to load reports.";
    alert("Failed to load nearby reports. See console for details.");
  }
}

// ================== Load ALL reports (no distance filter) ==================
async function loadAllReports() {
  const statusEl = document.getElementById("status");
  if (statusEl) statusEl.textContent = "Status: loading all reports...";

  try {
    const res = await fetch(`${API_BASE}/reports/all`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();

    renderReportsOnMap(data);

    if (statusEl)
      statusEl.textContent = `Status: all reports loaded (${data.length})`;

    const metricReports = document.getElementById("metric-reports");
    if (metricReports) {
      metricReports.textContent = data.length.toString();
    }
  } catch (err) {
    console.error(err);
    if (statusEl) statusEl.textContent = "Status: failed to load all reports.";
    alert("Failed to load all reports. See console for details.");
  }
}

// ================== Wire up UI ==================
function setupUI() {
  // 1) Get Safest Path
  const btn = document.getElementById("route-btn");
  if (btn) {
    btn.addEventListener("click", async () => {
      const startId = document.getElementById("start-input").value.trim();
      const endId = document.getElementById("end-input").value.trim();
      const statusEl = document.getElementById("status");

      if (!startId || !endId) {
        alert("Please fill in both start and end node id.");
        return;
      }

      const data = await fetchMultiRoutes(startId, endId);
      if (data) {
        renderMultiRoutes(data);
      } else if (statusEl) {
        statusEl.textContent = "Status: failed to load paths.";
      }
    });
  }

  // 2) Report Incident Here (open modal + submit form)
  const reportBtn    = document.getElementById("report-btn");
  const reportModal  = document.getElementById("report-modal");
  const reportCancel = document.getElementById("report-cancel");
  const reportSubmit = document.getElementById("report-submit");

  if (reportBtn && reportModal) {
    reportBtn.addEventListener("click", () => {
      if (!map) {
        alert("Map is not ready yet.");
        return;
      }
      if (!window.reportMarker) {
        alert("Please click on the map to choose a location before reporting.");
        return;
      }
      reportModal.classList.remove("hidden");
    });
  }

  if (reportCancel && reportModal) {
    reportCancel.addEventListener("click", () => {
      reportModal.classList.add("hidden");
    });
  }

  if (reportSubmit && reportModal) {
    reportSubmit.addEventListener("click", async () => {
      if (!window.reportMarker) {
        alert("Please click on the map to choose a location before reporting.");
        return;
      }

      const statusEl = document.getElementById("status");

      const severityInput = document.querySelector(
        'input[name="incident-severity"]:checked'
      );
      const categorySelect = document.getElementById("incident-category");
      const otherInput = document.getElementById("incident-category-other");
      const detailsInput = document.getElementById("incident-details");

      const severity = severityInput ? Number(severityInput.value) : null;

      let category = categorySelect ? categorySelect.value : "";
      if (category === "other") {
        category = (otherInput.value || "").trim();
      }

      const details = detailsInput ? detailsInput.value.trim() : "";

      if (!category && !details) {
        alert("Please choose a category or write some details.");
        return;
      }

      const ll = window.reportMarker.getLngLat();
      const body = {
        location: {
          lat: ll.lat,
          lon: ll.lng,
        },
        severity,
        category,
        details,
        timestamp: new Date().toISOString(),
      };

      try {
        const res = await fetch(`${API_BASE}/reports/new`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        if (statusEl) statusEl.textContent = "Status: incident reported.";
        reportModal.classList.add("hidden");

        if (severityInput) severityInput.checked = false;
        if (categorySelect) categorySelect.value = "";
        if (otherInput) otherInput.value = "";
        if (detailsInput) detailsInput.value = "";

        // Automatically refresh nearby upon report completion
        await loadNearbyReports();
      } catch (err) {
        console.error(err);
        if (statusEl)
          statusEl.textContent = "Status: failed to report incident.";
        alert("Failed to report incident. See console for details.");
      }
    });
  }

  // 3) loadNearbyReports (The button only calls the uniform Load NearbyReports)
  const loadBtn = document.getElementById("load-reports-btn");
  if (loadBtn) {
    loadBtn.addEventListener("click", async () => {
      await loadNearbyReports();
    });
  }

  // 4) Download current route as GeoJSON
  const downloadBtn = document.getElementById("download-geojson-btn");
  if (downloadBtn) {
    downloadBtn.addEventListener("click", () => {
      downloadCurrentRouteGeoJSON();
    });
  }

  // 5) Download map screenshot
  const screenshotBtn = document.getElementById("screenshot-btn");
  if (screenshotBtn) {
    screenshotBtn.addEventListener("click", () => {
      downloadMapScreenshot();
    });
  }

  // 6) Radio buttons for Path 1/2/3
  const radios = document.querySelectorAll('input[name="route-choice"]');
  radios.forEach((radio) => {
    radio.addEventListener("change", (e) => {
      const idx = parseInt(e.target.value, 10);
      if (!Number.isNaN(idx)) {
        highlightRoute(idx);
      }
    });
  });

  // 7) Toggle incident layer visibility 
  const toggleReportsCheckbox = document.getElementById("toggle-reports");
  if (toggleReportsCheckbox) {
    toggleReportsCheckbox.addEventListener("change", async (e) => {
      const visible = e.target.checked;
      const vis = visible ? "visible" : "none";

      if (visible) {
        //When checked, pull the reports of the entire database from the background once
        await loadAllReports();
      }

      if (map.getLayer("reports-layer")) {
        map.setLayoutProperty("reports-layer", "visibility", vis);
      }
      // The circle remains the same and does not follow the show all switch
    });
  }
}

// ================== Start / end markers ==================
function updateStartEndMarkers(startCoord, endCoord) {
  if (!map) return;

  if (window.startMarker) window.startMarker.remove();
  if (window.endMarker) window.endMarker.remove();

  window.startMarker = new mapboxgl.Marker({ color: "#009a44" })
    .setLngLat(startCoord)
    .setPopup(new mapboxgl.Popup().setText("Start Point"))
    .addTo(map);

  window.endMarker = new mapboxgl.Marker({ color: "#d9534f" })
    .setLngLat(endCoord)
    .setPopup(new mapboxgl.Popup().setText("End Point"))
    .addTo(map);
}

// ================== On page load ==================
window.addEventListener("load", () => {
  initMap();
  setupUI();
});