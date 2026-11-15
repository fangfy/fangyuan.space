// Walking network built from OpenStreetMap ways, with a gradient on every ~15 m piece of street.

export const STEPS = 1;
export const UNEVEN = 2;
export const BUSY = 4;
export const NODATA = 8;
export const COARSE = 16; // slope taken from 30 m terrain rather than LiDAR

const RAD = Math.PI / 180;
const EARTH = 6371000;
const PIECE = 15; // max length of one graph edge, metres

export function dist(la1, lo1, la2, lo2) {
  const x = (lo2 - lo1) * RAD * Math.cos(((la1 + la2) / 2) * RAD);
  const y = (la2 - la1) * RAD;
  return Math.sqrt(x * x + y * y) * EARTH;
}

const WALK = new Set([
  'footway', 'path', 'pedestrian', 'steps', 'residential', 'living_street', 'service', 'unclassified',
  'tertiary', 'secondary', 'primary', 'tertiary_link', 'secondary_link', 'primary_link',
  'trunk', 'trunk_link', 'cycleway', 'track', 'corridor',
]);
const ROUGH_SURFACE = new Set([
  'unpaved', 'gravel', 'dirt', 'earth', 'ground', 'grass', 'sand', 'mud', 'rock', 'pebblestone',
  'cobblestone', 'unhewn_cobblestone', 'woodchips', 'grass_paver', 'stepping_stones',
]);
const ROUGH_SMOOTHNESS = new Set(['bad', 'very_bad', 'horrible', 'very_horrible', 'impassable']);
const FOOT_OK = new Set(['yes', 'designated', 'permissive']);
const KIND_NAME = {
  steps: 'Steps', footway: 'Footpath', path: 'Path', pedestrian: 'Pedestrian area', service: 'Service lane',
  cycleway: 'Shared path', track: 'Track', corridor: 'Indoor corridor',
};

export const OSM_HIGHWAY_FILTER = [...WALK].join('|');

function walkable(t) {
  if (!t || !WALK.has(t.highway) || t.area === 'yes') return false;
  const footOk = FOOT_OK.has(t.foot);
  if (t.foot === 'no' || t.foot === 'private') return false;
  if ((t.access === 'private' || t.access === 'no') && !footOk) return false;
  if (t.highway === 'service' && t.service === 'driveway') return false;
  if (t.highway === 'trunk' || t.highway === 'trunk_link') {
    const sw = t.sidewalk || t['sidewalk:both'] || t['sidewalk:left'] || t['sidewalk:right'];
    if (!footOk && !(sw && sw !== 'no' && sw !== 'none' && sw !== 'separate')) return false;
  }
  return true;
}

function wayFlags(t) {
  let f = 0;
  if (t.highway === 'steps') f |= STEPS;
  const noSurface = !t.surface;
  if (
    ROUGH_SURFACE.has(t.surface) || ROUGH_SMOOTHNESS.has(t.smoothness) || t.sac_scale
    || ((t.highway === 'path' || t.highway === 'track') && noSurface && !t.smoothness)
  ) f |= UNEVEN;
  if (/^(primary|secondary|trunk)/.test(t.highway)) f |= BUSY;
  return f;
}

// Linear interpolation of Z over monotonic S.
function interp(S, Z, s) {
  const n = S.length;
  if (s <= S[0]) return Z[0];
  if (s >= S[n - 1]) return Z[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (S[mid] <= s) lo = mid; else hi = mid;
  }
  const span = S[hi] - S[lo];
  return span > 0 ? Z[lo] + ((Z[hi] - Z[lo]) * (s - S[lo])) / span : Z[lo];
}

