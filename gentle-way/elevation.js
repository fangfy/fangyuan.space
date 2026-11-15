// Elevation sources.
// 1. Geoscience Australia 5 m LiDAR DEM (WCS, GeoTIFF float32), wherever it has a survey.
// 2. Geoscience Australia 1-second (30 m) national DEM, vegetation removed, for the rest of Australia.
// 3. Terrarium terrain tiles (global, ~30 m SRTM in most places) for the rest of the world.

const LIDAR = {
  name: 'GA LiDAR 5 m',
  url: 'https://services.ga.gov.au/gis/services/DEM_LiDAR_5m_2025/MapServer/WCSServer',
  crs: 'EPSG:4283', dx: 5.5063478e-5, dy: 5.1601233e-5, zeroIsGap: true,
};
const DEM1S = {
  name: 'GA national 30 m',
  url: 'https://services.ga.gov.au/gis/services/DEM_SRTM_1Second_2024/MapServer/WCSServer',
  crs: 'EPSG:4326', dx: 2.7777778e-4, dy: 2.7777778e-4, zeroIsGap: false,
};
const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

// Minimal reader for uncompressed 32-bit float GeoTIFFs (tiled or stripped).
function parseFloatTiff(buf) {
  const dv = new DataView(buf);
  const order = dv.getUint16(0);
  const le = order === 0x4949;
  if (!le && order !== 0x4d4d) throw new Error('Not a TIFF');
  if (dv.getUint16(2, le) !== 42) throw new Error('Not a TIFF');
  const ifd = dv.getUint32(4, le);
  const n = dv.getUint16(ifd, le);
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 11: 4, 12: 8 };
  const tags = {};
  for (let i = 0; i < n; i++) {
    const p = ifd + 2 + i * 12;
    const tag = dv.getUint16(p, le);
    const type = dv.getUint16(p + 2, le);
    const count = dv.getUint32(p + 4, le);
    const sz = SIZE[type];
    if (!sz) continue;
    const off = count * sz <= 4 ? p + 8 : dv.getUint32(p + 8, le);
    const vals = [];
    for (let k = 0; k < count; k++) {
      const q = off + k * sz;
      vals.push(
        type === 3 ? dv.getUint16(q, le)
        : type === 4 ? dv.getUint32(q, le)
        : type === 12 ? dv.getFloat64(q, le)
        : type === 11 ? dv.getFloat32(q, le)
        : dv.getUint8(q)
      );
    }
    tags[tag] = vals;
  }
  const w = tags[256][0];
  const h = tags[257][0];
  const compression = tags[259] ? tags[259][0] : 1;
  if (compression !== 1 || tags[258][0] !== 32 || !tags[339] || tags[339][0] !== 3) {
    throw new Error('Unsupported TIFF encoding');
  }
  const read = (off, count) => {
    if (le) return new Float32Array(buf.slice(off, off + count * 4));
    const a = new Float32Array(count);
    for (let i = 0; i < count; i++) a[i] = dv.getFloat32(off + i * 4, false);
    return a;
  };
  const out = new Float32Array(w * h);
  if (tags[324]) {
    const tw = tags[322][0];
    const th = tags[323][0];
    const across = Math.ceil(w / tw);
    tags[324].forEach((off, t) => {
      const tx = (t % across) * tw;
      const ty = Math.floor(t / across) * th;
      const data = read(off, tw * th);
      const cw = Math.min(tw, w - tx);
      const ch = Math.min(th, h - ty);
      for (let r = 0; r < ch; r++) out.set(data.subarray(r * tw, r * tw + cw), (ty + r) * w + tx);
    });
  } else {
    const rps = tags[278] ? tags[278][0] : h;
    tags[273].forEach((off, s) => {
      const y0 = s * rps;
      const rows = Math.min(rps, h - y0);
      out.set(read(off, rows * w), y0 * w);
    });
  }
  return { w, h, data: out, scale: tags[33550], tie: tags[33922] };
}

