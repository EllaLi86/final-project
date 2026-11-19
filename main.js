// Plot 2 — interactive SST trend map.
// Data comes from export_sst_trend.py: for each end year Y, the per-cell linear
// trend of annual SST fitted over 1850..Y (stored as milli-°C/decade, int16).
//
// Rendering: each frame is painted once into an offscreen canvas (1 pixel = 1 grid
// cell), then drawn onto the visible canvas under the current d3.zoom transform with
// image smoothing off, so cells stay crisp squares at any zoom level.

const MODES = {
  rate:  { limit: 0.1, unit: "°C/decade", fmt: d3.format("+.3f"), label: "Trend" },
  total: { limit: 1.0, unit: "°C",        fmt: d3.format("+.2f"), label: "Trend × years" },
};
const LAT_MIN = -80, LAT_MAX = 63, LON_MIN = 0, LON_MAX = 360;
const M = { left: 34, bottom: 22 };          // room for axis labels around the map
const NOISY_WINDOW = 30;                     // years; shorter fits are mostly noise
const MAX_ZOOM = 40;
const LUT_SIZE = 512;                        // color lookup resolution

const state = { k: 0, mode: "rate", playing: null, thresh: { rate: null, total: null } };
let meta, data, nx, ny, xEdges, yEdges, ctx, mapW, mapH;
let off, offCtx, painted = false, landColor = "#ccc";
let transform = d3.zoomIdentity, gx, gy;

const zoom = d3.zoom()
  .scaleExtent([1, MAX_ZOOM])
  .on("zoom", (e) => { transform = e.transform; draw(); });

const mapSel = d3.select('#map');

d3.select('#zoom-in').on('click', () =>
  mapSel.transition().duration(200).call(zoom.scaleBy, 1.5));

d3.select('#zoom-out').on('click', () =>
  mapSel.transition().duration(200).call(zoom.scaleBy, 1 / 1.5));

d3.select('#zoom-reset').on('click', () =>
  mapSel.transition().duration(300).call(zoom.transform, d3.zoomIdentity));

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

Promise.all([
  fetch("data/sst_meta.json").then((r) => r.json()),
  fetch("data/sst_trend.bin").then((r) => r.arrayBuffer()),
]).then(([m, buf]) => {
  meta = m;
  data = new Int16Array(buf);
  nx = meta.x.length; ny = meta.y.length;
  xEdges = edges(meta.x);
  yEdges = edges(meta.y).map((v) => Math.max(LAT_MIN, Math.min(LAT_MAX, v)));
  init();
}).catch((err) => {
  document.getElementById("note").textContent =
    "Could not load data/ — open this page through a local server (python3 -m http.server) rather than as a file.";
  console.error(err);
});

// Cell boundaries from (possibly uneven) cell centers.
function edges(c) {
  const e = [c[0] - (c[1] - c[0]) / 2];
  for (let i = 1; i < c.length; i++) e.push((c[i - 1] + c[i]) / 2);
  e.push(c[c.length - 1] + (c[c.length - 1] - c[c.length - 2]) / 2);
  return e;
}

function value(k, j, i) {
  const q = data[(k * ny + j) * nx + i];
  if (q === meta.fill) return NaN;
  const rate = q / meta.scale;                       // °C / decade
  return state.mode === "rate" ? rate : (rate / 10) * (meta.years[k] - meta.start_year);
}

function colorScale() {
  const L = MODES[state.mode].limit;
  return d3.scaleLinear()
    .domain([-L, -L / 2, 0, L / 2, L])
    .range(["--div-neg-2", "--div-neg-1", "--div-mid", "--div-pos-1", "--div-pos-2"].map(css))
    .interpolate(d3.interpolateLab)
    .clamp(true);                                     // fixed scale: values beyond ±L saturate
}