export function buildGraph(elements, elev) {
  const idMap = new Map();
  const lat = [];
  const lon = [];
  const adj = [];
  const ways = [];
  let virtualId = -1;
  const win = Math.max(10, elev.res * 0.8); // smoothing half-window along the street, metres

  const node = (id, la, lo) => {
    let i = idMap.get(id);
    if (i === undefined) {
      i = lat.length;
      idMap.set(id, i);
      lat.push(la); lon.push(lo); adj.push([]);
    }
    return i;
  };

  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || !el.nodes || !walkable(el.tags)) continue;
    const t = el.tags;
    const flags = wayFlags(t);

    // Densify so that long straight blocks are still measured piece by piece.
    const idx = [];
    let prev = null;
    for (let k = 0; k < el.geometry.length; k++) {
      const p = el.geometry[k];
      if (!p) { prev = null; continue; }
      if (prev) {
        const d = dist(prev.lat, prev.lon, p.lat, p.lon);
        const m = Math.ceil(d / PIECE);
        for (let j = 1; j < m; j++) {
          const f = j / m;
          idx.push(node(virtualId--, prev.lat + (p.lat - prev.lat) * f, prev.lon + (p.lon - prev.lon) * f));
        }
      }
      idx.push(node(el.nodes[k], p.lat, p.lon));
      prev = p;
    }
    if (idx.length < 2) continue;

    const n = idx.length;
    const S = new Array(n);
    const Z = new Array(n);
    const gap = new Array(n).fill(false);
    const coarse = new Array(n).fill(false);
    let lastGood = NaN;
    S[0] = 0;
    for (let k = 0; k < n; k++) {
      if (k > 0) S[k] = S[k - 1] + dist(lat[idx[k - 1]], lon[idx[k - 1]], lat[idx[k]], lon[idx[k]]);
      Z[k] = elev.sample(lat[idx[k]], lon[idx[k]]);
      if (Number.isNaN(Z[k])) { gap[k] = true; Z[k] = lastGood; } else lastGood = Z[k];
      coarse[k] = !elev.detailed(lat[idx[k]], lon[idx[k]]);
    }
    // Streets can run past the edge of the terrain we loaded: carry the nearest known height
    // into the gap (so it reads as flat) and mark those pieces as having no data.
    for (let k = n - 2; k >= 0; k--) if (Number.isNaN(Z[k])) Z[k] = Z[k + 1];
    const L = S[n - 1];
    const Zs = new Array(n);
    const spans = (t.bridge && t.bridge !== 'no') || (t.tunnel && t.tunnel !== 'no');
    if (Number.isNaN(Z[0])) {
      gap.fill(true);
      Zs.fill(0);
    } else if (spans) {
      // Terrain model follows the ground below a bridge or above a tunnel: assume an even ramp.
      for (let k = 0; k < n; k++) Zs[k] = Z[0] + ((Z[n - 1] - Z[0]) * S[k]) / (L || 1);
    } else {
      for (let k = 0; k < n; k++) {
        Zs[k] = (interp(S, Z, S[k] - win) + 2 * Z[k] + interp(S, Z, S[k] + win)) / 4;
      }
    }

    const w = ways.length;
    const grades = [];
    for (let k = 0; k < n - 1; k++) {
      const len = S[k + 1] - S[k];
      let g = len > 0.5 ? (Zs[k + 1] - Zs[k]) / len : 0;
      g = Math.max(-0.6, Math.min(0.6, g));
      grades.push(g);
      const a = idx[k];
      const b = idx[k + 1];
      if (a === b || len <= 0) continue;
      let f = gap[k] || gap[k + 1] ? flags | NODATA : flags;
      if (coarse[k] || coarse[k + 1]) f |= COARSE;
      adj[a].push({ to: b, len, g, f, w });
      adj[b].push({ to: a, len, g: -g, f, w });
    }
    ways.push({
      name: t.name || KIND_NAME[t.highway] || 'Unnamed street',
      named: !!t.name,
      kind: t.highway,
      f: flags,
      nodes: idx,
      grades,
    });
  }

  // Footpaths are usually mapped without a name. Borrow the name of the street they run beside.
  const cell = (la, lo) => Math.floor(la / 0.0003) + ',' + Math.floor(lo / 0.0004);
  const grid = new Map();
  ways.forEach((way, w) => {
    if (!way.named || way.kind === 'footway' || way.kind === 'path' || way.kind === 'steps') return;
    for (const i of way.nodes) {
      const key = cell(lat[i], lon[i]);
      let list = grid.get(key);
      if (!list) grid.set(key, (list = []));
      list.push(i, w);
    }
  });
  for (const way of ways) {
    if (way.named || !(way.kind === 'footway' || way.kind === 'path' || way.kind === 'cycleway')) continue;
    const votes = new Map();
    const samples = Math.min(5, way.nodes.length);
    for (let s = 0; s < samples; s++) {
      const i = way.nodes[Math.floor(((s + 0.5) / samples) * way.nodes.length)];
      let bestD = 22;
      let bestName = null;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const list = grid.get(cell(lat[i] + dy * 0.0003, lon[i] + dx * 0.0004));
          if (!list) continue;
          for (let k = 0; k < list.length; k += 2) {
            const d = dist(lat[i], lon[i], lat[list[k]], lon[list[k]]);
            if (d < bestD) { bestD = d; bestName = ways[list[k + 1]].name; }
          }
        }
      }
      if (bestName) votes.set(bestName, (votes.get(bestName) || 0) + 1);
    }
    for (const [name, count] of votes) {
      if (count * 2 > samples) way.name = `${name} (footpath)`;
    }
  }

  // Connected components, so we only snap to streets that link up with the rest of the network.
  const comp = new Int32Array(lat.length).fill(-1);
  let best = -1;
  let bestSize = 0;
  let c = 0;
  for (let s = 0; s < lat.length; s++) {
    if (comp[s] !== -1) continue;
    let size = 0;
    const stack = [s];
    comp[s] = c;
    while (stack.length) {
      const u = stack.pop();
      size++;
      for (const e of adj[u]) if (comp[e.to] === -1) { comp[e.to] = c; stack.push(e.to); }
    }
    if (size > bestSize) { bestSize = size; best = c; }
    c++;
  }

  return { lat, lon, adj, ways, comp, main: best, elev };
}

