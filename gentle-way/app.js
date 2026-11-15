import { loadElevation, loadCoverage } from './elevation.js';
import {
  buildGraph, nearestNode, findRoute, summarize, gradeClass, dist, OSM_HIGHWAY_FILTER, STEPS, UNEVEN,
} from './graph.js';

const COLORS = ['#65816D', '#A8A157', '#BD7423', '#963A1E', '#4A0F14', '#072F37'];
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const MAX_WALK = 8000; // metres, straight line
const DOWN_FACTOR = 1.4;

const $ = (id) => document.getElementById(id);
const isPhone = () => matchMedia('(max-width: 760px)').matches;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (g) => Math.round(Math.abs(g) * 100) + '%';
const fmtDist = (m) => (m < 950 ? Math.max(10, Math.round(m / 10) * 10) + ' m' : (m / 1000).toFixed(1) + ' km');
const fmtMin = (s) => Math.max(1, Math.round(s / 60)) + ' min';

/* ---------- Map ---------- */

const CITIES = {
  hobart: { name: 'Hobart', lat: -42.8826, lon: 147.3257, zoom: 15 },
  canberra: { name: 'Canberra', lat: -35.2809, lon: 149.13, zoom: 15 },
};
let startCity = 'hobart';
try { startCity = CITIES[localStorage.getItem('gentleway-city')] ? localStorage.getItem('gentleway-city') : 'hobart'; } catch (e) { /* ignore */ }

const map = L.map('map', { zoomControl: false })
  .setView([CITIES[startCity].lat, CITIES[startCity].lon], CITIES[startCity].zoom);
L.control.zoom({ position: 'topright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(map);
map.createPane('coverage').style.zIndex = 405;
map.getPane('coverage').style.pointerEvents = 'none';
map.createPane('slopes').style.zIndex = 410;
map.createPane('route').style.zIndex = 420;
const slopeCanvas = L.canvas({ pane: 'slopes', padding: 0.3 });
const routeCanvas = L.canvas({ pane: 'route', padding: 0.3 });
const slopeLayer = L.layerGroup();
const routeLayer = L.layerGroup().addTo(map);

const SlopesControl = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const b = L.DomUtil.create('button', 'map-btn');
    b.type = 'button';
    b.id = 'slopes-btn';
    b.textContent = 'Show street slopes';
    L.DomEvent.disableClickPropagation(b);
    b.addEventListener('click', toggleSlopes);
    return b;
  },
});
map.addControl(new SlopesControl());

const CoverageNote = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const d = L.DomUtil.create('div', 'coverage-note');
    d.id = 'coverage-note';
    d.hidden = true;
    return d;
  },
});
map.addControl(new CoverageNote());

/* ---------- State ---------- */

const pts = { a: null, b: null };
const markers = { a: null, b: null };
let G = null;
let pending = null;
let runId = 0;
let slopesOn = false;
let hoverDot = null;

function status(msg, kind) {
  const el = $('status');
  el.textContent = msg || '';
  el.className = kind || '';
}

/* ---------- Preferences ---------- */

function getPrefs() {
  return {
    maxGrade: Number($('max-grade').value) / 100,
    downFactor: $('down-harder').checked ? DOWN_FACTOR : 1,
    avoidSteps: $('avoid-steps').checked,
    avoidUneven: $('avoid-uneven').checked,
  };
}

function gradeHint(v) {
  if (v <= 4) return 'Close to flat, like a gentle driveway.';
  if (v <= 6) return 'A mild rise you notice but don\'t work at.';
  if (v <= 9) return 'About as steep as a standard wheelchair ramp (8%).';
  if (v <= 13) return 'A proper hill, with real load on the ankle.';
  return 'Steep. Most people shorten their stride on this.';
}

function syncPrefsUI() {
  const v = Number($('max-grade').value);
  $('max-grade-out').textContent = v + '%';
  $('max-grade-hint').textContent = gradeHint(v);
}

function savePrefs() {
  try {
    localStorage.setItem('gentleway-prefs', JSON.stringify({
      g: $('max-grade').value, d: $('down-harder').checked, s: $('avoid-steps').checked, u: $('avoid-uneven').checked,
    }));
  } catch (e) { /* private mode */ }
}