// Bilinear sampler over a grid; toXY maps (lat, lon) to fractional pixel centres.
function gridSampler(data, w, h, toXY) {
  return (lat, lon) => {
    const [fx, fy] = toXY(lat, lon);
    if (fx < -1 || fy < -1 || fx > w || fy > h) return NaN;
    const x = Math.min(Math.max(fx, 0), w - 1);
    const y = Math.min(Math.max(fy, 0), h - 1);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, w - 1);
    const y1 = Math.min(y0 + 1, h - 1);
    const tx = x - x0;
    const ty = y - y0;
    const a = data[y0 * w + x0];
    const b = data[y0 * w + x1];
    const c = data[y1 * w + x0];
    const d = data[y1 * w + x1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
}

const inAustralia = (b) => b.w > 112 && b.e < 154.5 && b.s > -44.5 && b.n < -9;

// One GeoTIFF grid from a Geoscience Australia WCS. Returns null where the service has nothing.
async function fetchGrid(svc, b, w, h) {
  const url = `${svc.url}?service=WCS&request=GetCoverage&version=1.0.0&coverage=1&CRS=${svc.crs}`
    + `&BBOX=${b.w},${b.s},${b.e},${b.n}&WIDTH=${w}&HEIGHT=${h}&FORMAT=GeoTIFF`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(svc.name + ' HTTP ' + r.status);
  if (!(r.headers.get('content-type') || '').includes('tif')) throw new Error(svc.name + ': unexpected reply');
  const buf = await r.arrayBuffer();
  if (buf.byteLength < 2000) return null; // an empty stub: no coverage anywhere in the box
  return parseFloatTiff(buf);
}

async function loadWcs(svc, b) {
  let w = Math.ceil((b.e - b.w) / svc.dx);
  let h = Math.ceil((b.n - b.s) / svc.dy);
  const k = Math.max(1, w / 2400, h / 2400);
  w = Math.max(2, Math.round(w / k));
  h = Math.max(2, Math.round(h / k));
  const t = await fetchGrid(svc, b, w, h);
  if (!t) throw new Error(svc.name + ': no coverage here');
  const sx = t.scale ? t.scale[0] : (b.e - b.w) / t.w;
  const sy = t.scale ? t.scale[1] : (b.n - b.s) / t.h;
  const lon0 = t.tie ? t.tie[3] : b.w;
  const lat0 = t.tie ? t.tie[4] : b.n;
  let bad = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < t.data.length; i++) {
    const v = t.data[i];
    // The LiDAR mosaic writes exactly 0 where it has no survey (and over water).
    if (!(v > -200 && v < 9000) || (svc.zeroIsGap && v === 0)) { t.data[i] = NaN; bad++; continue; }
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (bad === t.data.length || max - min < 0.01) throw new Error(svc.name + ': no coverage here');
  return {
    sample: gridSampler(t.data, t.w, t.h, (lat, lon) => [(lon - lon0) / sx - 0.5, (lat0 - lat) / sy - 0.5]),
    gaps: bad / t.data.length,
  };
}

// Where is detailed (LiDAR) terrain missing on land? Coarse grid for shading the map.
// Returns {w, h, mask} with mask[row * w + col] = 1 for "approximate terrain only", row 0 at the north.
export async function loadCoverage(b, n) {
  if (!inAustralia(b)) return { w: 1, h: 1, mask: new Uint8Array([1]) };
  const [lidar, land] = await Promise.all([
    fetchGrid(LIDAR, b, n, n).catch(() => null),
    fetchGrid(DEM1S, b, n, n).catch(() => null),
  ]);
  const mask = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) {
    const z = lidar && lidar.w === n && lidar.h === n ? lidar.data[i] : 0;
    const hasLidar = z > -200 && z < 9000 && z !== 0;
    const g = land && land.w === n && land.h === n ? land.data[i] : 100;
    const isLand = g > 1 && g < 9000;
    mask[i] = !hasLidar && isLand ? 1 : 0;
  }
  return { w: n, h: n, mask };
}

const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** z;
};

async function loadTerrarium(b) {
  let z = 15;
  let x0, x1, y0, y1;
  for (;;) {
    x0 = Math.floor(lon2x(b.w, z)); x1 = Math.floor(lon2x(b.e, z));
    y0 = Math.floor(lat2y(b.n, z)); y1 = Math.floor(lat2y(b.s, z));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 60 || z <= 12) break;
    z--;
  }
  const nx = x1 - x0 + 1;
  const ny = y1 - y0 + 1;
  const W = nx * 256;
  const H = ny * 256;
  const data = new Float32Array(W * H).fill(NaN);
  const jobs = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      jobs.push((async () => {
        const r = await fetch(`${TERRARIUM}/${z}/${x}/${y}.png`);
        if (!r.ok) return;
        const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
        const c = document.createElement('canvas');
        c.width = 256; c.height = 256;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bmp, 0, 0);
        const px = ctx.getImageData(0, 0, 256, 256).data;
        const ox = (x - x0) * 256;
        const oy = (y - y0) * 256;
        for (let j = 0; j < 256; j++) {
          for (let i = 0; i < 256; i++) {
            const p = (j * 256 + i) * 4;
            data[(oy + j) * W + ox + i] = px[p] * 256 + px[p + 1] + px[p + 2] / 256 - 32768;
          }
        }
      })());
    }
  }
  await Promise.all(jobs);
  return {
    sample: gridSampler(data, W, H, (lat, lon) => [
      (lon2x(lon, z) - x0) * 256 - 0.5,
      (lat2y(lat, z) - y0) * 256 - 0.5,
    ]),
  };
}

// b = {s, w, n, e}. Returns {sample(lat, lon) -> metres, detailed(lat, lon) -> bool, label, res}.
export async function loadElevation(b) {
  if (inAustralia(b)) {
    let lidar = null;
    let coarse = null;
    try { lidar = await loadWcs(LIDAR, b); } catch (e) { console.info(e.message); }
    let coarseName = 'Geoscience Australia 30 m national model';
    if (!lidar || lidar.gaps > 0.001) {
      // No survey, or holes in it (water, edge of a survey): use the national 30 m model there.
      try {
        coarse = await loadWcs(DEM1S, b);
      } catch (e) {
        console.info(e.message);
        try { coarse = await loadTerrarium(b); coarseName = 'global 30 m terrain'; } catch (e2) { /* none */ }
      }
    }
    if (lidar || coarse) {
      const mostlyLidar = lidar && lidar.gaps < 0.5;
      return {
        res: mostlyLidar ? 5 : 30,
        label: lidar
          ? 'Geoscience Australia 5 m LiDAR' + (coarse ? `, with the ${coarseName.replace('Geoscience Australia ', '')} where LiDAR is missing` : '')
          : `${coarseName} (no LiDAR survey here, so slopes are approximate)`,
        sample: (lat, lon) => {
          const v = lidar ? lidar.sample(lat, lon) : NaN;
          return Number.isNaN(v) && coarse ? coarse.sample(lat, lon) : v;
        },
        detailed: (lat, lon) => (lidar ? !Number.isNaN(lidar.sample(lat, lon)) : false),
      };
    }
  }
  const t = await loadTerrarium(b);
  return {
    res: 30,
    label: 'global 30 m terrain (coarser, so slopes are approximate)',
    sample: t.sample,
    detailed: () => false,
  };
}