export function nearestNode(G, la, lo) {
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < G.lat.length; i++) {
    if (G.comp[i] !== G.main) continue;
    const d = dist(la, lo, G.lat[i], G.lon[i]);
    if (d < bd) { bd = d; best = i; }
  }
  return { node: best, d: bd };
}

// Effective gradient felt by the walker: downhill can be weighted as harder.
function felt(e, p) {
  return e.g < 0 ? -e.g * p.downFactor : e.g;
}

// Cost in "flat-metre equivalents". prefs = null gives plain distance.
export function edgeCost(e, p) {
  if (!p) return e.len;
  let pen = 0;
  if (e.f & STEPS) {
    pen += p.avoidSteps ? 60 : 2;
  } else {
    const r = felt(e, p) / p.maxGrade;
    pen += r <= 1 ? r * r : 1 + 12 * (r - 1) + 30 * (r - 1) * (r - 1);
  }
  if (e.f & UNEVEN) pen += p.avoidUneven ? 4 : 0.4;
  if (e.f & BUSY) pen += 0.15;
  return e.len * (1 + pen);
}

// A* search. Returns the list of edges with their start nodes, or null.
export function findRoute(G, src, dst, prefs) {
  const n = G.lat.length;
  const gScore = new Float64Array(n).fill(Infinity);
  const prevNode = new Int32Array(n).fill(-1);
  const prevEdge = new Array(n);
  const done = new Uint8Array(n);
  const hf = [];
  const hn = [];
  const push = (f, v) => {
    let i = hf.length;
    hf.push(f); hn.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hf[p] <= f) break;
      hf[i] = hf[p]; hn[i] = hn[p];
      i = p;
    }
    hf[i] = f; hn[i] = v;
  };
  const pop = () => {
    const top = hn[0];
    const f = hf.pop();
    const v = hn.pop();
    const len = hf.length;
    if (len > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= len) break;
        if (c + 1 < len && hf[c + 1] < hf[c]) c++;
        if (hf[c] >= f) break;
        hf[i] = hf[c]; hn[i] = hn[c];
        i = c;
      }
      hf[i] = f; hn[i] = v;
    }
    return top;
  };
  const h = (v) => dist(G.lat[v], G.lon[v], G.lat[dst], G.lon[dst]);

  gScore[src] = 0;
  push(h(src), src);
  while (hf.length) {
    const u = pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === dst) break;
    for (const e of G.adj[u]) {
      if (done[e.to]) continue;
      const cand = gScore[u] + edgeCost(e, prefs);
      if (cand < gScore[e.to]) {
        gScore[e.to] = cand;
        prevNode[e.to] = u;
        prevEdge[e.to] = e;
        push(cand + h(e.to), e.to);
      }
    }
  }
  if (src !== dst && prevNode[dst] === -1) return null;
  const steps = [];
  for (let v = dst; v !== src; v = prevNode[v]) steps.push({ from: prevNode[v], e: prevEdge[v] });
  steps.reverse();
  return steps;
}