(function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('gentleway-prefs') || 'null');
    if (p) {
      $('max-grade').value = p.g;
      $('down-harder').checked = p.d;
      $('avoid-steps').checked = p.s;
      $('avoid-uneven').checked = p.u;
    }
  } catch (e) { /* ignore */ }
  syncPrefsUI();
})();

for (const id of ['max-grade', 'down-harder', 'avoid-steps', 'avoid-uneven']) {
  $(id).addEventListener('input', () => {
    syncPrefsUI();
    savePrefs();
    go(false);
  });
}

/* ---------- Data loading ---------- */

const contains = (outer, inner) => outer.s <= inner.s && outer.w <= inner.w && outer.n >= inner.n && outer.e >= inner.e;
const union = (p, q) => ({ s: Math.min(p.s, q.s), w: Math.min(p.w, q.w), n: Math.max(p.n, q.n), e: Math.max(p.e, q.e) });

function padBox(b, metres) {
  const dLat = metres / 111320;
  const dLon = metres / (111320 * Math.cos((((b.s + b.n) / 2) * Math.PI) / 180));
  return { s: b.s - dLat, w: b.w - dLon, n: b.n + dLat, e: b.e + dLon };
}

function routeBox() {
  const { a, b } = pts;
  const d = dist(a.lat, a.lon, b.lat, b.lon);
  return padBox(
    { s: Math.min(a.lat, b.lat), w: Math.min(a.lon, b.lon), n: Math.max(a.lat, b.lat), e: Math.max(a.lon, b.lon) },
    Math.max(500, d * 0.35),
  );
}

async function fetchStreets(b) {
  const q = `[out:json][timeout:40];way[highway~"^(${OSM_HIGHWAY_FILTER})$"](${b.s},${b.w},${b.n},${b.e});out geom qt;`;
  // Public Overpass servers come and go. Start with the one that worked last time, and if a server
  // hasn't answered within a few seconds, ask the next one as well. First good answer wins.
  let order = OVERPASS.slice();
  try {
    const last = localStorage.getItem('gentleway-overpass');
    if (last && order.includes(last)) order = [last, ...order.filter((u) => u !== last)];
  } catch (e) { /* ignore */ }
  const controllers = [];
  const timers = [];
  const attempt = (url, delay) => new Promise((resolve, reject) => {
    timers.push(setTimeout(async () => {
      const ac = new AbortController();
      controllers.push(ac);
      const giveUp = setTimeout(() => ac.abort(), 45000);
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(q),
          signal: ac.signal,
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (!j.elements || !j.elements.length) throw new Error('empty response');
        try { localStorage.setItem('gentleway-overpass', url); } catch (e) { /* ignore */ }
        resolve(j.elements);
      } catch (e) {
        reject(e);
      } finally {
        clearTimeout(giveUp);
      }
    }, delay));
  });
  try {
    return await Promise.any(order.map((url, i) => attempt(url, i * 5000)));
  } catch (e) {
    throw new Error('Street data is unavailable right now. Try again in a minute.');
  } finally {
    timers.forEach(clearTimeout);
    controllers.forEach((ac) => ac.abort());
  }
}

async function ensureGraph(box) {
  if (G && contains(G.box, box)) return G;
  if (pending && contains(pending.box, box)) return pending.promise;
  status('Loading streets and terrain…', 'busy');
  const promise = (async () => {
    // Terrain covers a wider margin than the streets, because streets run on past the box edge.
    const [elements, elev] = await Promise.all([fetchStreets(box), loadElevation(padBox(box, 300))]);
    const g = buildGraph(elements, elev);
    g.box = box;
    G = g;
    $('elev-note').textContent = `Terrain: ${elev.label}.`;
    if (slopesOn) drawSlopes();
    return g;
  })();
  pending = { box, promise };
  try {
    return await promise;
  } finally {
    if (pending && pending.promise === promise) pending = null;
  }
}

/* ---------- Routing ---------- */

