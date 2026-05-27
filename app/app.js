/* global Plotly */

const state = {
  flights: [],
  filteredFlights: [],
  selectedFlight: null,
  selectedOverview: null,
  selectedAltimeterId: "",
  altimeterCache: new Map(),
  activeTab: "plot",
  activeSeries: [],
  draftSeriesSelection: [],
  seriesModalSearch: "",
  trimEnabled: true,
  attributeRows: [],
};

const elements = {
  listSummary: document.getElementById("list-summary"),
  flightList: document.getElementById("flight-list"),
  welcome: document.getElementById("welcome"),
  details: document.getElementById("details"),
  flightTitle: document.getElementById("flight-title"),
  flightSubtitle: document.getElementById("flight-subtitle"),
  refreshBtn: document.getElementById("refresh-btn"),
  runIndexBtn: document.getElementById("run-index-btn"),
  indexStatus: document.getElementById("index-status"),
  searchInput: document.getElementById("filter-search"),
  altimeterSelect: document.getElementById("altimeter-select"),
  trimToggle: document.getElementById("trim-toggle"),
  plot2d: document.getElementById("plot2d"),
  plotSelectSeriesBtn: document.getElementById("plot-select-series-btn"),
  plotResetSeriesBtn: document.getElementById("plot-reset-series-btn"),
  plotFitTrimBtn: document.getElementById("plot-fit-trim-btn"),
  plotFitFullBtn: document.getElementById("plot-fit-full-btn"),
  plotResetViewBtn: document.getElementById("plot-reset-view-btn"),
  plotPanLeftBtn: document.getElementById("plot-pan-left-btn"),
  plotPanRightBtn: document.getElementById("plot-pan-right-btn"),
  plotZoomInBtn: document.getElementById("plot-zoom-in-btn"),
  plotZoomOutBtn: document.getElementById("plot-zoom-out-btn"),
  plotSeriesActive: document.getElementById("plot-series-active"),
  plotHoverDashboard: document.getElementById("plot-hover-dashboard"),
  plotSeriesModal: document.getElementById("plot-series-modal"),
  plotSeriesOptions: document.getElementById("plot-series-options"),
  plotSeriesSearch: document.getElementById("plot-series-search"),
  plotSeriesApplyBtn: document.getElementById("plot-series-apply-btn"),
  plotSeriesCancelBtn: document.getElementById("plot-series-cancel-btn"),
  attributesBody: document.getElementById("attributes-body"),
  addAttributeBtn: document.getElementById("add-attribute-btn"),
  saveAttributesBtn: document.getElementById("save-attributes-btn"),
  attributesStatus: document.getElementById("attributes-status"),
};

function fmtNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });
}

function text(node, value) {
  node.textContent = value;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setVisibleDetails(isVisible) {
  elements.welcome.classList.toggle("hidden", isVisible);
  elements.details.classList.toggle("hidden", !isVisible);
}

function flightMatchesSearch(flight) {
  const search = String(elements.searchInput.value || "").trim().toLowerCase();
  if (!search) return true;
  return [flight.date, flight.rocketName, flight.directory].join(" ").toLowerCase().includes(search);
}

function updateListSummary() {
  elements.listSummary.textContent = `${state.filteredFlights.length} of ${state.flights.length} flights`;
}

function renderFlightList() {
  elements.flightList.innerHTML = "";
  updateListSummary();
  state.filteredFlights.forEach((flight) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `flight-item ${state.selectedFlight?.directory === flight.directory ? "active" : ""}`;
    item.innerHTML = `
      <div class="flight-item-title">${escapeHtml(flight.date || "Unknown")} | ${escapeHtml(flight.rocketName || flight.directory)}</div>
      <div class="flight-item-stats">${fmtNumber(flight.stats?.maxAltitude)} alt | ${fmtNumber(flight.stats?.maxSpeed)} speed | ${
      flight.altimeterCount || 0
    } altimeters</div>
    `;
    item.addEventListener("click", () => selectFlight(flight.directory));
    elements.flightList.appendChild(item);
  });
}

function applyFiltersAndRender() {
  state.filteredFlights = state.flights.filter(flightMatchesSearch);
  renderFlightList();
}

function showTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll(".tab").forEach((el) => el.classList.toggle("active", el.dataset.tab === tabName));
  document.querySelectorAll(".tab-pane").forEach((el) => el.classList.toggle("active", el.id === `tab-${tabName}`));
}