// Gradient class: 0 flat, 1 gentle, 2 moderate, 3 steep, 4 very steep, 5 steps.
export function gradeClass(g, f) {
  if (f & STEPS) return 5;
  const a = Math.abs(g);
  return a < 0.03 ? 0 : a < 0.06 ? 1 : a < 0.1 ? 2 : a < 0.15 ? 3 : 4;
}

export function summarize(G, steps, src, prefs) {
  const out = {
    dist: 0, time: 0, climb: 0, descent: 0, maxUp: 0, maxDown: 0,
    over: 0, stepsLen: 0, unevenLen: 0, noData: 0, coarse: 0,
    worst: null, profile: [], legs: [],
  };
  let z = G.elev.sample(G.lat[src], G.lon[src]);
  if (Number.isNaN(z)) z = 0;
  out.profile.push({ d: 0, z, lat: G.lat[src], lon: G.lon[src], g: 0, c: 0 });
  let worstR = 1;
  let leg = null;
  for (const { e } of steps) {
    const dz = e.g * e.len;
    const way = G.ways[e.w];
    out.dist += e.len;
    if (e.f & STEPS) {
      out.stepsLen += e.len;
      out.time += e.len / 0.35;
    } else {
      // Tobler's hiking function, slowed to a cautious pace.
      out.time += e.len / ((6 * Math.exp(-3.5 * Math.abs(e.g + 0.05)) / 3.6) * 0.75);
      if (e.g > out.maxUp) out.maxUp = e.g;
      if (-e.g > out.maxDown) out.maxDown = -e.g;
      const r = felt(e, prefs) / prefs.maxGrade;
      if (r > 1) {
        out.over += e.len;
        if (r > worstR) { worstR = r; out.worst = way.name; }
      }
    }
    if (dz > 0) out.climb += dz; else out.descent -= dz;
    if (e.f & UNEVEN) out.unevenLen += e.len;
    if (e.f & NODATA) out.noData += e.len;
    else if (e.f & COARSE) out.coarse += e.len;
    z += dz;
    out.profile.push({ d: out.dist, z, lat: G.lat[e.to], lon: G.lon[e.to], g: e.g, c: gradeClass(e.g, e.f) });

    if (!leg || leg.name !== way.name) {
      leg = { name: way.name, len: 0, maxUp: 0, maxDown: 0, f: 0 };
      out.legs.push(leg);
    }
    leg.len += e.len;
    leg.f |= e.f;
    if (!(e.f & STEPS)) {
      if (e.g > leg.maxUp) leg.maxUp = e.g;
      if (-e.g > leg.maxDown) leg.maxDown = -e.g;
    }
  }
  return out;
}