async function go(refit = true) {
  const id = ++runId;
  if (!pts.a || !pts.b) {
    $('result').innerHTML = '';
    routeLayer.clearLayers();
    status(pts.a ? 'Now choose a destination.' : pts.b ? 'Now choose a start.' : '');
    return;
  }
  const d = dist(pts.a.lat, pts.a.lon, pts.b.lat, pts.b.lon);
  if (d > MAX_WALK) {
    $('result').innerHTML = '';
    routeLayer.clearLayers();
    status(`Those points are ${(d / 1000).toFixed(1)} km apart. Gentle Way plans walks up to ${MAX_WALK / 1000} km.`, 'error');
    return;
  }
  try {
    let box = routeBox();
    if (slopesOn && !(G && contains(G.box, box))) box = union(box, viewBox());
    const g = await ensureGraph(box);
    if (id !== runId) return;
    const sa = nearestNode(g, pts.a.lat, pts.a.lon);
    const sb = nearestNode(g, pts.b.lat, pts.b.lon);
    if (sa.node < 0 || sa.d > 250 || sb.d > 250) {
      throw new Error(`No walkable street was found near the ${sa.d > 250 ? 'start' : 'destination'}.`);
    }
    const prefs = getPrefs();
    const gentle = findRoute(g, sa.node, sb.node, prefs);
    const direct = findRoute(g, sa.node, sb.node, null);
    if (!gentle || !direct) throw new Error('No walking connection was found between those points.');
    const sg = summarize(g, gentle, sa.node, prefs);
    const sd = summarize(g, direct, sa.node, prefs);
    window.gentleWay.last = sg;
    renderResult(sg, sd, prefs);
    drawRoute(sg, sd, refit);
    status('');
  } catch (e) {
    if (id !== runId) return;
    console.error(e);
    $('result').innerHTML = '';
    routeLayer.clearLayers();
    status(e.message || 'Something went wrong.', 'error');
  }
}

function drawRoute(sg, sd, refit) {
  routeLayer.clearLayers();
  hoverDot = null;
  const line = sg.profile.map((p) => [p.lat, p.lon]);
  const base = { pane: 'route', renderer: routeCanvas, interactive: false, lineCap: 'round', lineJoin: 'round' };
  if (Math.abs(sd.dist - sg.dist) > 10) {
    L.polyline(sd.profile.map((p) => [p.lat, p.lon]), {
      ...base, color: '#072F37', weight: 3, opacity: 0.55, dashArray: '5 9',
    }).addTo(routeLayer);
  }
  L.polyline(line, { ...base, color: '#072F37', weight: 13, opacity: 0.22 }).addTo(routeLayer);
  L.polyline(line, { ...base, color: '#FFFFFF', weight: 10 }).addTo(routeLayer);
  const runs = [];
  let run = null;
  for (let i = 1; i < sg.profile.length; i++) {
    const c = sg.profile[i].c;
    if (!run || run.c !== c) {
      run = { c, pts: [line[i - 1]] };
      runs.push(run);
    }
    run.pts.push(line[i]);
  }
  for (const r of runs) {
    L.polyline(r.pts, {
      ...base, color: COLORS[r.c], weight: 6, dashArray: r.c === 5 ? '1 9' : null,
    }).addTo(routeLayer);
  }
  if (refit && line.length) {
    const opts = isPhone()
      ? { paddingTopLeft: [30, 30], paddingBottomRight: [30, Math.min($('panel').offsetHeight, innerHeight * 0.56) + 20] }
      : { paddingTopLeft: [420, 50], paddingBottomRight: [60, 50] };
    map.fitBounds(L.latLngBounds(line), { ...opts, maxZoom: 17 });
  }
}