function currentAltimeterFromOverview() {
  if (!state.selectedOverview || !state.selectedAltimeterId) return null;
  return (state.selectedOverview.altimeters || []).find((altimeter) => altimeter.id === state.selectedAltimeterId) || null;
}

function currentAltimeterCachePayload() {
  if (!state.selectedOverview || !state.selectedAltimeterId) return null;
  return state.altimeterCache.get(`${state.selectedOverview.directory}/${state.selectedAltimeterId}`) || null;
}

function populateAltimeterSelect(overview) {
  elements.altimeterSelect.innerHTML = "";
  (overview.altimeters || []).forEach((altimeter) => {
    const option = document.createElement("option");
    option.value = altimeter.id;
    option.textContent = `${altimeter.displayName} (${altimeter.interface?.id || "unknown"})`;
    elements.altimeterSelect.appendChild(option);
  });

  const hasCurrent = (overview.altimeters || []).some((entry) => entry.id === state.selectedAltimeterId);
  if (!hasCurrent) state.selectedAltimeterId = overview.altimeters?.[0]?.id || "";
  if (state.selectedAltimeterId) elements.altimeterSelect.value = state.selectedAltimeterId;
}

function resetHoverDashboard() {
  elements.plotHoverDashboard.innerHTML = "<div class='muted'>Hover over the chart to inspect values.</div>";
}

function withinTrim(timeValue, trimRange) {
  if (!trimRange || timeValue === null || timeValue === undefined) return true;
  return timeValue >= trimRange.startSeconds && timeValue <= trimRange.endSeconds;
}

function computeTrimRange(payload) {
  if (!state.trimEnabled) return null;
  return payload?.altimeter?.trimWindow || null;
}

function colorForEventLabel(label) {
  if (/launch|liftoff|boost/i.test(label)) return "#4ade80";
  if (/apogee/i.test(label)) return "#fbbf24";
  if (/main/i.test(label)) return "#38bdf8";
  if (/drogue/i.test(label)) return "#c084fc";
  if (/landing|touchdown|landed/i.test(label)) return "#fb7185";
  return "#94a3b8";
}

function buildPlotEventMarkers(payload, trimRange) {
  const events = (payload?.altimeter?.events || [])
    .filter((event) => event.timeSeconds !== null && event.timeSeconds !== undefined)
    .sort((a, b) => a.timeSeconds - b.timeSeconds)
    .slice(0, 40);
  const shapes = [];
  const annotations = [];

  for (const event of events) {
    const x = Number(event.timeSeconds);
    if (!withinTrim(x, trimRange)) continue;
    const color = colorForEventLabel(event.label || "");
    shapes.push({
      type: "line",
      x0: x,
      x1: x,
      y0: 0,
      y1: 1,
      yref: "paper",
      line: { color, width: 1, dash: "dot" },
    });
    annotations.push({
      x,
      y: 1,
      yref: "paper",
      text: String(event.label || "Event"),
      showarrow: false,
      yshift: 8,
      textangle: -90,
      xanchor: "right",
      font: { color, size: 10 },
    });
  }

  return { shapes, annotations };
}

function computeFullTimeRange(payload) {
  const range = payload?.parsedFile?.chartData?.timeRange;
  if (!range || range.startSeconds === null || range.endSeconds === null) return null;
  return [Number(range.startSeconds), Number(range.endSeconds)];
}

function computeRangeFromTrimOrFull(payload) {
  const trimRange = computeTrimRange(payload);
  if (trimRange) return [Number(trimRange.startSeconds), Number(trimRange.endSeconds)];
  return computeFullTimeRange(payload);
}

function getCurrentXAxisRange(payload) {
  const fromLayout = elements.plot2d?.layout?.xaxis?.range;
  if (Array.isArray(fromLayout) && fromLayout.length === 2) {
    const left = Number(fromLayout[0]);
    const right = Number(fromLayout[1]);
    if (Number.isFinite(left) && Number.isFinite(right) && right > left) return [left, right];
  }
  return computeRangeFromTrimOrFull(payload);
}

function clampRange(range, bounds) {
  if (!range || !bounds) return range;
  const [minBound, maxBound] = bounds;
  let [left, right] = range;
  const width = right - left;
  if (width <= 0) return bounds;
  if (left < minBound) {
    left = minBound;
    right = minBound + width;
  }
  if (right > maxBound) {
    right = maxBound;
    left = maxBound - width;
  }
  if (left < minBound) left = minBound;
  if (right > maxBound) right = maxBound;
  if (right <= left) return bounds;
  return [left, right];
}