function init() {
  const slider = document.getElementById("year");
  slider.min = meta.years[0];
  slider.max = meta.years[meta.years.length - 1];
  slider.value = slider.max;
  state.k = meta.years.length - 1;

  slider.addEventListener("input", () => { stop(); setYear(+slider.value); });
  document.querySelectorAll('input[name="mode"]').forEach((r) =>
    r.addEventListener("change", () => { state.mode = r.value; syncFilterUI(); render(); }));
  document.getElementById("play").addEventListener("click", togglePlay);

  off = document.createElement("canvas");            // 1 px per grid cell
  off.width = nx; off.height = ny;
  offCtx = off.getContext("2d");

  const canvas = document.getElementById("map");
  ctx = canvas.getContext("2d");
  canvas.style.touchAction = "none";                 // let d3.zoom handle touch drag / pinch
  canvas.style.cursor = "grab";
  d3.select(canvas).call(zoom).on("dblclick.zoom", null)   // double-click is easy to hit by accident
    .on("dblclick", () => resetZoom());


  setupFilter();
  setupMapHover();
  setupSeriesClicks();
  loadAnnual();
  new ResizeObserver(() => { layout(); buildSeries(); render(); }).observe(document.querySelector(".map-wrap"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
}

// "Reset zoom" button: uses #reset-zoom if the HTML has one, otherwise adds it to .controls.

function resetZoom() {
  d3.select(ctx.canvas).transition().duration(400).call(zoom.transform, d3.zoomIdentity);
}

// ---------- threshold filter ----------
// Type a value x: cells at or above x stay at full color, the rest fade out.
// The threshold is in the units of the current mode (°C/decade or total °C) and is
// remembered separately for each mode.
function setupFilter() {
  const box = document.createElement("div");
  box.className = "filter";
  box.innerHTML =
    '<label for="thresh">Highlight cells ≥</label> ' +
    '<input id="thresh" type="number" inputmode="decimal" style="width:5.5em"> ' +
    '<span id="thresh-unit"></span> <button id="thresh-clear" type="button">Clear</button> ' +
    '<span id="thresh-stat" class="muted"></span>';
  document.querySelector(".controls").appendChild(box);
  const input = document.getElementById("thresh");
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    state.thresh[state.mode] = Number.isFinite(v) ? v : null;
    render();
  });
  document.getElementById("thresh-clear").addEventListener("click", () => {
    input.value = ""; state.thresh[state.mode] = null; render();
  });
  syncFilterUI();
}
function syncFilterUI() {
  const input = document.getElementById("thresh"), th = state.thresh[state.mode];
  input.value = th === null ? "" : th;
  input.step = state.mode === "rate" ? 0.01 : 0.1;
  input.placeholder = state.mode === "rate" ? "e.g. 0.1" : "e.g. 1";
  document.getElementById("thresh-unit").textContent = MODES[state.mode].unit;
}
function updateFilterStat(frac) {
  const th = state.thresh[state.mode];
  document.getElementById("thresh-stat").textContent =
    th === null ? "" : `≈ ${(100 * frac).toFixed(1)}% of ocean area`;
}

function setYear(y) {
  state.k = Math.max(0, Math.min(meta.years.length - 1, y - meta.years[0]));
  document.getElementById("year").value = meta.years[state.k];
  render();
}

function togglePlay() {
  if (state.playing) return stop();
  if (state.k === meta.years.length - 1) state.k = 0;
  document.getElementById("play").textContent = "❚❚";
  document.getElementById("play").setAttribute("aria-label", "Pause");
  state.playing = d3.interval(() => {
    if (state.k >= meta.years.length - 1) return stop();
    setYear(meta.years[state.k + 1]);
  }, 80);
}
function stop() {
  if (!state.playing) return;
  state.playing.stop(); state.playing = null;
  document.getElementById("play").textContent = "▶";
  document.getElementById("play").setAttribute("aria-label", "Play");
}

// ---------- layout ----------
const lonX = () => d3.scaleLinear([LON_MIN, LON_MAX], [0, mapW]);
const latY = () => d3.scaleLinear([LAT_MIN, LAT_MAX], [mapH, 0]);

const wrapLon = (d) => ((d % 360) + 360) % 360;       // any longitude -> [0, 360)

const fmtDeg = (d, pos, neg) => {
  const a = +Math.abs(d).toFixed(1);
  return a === 0 ? "0°" : a + "°" + (d < 0 ? neg : pos);
};