function renderResult(sg, sd, prefs) {
  const upLimit = pct(prefs.maxGrade);
  const downLimit = pct(prefs.maxGrade / prefs.downFactor);
  const limitText = prefs.downFactor > 1 ? `${upLimit} uphill and ${downLimit} downhill` : upLimit;
  const warnings = [];
  if (sg.over >= 5) {
    warnings.push(`${fmtDist(sg.over)} is steeper than your limit of ${limitText}${sg.worst ? `, worst on ${esc(sg.worst)}` : ''}. No gentler way through was found.`);
  }
  if (sg.stepsLen > 0 && prefs.avoidSteps) warnings.push(`Includes ${fmtDist(sg.stepsLen)} of steps that couldn't be avoided.`);
  if (sg.unevenLen >= 10 && prefs.avoidUneven) warnings.push(`Includes ${fmtDist(sg.unevenLen)} of unpaved or uneven surface.`);
  if (sg.noData >= 20) warnings.push(`No terrain data for ${fmtDist(sg.noData)} of this route.`);
  const verdict = warnings.length
    ? `<p class="verdict warn">${warnings.join(' ')}</p>`
    : `<p class="verdict">Every stretch is within your limit of ${limitText}.</p>`;

  const approx = sg.coarse > 0.15 * sg.dist
    ? `<p class="approx">${sg.coarse > 0.85 * sg.dist ? 'This route' : `${fmtDist(sg.coarse)} of this route`} crosses the hatched area, where terrain is only mapped at 30 m. Slopes there are smoothed, so short steep pitches can be steeper than shown.</p>`
    : '';

  const same = Math.abs(sd.dist - sg.dist) <= 10;
  const compare = same
    ? 'This is also the most direct route.'
    : `The most direct route (dashed) is ${fmtDist(sd.dist)} but reaches ${pct(sd.maxUp)} uphill and ${pct(sd.maxDown)} downhill`
      + `${sd.stepsLen > 0 ? `, with ${fmtDist(sd.stepsLen)} of steps` : ''}. `
      + `The gentle route is ${fmtDist(Math.abs(sg.dist - sd.dist))} ${sg.dist >= sd.dist ? 'longer' : 'shorter'}.`;

  // Drop short crossings, then join stretches of the same street back together.
  const legs = [];
  for (const l of sg.legs) {
    if (l.len < 25 && !(l.f & STEPS)) continue;
    const prev = legs[legs.length - 1];
    if (prev && prev.name === l.name) {
      prev.len += l.len;
      prev.f |= l.f;
      prev.maxUp = Math.max(prev.maxUp, l.maxUp);
      prev.maxDown = Math.max(prev.maxDown, l.maxDown);
    } else {
      legs.push({ ...l });
    }
  }
  const legRows = legs.map((l) => {
    const bits = [fmtDist(l.len)];
    if (l.f & STEPS) bits.push('steps');
    else {
      if (l.maxUp >= 0.03) bits.push('↑ ' + pct(l.maxUp));
      if (l.maxDown >= 0.03) bits.push('↓ ' + pct(l.maxDown));
      if (l.maxUp < 0.03 && l.maxDown < 0.03) bits.push('flat');
    }
    const tag = l.f & UNEVEN ? ' <span class="tag">uneven</span>' : '';
    return `<li><span>${esc(l.name)}${tag}</span><small>${bits.join(' · ')}</small></li>`;
  }).join('');

  $('result').innerHTML = `
    <div class="headline">${fmtDist(sg.dist)}<span>about ${fmtMin(sg.time)} at an easy pace</span></div>
    ${verdict}
    ${approx}
    <ul class="stats">
      <li><b>${pct(sg.maxUp)}</b>steepest uphill</li>
      <li><b>${pct(sg.maxDown)}</b>steepest downhill</li>
      <li><b>${Math.round(sg.climb)} m</b>total climb</li>
      <li><b>${Math.round(sg.descent)} m</b>total descent</li>
    </ul>
    <p class="compare">${compare}</p>
    <div class="profile">${profileSvg(sg)}</div>
    <p class="readout" id="readout">Slide along the profile to find each slope on the map.</p>
    <details><summary>Street by street (${legs.length})</summary><ul class="legs">${legRows}</ul></details>`;
  wireProfile(sg);
  $('panel').classList.remove('min');
}

/* ---------- Elevation profile ---------- */

const PW = 340;
const PH = 130;
const PM = { l: 36, r: 6, t: 10, b: 20 };

function profileScale(sg) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of sg.profile) { if (p.z < lo) lo = p.z; if (p.z > hi) hi = p.z; }
  const span = Math.max(hi - lo, 12);
  const mid = (hi + lo) / 2;
  const z0 = mid - span * 0.55;
  const z1 = mid + span * 0.55;
  const total = sg.dist || 1;
  return {
    lo, hi, total,
    x: (d) => PM.l + (d / total) * (PW - PM.l - PM.r),
    y: (z) => PM.t + (1 - (z - z0) / (z1 - z0)) * (PH - PM.t - PM.b),
  };
}