function relayout2dRange(range) {
  if (!range) return;
  Plotly.relayout(elements.plot2d, {
    "xaxis.range": [range[0], range[1]],
    "yaxis.autorange": true,
  });
}

function updateHoverDashboard(hoverPoints) {
  if (!hoverPoints || !hoverPoints.length) {
    resetHoverDashboard();
    return;
  }
  const firstPoint = hoverPoints[0];
  let html = `<div class="hover-item">Time: <span class="hover-val">${fmtNumber(firstPoint.x, 3)} s</span></div>`;
  hoverPoints.forEach((point) => {
    html += `<div class="hover-item">${escapeHtml(point.data.name)}: <span class="hover-val">${fmtNumber(point.y, 3)}</span></div>`;
  });
  elements.plotHoverDashboard.innerHTML = html;
}

function bind2dHoverEvents() {
  elements.plot2d.removeAllListeners?.("plotly_hover");
  elements.plot2d.removeAllListeners?.("plotly_unhover");

  elements.plot2d.on("plotly_hover", (eventData) => {
    updateHoverDashboard(eventData?.points || []);
  });
  elements.plot2d.on("plotly_unhover", () => resetHoverDashboard());
}

function renderSeriesChips() {
  elements.plotSeriesActive.innerHTML = "";
  state.activeSeries.forEach((column) => {
    const chip = document.createElement("div");
    chip.className = "series-chip";
    chip.innerHTML = `${escapeHtml(column)}<button data-remove-series="${escapeHtml(column)}">x</button>`;
    elements.plotSeriesActive.appendChild(chip);
  });

  elements.plotSeriesActive.querySelectorAll("[data-remove-series]").forEach((button) => {
    button.addEventListener("click", () => {
      const column = button.getAttribute("data-remove-series");
      state.activeSeries = state.activeSeries.filter((value) => value !== column);
      renderSeriesChips();
      render2dPlot(currentAltimeterCachePayload());
    });
  });
}

function render2dPlot(payload) {
  const chartData = payload?.parsedFile?.chartData;
  if (!chartData || !chartData.seriesByColumn || !Object.keys(chartData.seriesByColumn).length) {
    Plotly.purge(elements.plot2d);
    elements.plot2d.innerHTML = "<div class='muted' style='padding:12px;'>No numeric time-series data available.</div>";
    return;
  }

  const trimRange = computeTrimRange(payload);
  const activeColumns = state.activeSeries.filter((column) => chartData.seriesByColumn[column]);
  const traces = [];

  for (const column of activeColumns) {
    const series = chartData.seriesByColumn[column];
    if (!series) continue;
    const x = [];
    const y = [];
    for (let index = 0; index < series.timeSeconds.length; index += 1) {
      const timeValue = series.timeSeconds[index];
      if (!withinTrim(timeValue, trimRange)) continue;
      x.push(timeValue);
      y.push(series.values[index]);
    }
    if (!x.length) continue;
    traces.push({
      x,
      y,
      mode: "lines",
      type: "scattergl",
      name: column,
      line: { width: 2 },
    });
  }

  if (!traces.length) {
    Plotly.purge(elements.plot2d);
    elements.plot2d.innerHTML = "<div class='muted' style='padding:12px;'>No points in selected trim range.</div>";
    return;
  }

  const { shapes, annotations } = buildPlotEventMarkers(payload, trimRange);
  const fullRange = computeFullTimeRange(payload);
  const defaultRange = state.trimEnabled ? computeRangeFromTrimOrFull(payload) : fullRange;

  const layout = {
    paper_bgcolor: "#0b1017",
    plot_bgcolor: "#0b1017",
    font: { color: "#d8e1ef" },
    margin: { l: 60, r: 20, t: 48, b: 60 },
    hovermode: "x",
    xaxis: {
      title: "Time (s)",
      gridcolor: "#2a3444",
      showspikes: true,
      spikemode: "across",
      spikesnap: "cursor",
      spikethickness: 1,
      spikedash: "dash",
      spikecolor: "#8da0bb",
      range: defaultRange || undefined,
    },
    yaxis: { title: "Value", gridcolor: "#2a3444" },
    legend: { orientation: "h", y: 1.12 },
    annotations,
    shapes,
    uirevision: `${state.selectedOverview?.directory || ""}/${state.selectedAltimeterId || ""}`,
  };

  Plotly.react(elements.plot2d, traces, layout, {
    responsive: true,
    displaylogo: false,
    scrollZoom: true,
    modeBarButtonsToRemove: ["lasso2d", "select2d"],
  }).then(() => {
    bind2dHoverEvents();
    resetHoverDashboard();
  });
}