function layout() {
  const wrap = document.querySelector(".map-wrap");
  mapW = wrap.clientWidth - M.left;
  mapH = Math.round(mapW * (LAT_MAX - LAT_MIN) / (LON_MAX - LON_MIN));
  const canvas = ctx.canvas, dpr = window.devicePixelRatio || 1;
  canvas.style.width = mapW + "px"; canvas.style.height = mapH + "px";
  canvas.width = Math.round(mapW * dpr); canvas.height = Math.round(mapH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  wrap.style.height = mapH + M.bottom + "px";

  const svg = d3.select("#map-axes");
  svg.selectAll("*").remove();
  const g = svg.append("g").attr("transform", `translate(${M.left},0)`);
  gx = g.append("g").attr("class", "axis").attr("transform", `translate(0,${mapH})`);
  gy = g.append("g").attr("class", "axis");

  // Pan/zoom limits track the map size; a resize resets the view.
  // Longitude wraps around (unlimited horizontal pan); latitude stays clamped at the poles.
  zoom.extent([[0, 0], [mapW, mapH]]).translateExtent([[-Infinity, 0], [Infinity, mapH]]);
  transform = d3.zoomIdentity;
  d3.select(canvas).call(zoom.transform, d3.zoomIdentity);
  updateAxes();
}

// Axes follow the zoom: rescale the lon/lat scales and redraw ticks for the visible window.
function updateAxes() {
  if (!gx || !mapW) return;
  const zx = transform.rescaleX(lonX()), zy = transform.rescaleY(latY());
  gx.call(d3.axisBottom(zx).ticks(mapW < 500 ? 4 : 8).tickFormat((d) => fmtDeg(wrapLon(d), "E", "W")).tickSizeOuter(0));
  gy.call(d3.axisLeft(zy).ticks(5).tickFormat((d) => fmtDeg(d, "N", "S")).tickSizeOuter(0));
}

// ---------- render ----------
// Paint the current frame into the offscreen canvas: 1 pixel per cell, land transparent.
function paint(k, color) {
  const L = MODES[state.mode].limit;
  const lut = new Uint8ClampedArray(LUT_SIZE * 3);
  for (let n = 0; n < LUT_SIZE; n++) {
    const c = d3.rgb(color(-L + (2 * L * n) / (LUT_SIZE - 1)));
    lut[3 * n] = c.r; lut[3 * n + 1] = c.g; lut[3 * n + 2] = c.b;
  }
  const img = offCtx.createImageData(nx, ny), px = img.data;
  const th = state.thresh[state.mode];
  const latW = Array.from(meta.y, (y) => Math.cos((y * Math.PI) / 180));   // area weight per row
  let hit = 0, tot = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const v = value(k, j, i);
      if (Number.isNaN(v)) continue;                  // alpha stays 0 -> land color shows through
      const n = Math.max(0, Math.min(LUT_SIZE - 1, Math.round(((v + L) / (2 * L)) * (LUT_SIZE - 1))));
      const p = 4 * (j * nx + i);
      px[p] = lut[3 * n]; px[p + 1] = lut[3 * n + 1]; px[p + 2] = lut[3 * n + 2]; const ok = th === null || v >= th; tot += latW[j]; if (ok) hit += latW[j]; px[p + 3] = ok ? 255 : 45;
    }
  }
  offCtx.putImageData(img, 0, 0);
  painted = true;
  return tot ? hit / tot : 0;
}

// Draw the offscreen frame under the zoom transform. Rows are drawn one at a time so
// uneven latitude spacing (row j spans yEdges[j]..yEdges[j+1]) is respected.
function draw() {
  if (!mapW || !painted) return;
  const xs = lonX(), ys = latY(), t = transform;
  ctx.save();
  ctx.imageSmoothingEnabled = false;                  // crisp cells
  ctx.fillStyle = landColor;
  ctx.fillRect(0, 0, mapW, mapH);
  ctx.translate(t.x, t.y);
  ctx.scale(t.k, t.k);
  const x0 = xs(xEdges[0]), w = xs(xEdges[nx]) - x0, pad = 0.6 / t.k;   // pad hides row seams
  // Longitude is periodic: draw the map once per 360° tile that overlaps the view.
  const first = Math.floor(-t.x / t.k / mapW) - 1, last = Math.floor((mapW - t.x) / t.k / mapW) + 1;
  for (let j = 0; j < ny; j++) {
    const y0 = ys(yEdges[j + 1]), h = ys(yEdges[j]) - y0;
    if (h <= 0) continue;
    for (let n = first; n <= last; n++) ctx.drawImage(off, 0, j, nx, 1, x0 + n * mapW, y0, w + pad, h + pad);
  }
  ctx.restore();
  updateAxes();
  renderMarker();

}

function render() {
  if (!mapW) return;
  const k = state.k, year = meta.years[k], mode = MODES[state.mode];
  const color = colorScale();
  landColor = css("--land");

  const frac = paint(k, color);
  updateFilterStat(frac);
  draw();

  const g = globalMean(k);
  document.getElementById("year-label").textContent = year;
  document.getElementById("subtitle").textContent =
    `Per-cell linear trend of annual-mean SST, fitted over ${meta.start_year}–${year} · area-weighted global mean ${mode.fmt(g)} ${mode.unit}`;
  const n = year - meta.start_year + 1;
  document.getElementById("note").textContent = n < NOISY_WINDOW
    ? `Only ${n} years in this fit — short-window trends are mostly year-to-year noise, so many cells hit the end of the color scale.`
    : "";

  renderLegend(color);
  updateSeries();

}