function profileSvg(sg) {
  const s = profileScale(sg);
  const base = PH - PM.b;
  const P = sg.profile;
  let fills = '';
  let i = 1;
  while (i < P.length) {
    const c = P[i].c;
    let d = `M${s.x(P[i - 1].d).toFixed(1)} ${base} L${s.x(P[i - 1].d).toFixed(1)} ${s.y(P[i - 1].z).toFixed(1)}`;
    let j = i;
    while (j < P.length && P[j].c === c) {
      d += ` L${s.x(P[j].d).toFixed(1)} ${s.y(P[j].z).toFixed(1)}`;
      j++;
    }
    d += ` L${s.x(P[j - 1].d).toFixed(1)} ${base} Z`;
    fills += `<path d="${d}" fill="${COLORS[c]}" opacity="${c === 5 ? 0.55 : 0.88}"/>`;
    i = j;
  }
  const top = P.map((p, k) => `${k ? 'L' : 'M'}${s.x(p.d).toFixed(1)} ${s.y(p.z).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${PW} ${PH}" role="img" aria-label="Elevation profile of the gentle route, coloured by slope">
    <line x1="${PM.l}" x2="${PW - PM.r}" y1="${base}" y2="${base}" stroke="#C8CBBF"/>
    ${fills}
    <path d="${top}" fill="none" stroke="#072F37" stroke-width="1.6" stroke-linejoin="round"/>
    <text x="${PM.l - 5}" y="${s.y(s.hi) + 4}" text-anchor="end">${Math.round(s.hi)} m</text>
    <text x="${PM.l - 5}" y="${s.y(s.lo) + 4}" text-anchor="end">${Math.round(s.lo)} m</text>
    <text x="${PM.l}" y="${PH - 5}">A</text>
    <text x="${PW - PM.r}" y="${PH - 5}" text-anchor="end">B · ${fmtDist(sg.dist)}</text>
    <line id="cursor" y1="${PM.t}" y2="${base}" stroke="#072F37" stroke-width="1" visibility="hidden"/>
  </svg>`;
}

function wireProfile(sg) {
  const svg = $('result').querySelector('svg');
  const cursor = svg.querySelector('#cursor');
  const s = profileScale(sg);
  const P = sg.profile;
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * PW;
    const d = Math.min(Math.max(((px - PM.l) / (PW - PM.l - PM.r)) * s.total, 0), s.total);
    let k = 1;
    while (k < P.length - 1 && P[k].d < d) k++;
    const p = P[k];
    cursor.setAttribute('x1', s.x(p.d));
    cursor.setAttribute('x2', s.x(p.d));
    cursor.setAttribute('visibility', 'visible');
    const slope = p.c === 5 ? 'steps' : Math.abs(p.g) < 0.01 ? 'flat' : `${pct(p.g)} ${p.g > 0 ? 'uphill' : 'downhill'}`;
    $('readout').textContent = `${fmtDist(p.d)} from start · ${slope} · ${Math.round(p.z)} m above sea level`;
    if (!hoverDot) {
      hoverDot = L.circleMarker([p.lat, p.lon], {
        pane: 'route', renderer: routeCanvas, radius: 7, color: '#FFFFFF', weight: 3, fillColor: '#072F37', fillOpacity: 1, interactive: false,
      }).addTo(routeLayer);
    } else {
      hoverDot.setLatLng([p.lat, p.lon]);
    }
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
}

/* ---------- Street slope overlay ---------- */

function viewBox() {
  const c = map.getCenter();
  const b = map.getBounds();
  const box = { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() };
  const cap = padBox({ s: c.lat, w: c.lng, n: c.lat, e: c.lng }, 2500);
  return { s: Math.max(box.s, cap.s), w: Math.max(box.w, cap.w), n: Math.min(box.n, cap.n), e: Math.min(box.e, cap.e) };
}

function drawSlopes() {
  slopeLayer.clearLayers();
  if (!G) return;
  const parts = [[], [], [], [], [], []];
  for (const way of G.ways) {
    let cur = -1;
    let line = null;
    for (let k = 0; k < way.grades.length; k++) {
      const c = gradeClass(way.grades[k], way.f);
      if (c !== cur) {
        line = [[G.lat[way.nodes[k]], G.lon[way.nodes[k]]]];
        parts[c].push(line);
        cur = c;
      }
      line.push([G.lat[way.nodes[k + 1]], G.lon[way.nodes[k + 1]]]);
    }
  }
  parts.forEach((p, c) => {
    if (!p.length) return;
    L.polyline(p, {
      pane: 'slopes', renderer: slopeCanvas, interactive: false,
      color: COLORS[c], weight: 3, opacity: 0.8, dashArray: c === 5 ? '2 5' : null,
    }).addTo(slopeLayer);
  });
}

async function loadSlopesForView() {
  if (!slopesOn) return;
  const c = map.getCenter();
  const here = { s: c.lat, w: c.lng, n: c.lat, e: c.lng };
  if (G && contains(G.box, here)) {
    if (!slopeLayer.getLayers().length) drawSlopes();
    return;
  }
  if (map.getZoom() < 14) {
    status('Zoom in closer to load street slopes for this area.');
    return;
  }
  try {
    let box = viewBox();
    if (pts.a && pts.b) box = union(box, routeBox());
    await ensureGraph(box);
    if ($('status').classList.contains('busy')) status('');
  } catch (e) {
    status(e.message, 'error');
  }
}

function toggleSlopes() {
  slopesOn = !slopesOn;
  const b = $('slopes-btn');
  b.classList.toggle('on', slopesOn);
  b.textContent = slopesOn ? 'Hide street slopes' : 'Show street slopes';
  if (slopesOn) {
    slopeLayer.addTo(map);
    drawSlopes();
    loadSlopesForView();
  } else {
    map.removeLayer(slopeLayer);
  }
}

let moveTimer = null;
map.on('moveend', () => {
  if (!slopesOn) return;
  clearTimeout(moveTimer);
  moveTimer = setTimeout(loadSlopesForView, 900);
});

/* ---------- Terrain coverage shading ---------- */

let cov = null; // { box, w, h, mask, layer }
let covSeq = 0;
const COV_N = 128;

function hatchPattern(ctx) {
  const t = document.createElement('canvas');
  t.width = 12; t.height = 12;
  const c = t.getContext('2d');
  c.fillStyle = 'rgba(101, 129, 109, 0.1)';
  c.fillRect(0, 0, 12, 12);
  c.strokeStyle = 'rgba(7, 47, 55, 0.17)';
  c.lineWidth = 1.5;
  c.beginPath();
  c.moveTo(-3, 3); c.lineTo(3, -3);
  c.moveTo(0, 12); c.lineTo(12, 0);
  c.moveTo(9, 15); c.lineTo(15, 9);
  c.stroke();
  return ctx.createPattern(t, 'repeat');
}

function coverageNote() {
  const el = $('coverage-note');
  if (!cov || map.getZoom() < 10) { el.hidden = true; return; }
  // Share of the current view that only has approximate terrain.
  const b = map.getBounds();
  let hit = 0;
  let total = 0;
  for (let j = 0; j < cov.h; j++) {
    const lat = cov.box.n - ((j + 0.5) / cov.h) * (cov.box.n - cov.box.s);
    if (lat < b.getSouth() || lat > b.getNorth()) continue;
    for (let i = 0; i < cov.w; i++) {
      const lon = cov.box.w + ((i + 0.5) / cov.w) * (cov.box.e - cov.box.w);
      if (lon < b.getWest() || lon > b.getEast()) continue;
      total++;
      hit += cov.mask[j * cov.w + i];
    }
  }
  const share = total ? hit / total : 0;
  el.hidden = share < 0.01;
  el.textContent = share > 0.9
    ? 'Approximate terrain here (30 m data)'
    : 'Hatched: approximate terrain (30 m). Clear: detailed 5 m terrain.';
}

async function updateCoverage() {
  const b = map.getBounds();
  const view = { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() };
  if (map.getZoom() < 10) {
    if (cov && cov.layer) map.removeLayer(cov.layer);
    cov = null;
    coverageNote();
    return;
  }
  if (cov && contains(cov.box, view) && cov.box.e - cov.box.w < 4 * (view.e - view.w)) {
    coverageNote();
    return;
  }
  const id = ++covSeq;
  const mx = (view.e - view.w) * 0.6;
  const my = (view.n - view.s) * 0.6;
  const box = { s: view.s - my, w: view.w - mx, n: view.n + my, e: view.e + mx };
  let grid;
  try { grid = await loadCoverage(box, COV_N); } catch (e) { return; }
  if (id !== covSeq) return;
  const px = 14;
  const canvas = document.createElement('canvas');
  canvas.width = grid.w * px;
  canvas.height = grid.h * px;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = hatchPattern(ctx);
  let any = false;
  for (let j = 0; j < grid.h; j++) {
    for (let i = 0; i < grid.w; i++) {
      if (grid.mask[j * grid.w + i]) { ctx.fillRect(i * px, j * px, px, px); any = true; }
    }
  }
  if (cov && cov.layer) map.removeLayer(cov.layer);
  const layer = any
    ? L.imageOverlay(canvas.toDataURL(), [[box.s, box.w], [box.n, box.e]], { pane: 'coverage', interactive: false }).addTo(map)
    : null;
  cov = { box, w: grid.w, h: grid.h, mask: grid.mask, layer };
  coverageNote();
}

let covTimer = null;
map.on('moveend', () => {
  clearTimeout(covTimer);
  covTimer = setTimeout(updateCoverage, 400);
});
updateCoverage();

/* ---------- Cities ---------- */

function markCity() {
  const c = map.getCenter();
  for (const btn of document.querySelectorAll('.cities button')) {
    const city = CITIES[btn.dataset.city];
    btn.classList.toggle('on', dist(c.lat, c.lng, city.lat, city.lon) < 25000);
  }
}
for (const btn of document.querySelectorAll('.cities button')) {
  btn.addEventListener('click', () => {
    const city = CITIES[btn.dataset.city];
    try { localStorage.setItem('gentleway-city', btn.dataset.city); } catch (e) { /* ignore */ }
    map.setView([city.lat, city.lon], city.zoom);
  });
}
map.on('moveend', markCity);
markCity();

/* ---------- Choosing points ---------- */

function setPoint(which, lat, lon, label, silent) {
  pts[which] = { lat, lon, label };
  $(which === 'a' ? 'from' : 'to').value = label;
  if (!markers[which]) {
    markers[which] = L.marker([lat, lon], {
      draggable: true,
      icon: L.divIcon({ className: '', html: `<div class="marker-pin ${which}">${which.toUpperCase()}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
    }).addTo(map);
    markers[which].on('dragend', () => {
      const p = markers[which].getLatLng();
      setPoint(which, p.lat, p.lng, 'Pin on map');
    });
  } else {
    markers[which].setLatLng([lat, lon]);
  }
  if (!silent) go();
}

function clearPoint(which) {
  pts[which] = null;
  if (markers[which]) { map.removeLayer(markers[which]); markers[which] = null; }
  go();
}

function slopeHere(lat, lon) {
  if (!G) return '';
  const { node, d } = nearestNode(G, lat, lon);
  if (node < 0 || d > 30) return '';
  let best = null;
  for (const e of G.adj[node]) if (!best || Math.abs(e.g) > Math.abs(best.g)) best = e;
  if (!best) return '';
  const name = G.ways[best.w].name;
  const slope = best.f & STEPS ? 'steps' : Math.abs(best.g) < 0.01 ? 'flat here' : `about ${pct(best.g)} here`;
  return `<div class="here">${esc(name)}: ${slope}</div>`;
}

map.on('click', (ev) => {
  const { lat, lng } = ev.latlng;
  const el = document.createElement('div');
  el.innerHTML = `${slopeHere(lat, lng)}<div class="pick"><button class="a" type="button">Start here</button><button class="b" type="button">Go here</button></div>`;
  const popup = L.popup({ closeButton: false, offset: [0, -2] }).setLatLng(ev.latlng).setContent(el).openOn(map);
  el.querySelector('.a').addEventListener('click', () => { map.closePopup(popup); setPoint('a', lat, lng, 'Pin on map'); });
  el.querySelector('.b').addEventListener('click', () => { map.closePopup(popup); setPoint('b', lat, lng, 'Pin on map'); });
});

$('swap').addEventListener('click', () => {
  const { a, b } = pts;
  if (!a && !b) return;
  for (const k of ['a', 'b']) {
    pts[k] = null;
    if (markers[k]) { map.removeLayer(markers[k]); markers[k] = null; }
  }
  $('from').value = '';
  $('to').value = '';
  if (b) setPoint('a', b.lat, b.lon, b.label, true);
  if (a) setPoint('b', a.lat, a.lon, a.label, true);
  go();
});

/* ---------- Place search ---------- */

function wireSearch(inputId, listId, which) {
  const input = $(inputId);
  const list = $(listId);
  let timer = null;
  let seq = 0;
  let results = [];
  const pick = (r) => {
    list.innerHTML = '';
    const lat = Number(r.lat);
    const lon = Number(r.lon);
    setPoint(which, lat, lon, r.display_name.split(',').slice(0, 2).join(','));
    if (!(pts.a && pts.b)) map.setView([lat, lon], Math.max(map.getZoom(), 16));
    input.blur();
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) {
      list.innerHTML = '';
      if (pts[which]) clearPoint(which);
      return;
    }
    if (q.length < 3) return;
    timer = setTimeout(async () => {
      const my = ++seq;
      const b = map.getBounds().pad(1);
      const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5'
        + `&q=${encodeURIComponent(q)}&viewbox=${b.getWest()},${b.getNorth()},${b.getEast()},${b.getSouth()}`;
      try {
        const r = await fetch(url, { headers: { Accept: 'application/json' } });
        const j = await r.json();
        if (my !== seq) return;
        results = j;
        list.innerHTML = j.length
          ? j.map((x, i) => {
            const parts = x.display_name.split(',');
            return `<li data-i="${i}">${esc(parts[0])}<small>${esc(parts.slice(1, 4).join(',').trim())}</small></li>`;
          }).join('')
          : '<li><small>No places found</small></li>';
      } catch (e) {
        list.innerHTML = '<li><small>Search is unavailable. Tap the map instead.</small></li>';
      }
    }, 450);
  });
  list.addEventListener('pointerdown', (ev) => {
    const li = ev.target.closest('li[data-i]');
    if (li) { ev.preventDefault(); pick(results[Number(li.dataset.i)]); }
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && results.length && list.children.length) { ev.preventDefault(); pick(results[0]); }
    if (ev.key === 'Escape') list.innerHTML = '';
  });
  input.addEventListener('blur', () => setTimeout(() => { list.innerHTML = ''; }, 200));
}
wireSearch('from', 'from-suggest', 'a');
wireSearch('to', 'to-suggest', 'b');

/* ---------- My location ---------- */

let watchId = null;
let meMarker = null;
$('locate').addEventListener('click', () => {
  const btn = $('locate');
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
    btn.classList.remove('on');
    if (meMarker) { map.removeLayer(meMarker); meMarker = null; }
    return;
  }
  if (!navigator.geolocation) {
    status('This browser can\'t share your location.', 'error');
    return;
  }
  btn.classList.add('on');
  let first = true;
  watchId = navigator.geolocation.watchPosition((pos) => {
    const { latitude: lat, longitude: lon } = pos.coords;
    if (!meMarker) {
      meMarker = L.marker([lat, lon], {
        interactive: false, zIndexOffset: -100,
        icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
      }).addTo(map);
    } else {
      meMarker.setLatLng([lat, lon]);
    }
    if (first) {
      first = false;
      setPoint('a', lat, lon, 'My location');
      if (!pts.b) map.setView([lat, lon], 16);
    }
  }, (err) => {
    btn.classList.remove('on');
    watchId = null;
    status(err.code === 1 ? 'Location permission was declined. Search or tap the map instead.' : 'Couldn\'t get your location.', 'error');
  }, { enableHighAccuracy: true, maximumAge: 5000 });
});

$('handle').addEventListener('click', () => $('panel').classList.toggle('min'));

// Handy from the browser console: gentleWay.setPoint('a', lat, lon, 'label')
window.gentleWay = { map, setPoint, toggleSlopes, graph: () => G };