function openSeriesModal(payload) {
  const columns = payload?.parsedFile?.chartData?.numericColumns || [];
  state.draftSeriesSelection = state.activeSeries.filter((column) => columns.includes(column));
  state.seriesModalSearch = "";
  elements.plotSeriesSearch.value = "";
  renderSeriesOptions(columns);
  elements.plotSeriesModal.classList.remove("hidden");
  elements.plotSeriesSearch.focus();
}

function closeSeriesModal() {
  elements.plotSeriesModal.classList.add("hidden");
}

function renderSeriesOptions(columns) {
  const search = state.seriesModalSearch.toLowerCase();
  const filtered = columns.filter((column) => column.toLowerCase().includes(search));
  elements.plotSeriesOptions.innerHTML = "";

  filtered.forEach((column) => {
    const row = document.createElement("label");
    row.className = "series-option";
    const checked = state.draftSeriesSelection.includes(column) ? "checked" : "";
    row.innerHTML = `<input type="checkbox" data-series-option="${escapeHtml(column)}" ${checked} /><span>${escapeHtml(column)}</span>`;
    elements.plotSeriesOptions.appendChild(row);
  });

  elements.plotSeriesOptions.querySelectorAll("[data-series-option]").forEach((input) => {
    input.addEventListener("change", () => {
      const column = input.getAttribute("data-series-option");
      if (!column) return;
      if (input.checked) {
        if (!state.draftSeriesSelection.includes(column)) state.draftSeriesSelection.push(column);
      } else {
        state.draftSeriesSelection = state.draftSeriesSelection.filter((value) => value !== column);
      }
    });
  });
}

function loadAttributeRowsFromAltimeter() {
  const altimeter = currentAltimeterFromOverview();
  if (!altimeter) {
    state.attributeRows = [];
    return;
  }
  state.attributeRows = Object.entries(altimeter.attributes || {}).map(([key, value]) => ({
    key,
    value: value === null || value === undefined ? "" : String(value),
    removed: false,
  }));
}