function globalMean(k) {
  const rate = meta.global_mean_trend[k];
  return state.mode === "rate" ? rate : (rate / 10) * (meta.years[k] - meta.start_year);
}

function renderLegend(color) {
  const L = MODES[state.mode].limit, svg = d3.select("#legend");
  const w = svg.node().clientWidth, barH = 12;
  svg.selectAll("*").remove();
  const grad = svg.append("defs").append("linearGradient").attr("id", "legend-grad");
  d3.range(0, 1.0001, 0.1).forEach((t) =>
    grad.append("stop").attr("offset", t).attr("stop-color", color(-L + 2 * L * t)));
  svg.append("rect").attr("width", w).attr("height", barH).attr("rx", 3).attr("fill", "url(#legend-grad)");
  const x = d3.scaleLinear([-L, L], [0, w]);
  const th = state.thresh[state.mode];
  if (th !== null) {
    const tx = x(Math.max(-L, Math.min(L, th)));
    svg.append("line").attr("x1", tx).attr("x2", tx).attr("y1", -2).attr("y2", barH + 2)
      .attr("stroke", "currentColor").attr("stroke-width", 2);
  }
  const ticks = [-L, -L / 2, 0, L / 2, L];
  const fmt = state.mode === "rate" ? d3.format("+.2~f") : d3.format("+.1~f");
  svg.append("g").selectAll("text").data(ticks).join("text")
    .attr("x", (d) => x(d)).attr("y", barH + 14)
    .attr("text-anchor", (d, i) => (i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle"))
    .text((d, i) => (i === 0 ? "≤ " : i === ticks.length - 1 ? "≥ " : "") + (d === 0 ? "0" : fmt(d)));
  svg.append("text").attr("x", w / 2).attr("y", barH + 30).attr("text-anchor", "middle")
    .text(state.mode === "rate" ? "SST trend (°C per decade)" : "Warming implied by trend over the window (°C)");
}

// ---------- map hover ----------
function setupMapHover() {
  const canvas = ctx.canvas, tip = document.getElementById("tooltip");
  canvas.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    const [bx, by] = transform.invert([e.clientX - r.left, e.clientY - r.top]);   // undo zoom/pan
    let lon = wrapLon(lonX().invert(bx));
    if (lon < xEdges[0]) lon += 360;
    const lat = latY().invert(by);
    const i = d3.bisectRight(xEdges, lon) - 1, j = d3.bisectRight(yEdges, lat) - 1;
    if (i < 0 || i >= nx || j < 0 || j >= ny) { tip.hidden = true; return; }
    const v = value(state.k, j, i), mode = MODES[state.mode];
    const latTxt = Math.abs(meta.y[j]).toFixed(1) + (meta.y[j] < 0 ? "°S" : "°N");
    tip.innerHTML = `<span class="muted">${meta.x[i].toFixed(1)}°E, ${latTxt}</span><br>` +
      (Number.isNaN(v) ? "land" : `${mode.label} ${meta.start_year}–${meta.years[state.k]}: <strong>${mode.fmt(v)}</strong> ${mode.unit}`);
    tip.hidden = false;
    const wrapW = canvas.parentElement.clientWidth;
    const px = e.clientX - r.left + M.left, py = e.clientY - r.top;
    tip.style.left = Math.min(px + 14, wrapW - tip.offsetWidth - 4) + "px";
    tip.style.top = Math.max(0, py - 44) + "px";
  });
  canvas.addEventListener("pointerleave", () => { tip.hidden = true; });
}

// ---------- time series: global mean, click-a-cell, scrub-to-year ----------
const BASELINE = [1850, 1879];                    // anomalies are relative to this period
const SM = { top: 24, right: 12, bottom: 22, left: 46 };
const ANNUAL_SCALE = 500, ANNUAL_FILL = -32768;   // sst_annual.bin: int16, value / 500 = °C, -32768 = land
let series = null;
let annual = null;        // Int16Array (years × 97 × 180), 2°×2° cells; null until loaded
let selCell = null;       // { I, J } index into the 2° grid, or null = global mean

// Loaded in the background; the size check waits until the map's grid (nx, ny) is known.
const annualBuf = fetch("data/sst_annual.bin").then((r) => r.arrayBuffer());
function loadAnnual() {
  annualBuf.then((buf) => {
    const a = new Int16Array(buf);
    annual = a.length === meta.global_mean_sst.length * (nx >> 1) * (ny >> 1) ? a : null;
    if (!annual) console.warn("sst_annual.bin does not match the map grid; click-a-cell is disabled");
  }).catch((err) => console.error(err));
}


function anomalies(values) {
  const base = d3.mean(values.slice(BASELINE[0] - meta.start_year, BASELINE[1] - meta.start_year + 1));
  return values.map((v) => v - base);
}

// Fitted line over [a, b] as two endpoints, plus its slope in °C/decade.
function fitLine(vals, a, b) {
  const w = vals.slice(a - meta.start_year, b - meta.start_year + 1), n = w.length, tbar = (n - 1) / 2;
  const slope = d3.sum(w, (v, t) => (t - tbar) * v) / ((n * (n * n - 1)) / 12);   // °C / year
  const mid = d3.mean(w);
  return { x1: a, y1: mid - slope * tbar, x2: b, y2: mid + slope * tbar, rate: slope * 10 };
}

// Yearly SST of one 2° cell (°C), same year range as global_mean_sst.
function cellValues(c) {
  const n = meta.global_mean_sst.length, nxc = nx >> 1, nyc = ny >> 1;
  return Array.from({ length: n }, (_, k) => annual[(k * nyc + c.J) * nxc + c.I] / ANNUAL_SCALE);
}
const cellLon = (c) => (meta.x[2 * c.I] + meta.x[2 * c.I + 1]) / 2;
const cellLat = (c) => (meta.y[2 * c.J] + meta.y[2 * c.J + 1]) / 2;
const cellLabel = (c) => {
  const lat = cellLat(c);
  return `${Math.round(cellLon(c))}°E, ${Math.abs(Math.round(lat))}°${lat < 0 ? "S" : "N"} (2° cell)`;
};

// Static parts (axes, lines): rebuilt only when the size or the selected cell changes.
function buildSeries() {
  if (!meta || !meta.global_mean_sst) return;
  const svg = d3.select("#series");
  svg.selectAll("*").remove();
  const W = svg.node().clientWidth, H = svg.node().clientHeight;
  const iw = W - SM.left - SM.right, ih = H - SM.top - SM.bottom;
  const first = meta.start_year, last = meta.years[meta.years.length - 1];
  const glob = anomalies(meta.global_mean_sst);
  const main = selCell ? anomalies(cellValues(selCell)) : glob;
  const ref = selCell ? glob : null;

  const x = d3.scaleLinear([first, last], [0, iw]);
  const y = d3.scaleLinear(d3.extent([...main, ...(ref || []), 0]), [ih, 0]).nice();
  const g = svg.append("g").attr("transform", `translate(${SM.left},${SM.top})`);

  g.append("g").attr("class", "axis").attr("transform", `translate(0,${ih})`)
    .call(d3.axisBottom(x).ticks(iw < 450 ? 4 : 8).tickFormat(d3.format("d")).tickSizeOuter(0));
  g.append("g").attr("class", "axis")
    .call(d3.axisLeft(y).ticks(5).tickFormat(d3.format("+.1~f")).tickSizeOuter(0));
  g.append("text").attr("class", "ylabel").attr("x", -SM.left).attr("y", -SM.top + 2).attr("dy", "0.7em")
    .text(`°C vs ${BASELINE[0]}–${BASELINE[1]}`);
  g.append("line").attr("class", "zero").attr("x1", 0).attr("x2", iw).attr("y1", y(0)).attr("y2", y(0));

  // Click or drag anywhere on the plot: the map jumps to that end year.
  const scrub = (e) => {
    stop();
    const yr = Math.max(meta.years[0], Math.min(last, Math.round(x.invert(e.x))));
    if (yr !== meta.years[state.k]) setYear(yr);
  };
  g.append("rect").attr("class", "bg").attr("width", iw).attr("height", ih)
    .call(d3.drag().on("start", scrub).on("drag", scrub));

  const now = g.append("line").attr("class", "now").attr("y1", 0).attr("y2", ih);
  const line = d3.line().x((_, k) => x(first + k)).y((v) => y(v));
  if (ref) g.append("path").attr("class", "line-ref").attr("d", line(ref));
  g.append("path").attr("class", "line-main").attr("d", line(main));
  const dots = g.append("g");
  const fitRef = ref ? g.append("line").attr("class", "fit-ref") : null;
  const fit = g.append("line").attr("class", "fit");

  // Legend key, right-aligned above the plot.
  const key = g.append("g").attr("class", "key").attr("transform", `translate(${iw},${-SM.top + 8})`);
  const items = [[selCell ? "this cell" : "global mean", "line-main"],
    ...(ref ? [["global mean", "line-ref"]] : []), ["trend 1850 to end year", "fit"]];
  let kx = 0;
  items.reverse().forEach(([label, cls]) => {
    const t = key.append("text").attr("x", kx).attr("dy", "0.32em").attr("text-anchor", "end").text(label);
    kx -= t.node().getComputedTextLength() + 6;
    key.append("line").attr("class", cls).attr("x1", kx - 16).attr("x2", kx);
    kx -= 30;
  });

  series = { x, y, now, dots, fit, fitRef, main, ref };
}