function renderAttributeRows() {
  elements.attributesBody.innerHTML = "";
  state.attributeRows.forEach((row, index) => {
    if (row.removed) return;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input class="table-input" data-attr-key-index="${index}" value="${escapeHtml(row.key)}" /></td>
      <td><input class="table-input" data-attr-value-index="${index}" value="${escapeHtml(row.value)}" /></td>
      <td class="actions-cell"><button class="btn row-remove-btn" data-attr-remove-index="${index}">Remove</button></td>
    `;
    elements.attributesBody.appendChild(tr);
  });

  elements.attributesBody.querySelectorAll("[data-attr-key-index]").forEach((input) => {
    input.addEventListener("input", () => {
      const index = Number(input.getAttribute("data-attr-key-index"));
      if (!Number.isFinite(index)) return;
      state.attributeRows[index].key = String(input.value || "");
    });
  });

  elements.attributesBody.querySelectorAll("[data-attr-value-index]").forEach((input) => {
    input.addEventListener("input", () => {
      const index = Number(input.getAttribute("data-attr-value-index"));
      if (!Number.isFinite(index)) return;
      state.attributeRows[index].value = String(input.value || "");
    });
  });

  elements.attributesBody.querySelectorAll("[data-attr-remove-index]").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.getAttribute("data-attr-remove-index"));
      if (!Number.isFinite(index)) return;
      state.attributeRows[index].removed = true;
      renderAttributeRows();
    });
  });
}

function cleanAttributeKey(rawKey) {
  return String(rawKey || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\w.\-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function saveAttributes() {
  const overview = state.selectedOverview;
  const altimeter = currentAltimeterFromOverview();
  if (!overview || !altimeter) return;

  const baseAttributes = altimeter.baseAttributes || {};
  const nextAttributes = {};
  state.attributeRows.forEach((row) => {
    if (row.removed) return;
    const key = cleanAttributeKey(row.key);
    if (!key) return;
    nextAttributes[key] = String(row.value || "").trim();
  });

  const attributeOverrides = {};
  const hiddenAttributeKeys = [];

  for (const [key, value] of Object.entries(nextAttributes)) {
    const baseValue = Object.prototype.hasOwnProperty.call(baseAttributes, key) ? String(baseAttributes[key] ?? "") : undefined;
    if (baseValue === undefined || baseValue !== String(value ?? "")) attributeOverrides[key] = value;
  }

  for (const key of Object.keys(baseAttributes)) {
    if (!Object.prototype.hasOwnProperty.call(nextAttributes, key)) hiddenAttributeKeys.push(key);
  }

  elements.attributesStatus.textContent = "Saving...";
  const patch = {
    altimeters: {
      [altimeter.id]: {
        attributeOverrides,
        hiddenAttributeKeys,
      },
    },
  };

  const updatedOverview = await window.flightApi.saveOverrides(overview.directory, patch);
  state.selectedOverview = updatedOverview;
  state.altimeterCache.delete(`${overview.directory}/${altimeter.id}`);
  populateAltimeterSelect(updatedOverview);
  await loadAndRenderAltimeter();
  elements.attributesStatus.textContent = "Saved";
}

function zoom2dByFactor(factor) {
  const payload = currentAltimeterCachePayload();
  const full = computeFullTimeRange(payload);
  const range = getCurrentXAxisRange(payload);
  if (!full || !range) return;
  const center = (range[0] + range[1]) / 2;
  const half = ((range[1] - range[0]) * factor) / 2;
  const next = clampRange([center - half, center + half], full);
  relayout2dRange(next);
}

function pan2dByRatio(direction, ratio = 0.24) {
  const payload = currentAltimeterCachePayload();
  const full = computeFullTimeRange(payload);
  const range = getCurrentXAxisRange(payload);
  if (!full || !range) return;
  const width = range[1] - range[0];
  const shift = width * ratio * direction;
  const next = clampRange([range[0] + shift, range[1] + shift], full);
  relayout2dRange(next);
}

function fit2dTrimRange() {
  relayout2dRange(computeRangeFromTrimOrFull(currentAltimeterCachePayload()));
}

function fit2dFullRange() {
  relayout2dRange(computeFullTimeRange(currentAltimeterCachePayload()));
}

function reset2dView() {
  Plotly.relayout(elements.plot2d, { "xaxis.autorange": true, "yaxis.autorange": true });
}

async function loadAndRenderAltimeter() {
  if (!state.selectedOverview || !state.selectedAltimeterId) return;
  const key = `${state.selectedOverview.directory}/${state.selectedAltimeterId}`;
  let payload = state.altimeterCache.get(key);
  if (!payload) {
    payload = await window.flightApi.loadAltimeter(state.selectedOverview.directory, state.selectedAltimeterId);
    state.altimeterCache.set(key, payload);
  }

  const chartData = payload?.parsedFile?.chartData;
  const defaults = chartData?.defaultSeries?.filter((column) => chartData.seriesByColumn[column]) || [];
  if (!state.activeSeries.length || !state.activeSeries.some((column) => chartData?.seriesByColumn?.[column])) {
    state.activeSeries = defaults.length ? defaults.slice(0, 3) : (chartData?.numericColumns || []).slice(0, 3);
  } else {
    state.activeSeries = state.activeSeries.filter((column) => chartData?.seriesByColumn?.[column]);
  }

  renderSeriesChips();
  render2dPlot(payload);
  loadAttributeRowsFromAltimeter();
  renderAttributeRows();
}

async function selectFlight(directory) {
  const flight = state.flights.find((entry) => entry.directory === directory);
  if (!flight) return;
  state.selectedFlight = flight;
  state.altimeterCache.clear();
  state.activeSeries = [];
  renderFlightList();

  const overview = await window.flightApi.getOverview(directory);
  state.selectedOverview = overview;
  state.selectedAltimeterId = overview.altimeters?.[0]?.id || "";
  text(elements.flightTitle, `${overview.date || "Unknown"} - ${overview.rocketName || overview.directory}`);
  text(elements.flightSubtitle, `Indexed ${overview.generatedAt}`);
  setVisibleDetails(true);
  populateAltimeterSelect(overview);
  showTab("plot");
  await loadAndRenderAltimeter();
}

async function loadFlightList() {
  const payload = await window.flightApi.listFlights();
  state.flights = payload.flights || [];
  applyFiltersAndRender();

  if (!state.flights.length) {
    setVisibleDetails(false);
    text(elements.flightTitle, "Select a flight");
    text(elements.flightSubtitle, "");
    return;
  }

  if (!state.selectedFlight || !state.flights.some((flight) => flight.directory === state.selectedFlight.directory)) {
    const first = state.filteredFlights[0]?.directory || state.flights[0].directory;
    await selectFlight(first);
  } else {
    renderFlightList();
  }
}

async function runIndexFromGui() {
  elements.indexStatus.textContent = "Indexing...";
  const result = await window.flightApi.runIndex();
  elements.indexStatus.textContent = `Indexed ${result.scanned} flights (${result.updated} updated, ${result.skipped} skipped).`;
  await loadFlightList();
}

function wireEvents() {
  elements.refreshBtn.addEventListener("click", loadFlightList);
  elements.runIndexBtn.addEventListener("click", runIndexFromGui);
  elements.searchInput.addEventListener("input", applyFiltersAndRender);

  elements.altimeterSelect.addEventListener("change", async () => {
    state.selectedAltimeterId = elements.altimeterSelect.value;
    state.activeSeries = [];
    await loadAndRenderAltimeter();
  });

  elements.trimToggle.addEventListener("change", () => {
    state.trimEnabled = elements.trimToggle.checked;
    render2dPlot(currentAltimeterCachePayload());
  });

  elements.plotSelectSeriesBtn.addEventListener("click", () => {
    openSeriesModal(currentAltimeterCachePayload());
  });

  elements.plotResetSeriesBtn.addEventListener("click", () => {
    const payload = currentAltimeterCachePayload();
    const chartData = payload?.parsedFile?.chartData;
    if (!chartData) return;
    state.activeSeries = chartData.defaultSeries?.filter((column) => chartData.seriesByColumn[column]).slice(0, 3) || [];
    if (!state.activeSeries.length) state.activeSeries = (chartData.numericColumns || []).slice(0, 3);
    renderSeriesChips();
    render2dPlot(payload);
  });

  elements.plotSeriesSearch.addEventListener("input", () => {
    state.seriesModalSearch = String(elements.plotSeriesSearch.value || "");
    const columns = currentAltimeterCachePayload()?.parsedFile?.chartData?.numericColumns || [];
    renderSeriesOptions(columns);
  });

  elements.plotSeriesApplyBtn.addEventListener("click", () => {
    const payload = currentAltimeterCachePayload();
    const chartData = payload?.parsedFile?.chartData;
    if (!chartData) {
      closeSeriesModal();
      return;
    }
    const selected = state.draftSeriesSelection.filter((column) => chartData.seriesByColumn[column]);
    state.activeSeries = selected.length ? selected : (chartData.defaultSeries || []).filter((column) => chartData.seriesByColumn[column]).slice(0, 3);
    if (!state.activeSeries.length) state.activeSeries = (chartData.numericColumns || []).slice(0, 3);
    closeSeriesModal();
    renderSeriesChips();
    render2dPlot(payload);
  });

  elements.plotSeriesCancelBtn.addEventListener("click", closeSeriesModal);
  elements.plotSeriesModal.addEventListener("click", (event) => {
    if (event.target === elements.plotSeriesModal) closeSeriesModal();
  });

  elements.plotFitTrimBtn.addEventListener("click", fit2dTrimRange);
  elements.plotFitFullBtn.addEventListener("click", fit2dFullRange);
  elements.plotResetViewBtn.addEventListener("click", reset2dView);
  elements.plotPanLeftBtn.addEventListener("click", () => pan2dByRatio(-1));
  elements.plotPanRightBtn.addEventListener("click", () => pan2dByRatio(1));
  elements.plotZoomInBtn.addEventListener("click", () => zoom2dByFactor(0.65));
  elements.plotZoomOutBtn.addEventListener("click", () => zoom2dByFactor(1.5));

  document.querySelectorAll(".tab").forEach((tabButton) => {
    tabButton.addEventListener("click", () => showTab(tabButton.dataset.tab));
  });

  elements.addAttributeBtn.addEventListener("click", () => {
    state.attributeRows.push({ key: "", value: "", removed: false });
    renderAttributeRows();
  });

  elements.saveAttributesBtn.addEventListener("click", saveAttributes);
}

wireEvents();
resetHoverDashboard();
loadFlightList().catch((error) => {
  console.error(error);
  elements.welcome.classList.remove("hidden");
  elements.welcome.innerHTML = `<h3>Failed to load flights.</h3><p>${escapeHtml(error.message)}</p>`;
});