// Dynamic parts: end-year marker, dots, fitted line(s), subtitle. Runs on every render.
function updateSeries() {
  if (!series) buildSeries();
  if (!series) return;
  const { x, y, now, dots, fit, fitRef, main, ref } = series;
  const a = meta.start_year, b = meta.years[state.k];
  now.attr("x1", x(b)).attr("x2", x(b));

  const upto = main.map((v, k) => [a + k, v]).filter(([yr]) => yr <= b);
  dots.selectAll("circle").data(upto).join("circle").attr("class", "dot")
    .attr("r", 1.5).attr("cx", (d) => x(d[0])).attr("cy", (d) => y(d[1]));

  const f = fitLine(main, a, b);
  fit.attr("x1", x(f.x1)).attr("y1", y(f.y1)).attr("x2", x(f.x2)).attr("y2", y(f.y2));
  let sub = `Trend ${a}–${b}: ${d3.format("+.3f")(f.rate)} °C/decade`;
  if (ref) {
    const r = fitLine(ref, a, b);
    fitRef.attr("x1", x(r.x1)).attr("y1", y(r.y1)).attr("x2", x(r.x2)).attr("y2", y(r.y2));
    sub += ` · global mean ${d3.format("+.3f")(r.rate)} °C/decade`;
  }
  document.getElementById("series-sub").textContent = sub;
}

// ---------- click a map cell ----------
function selectCell(c) {
  if (c === selCell) return;
  selCell = c;
  document.getElementById("clear-cell").hidden = c === null;
  document.getElementById("series-title").textContent = c === null ? "Global-mean SST" : `SST near ${cellLabel(c)}`;
  buildSeries();
  updateSeries();
  renderMarker();
}

function setupSeriesClicks() {
  const canvas = ctx.canvas;
  canvas.addEventListener("click", (e) => {
    if (!annual) return;
    const r = canvas.getBoundingClientRect();
    const [bx, by] = transform.invert([e.clientX - r.left, e.clientY - r.top]);   // undo zoom/pan
    let lon = wrapLon(lonX().invert(bx));
    if (lon < xEdges[0]) lon += 360;
    const lat = latY().invert(by);
    const i = d3.bisectRight(xEdges, lon) - 1, j = d3.bisectRight(yEdges, lat) - 1;
    let next = null;                                         // land or off-map -> back to global mean
    if (i >= 0 && i < nx && j >= 0 && j < ny && !Number.isNaN(value(meta.years.length - 1, j, i))) {
      next = { I: i >> 1, J: j >> 1 };
      if (selCell && next.I === selCell.I && next.J === selCell.J) next = null;   // same cell again
    }
    selectCell(next);
  });
  document.getElementById("clear-cell").addEventListener("click", () => selectCell(null));
}

// Ring on the selected cell. Follows zoom/pan because draw() calls it.
function renderMarker() {
  const svg = d3.select("#map-axes");
  svg.selectAll(".marker-g").remove();
  if (!selCell || !mapW) return;
  const t = transform, period = mapW * t.k;                  // one full 360° on screen
  let sx = t.applyX(lonX()(cellLon(selCell)));
  sx = ((sx % period) + period) % period;                    // longitude wraps around
  const sy = t.applyY(latY()(cellLat(selCell)));
  if (sx > mapW || sy < 0 || sy > mapH) return;              // scrolled out of view
  const g = svg.append("g").attr("class", "marker-g");
  g.append("circle").attr("class", "marker-halo").attr("cx", M.left + sx).attr("cy", sy).attr("r", 7);
  g.append("circle").attr("class", "marker").attr("cx", M.left + sx).attr("cy", sy).attr("r", 7);
}
