// Shape recognition for "hold the pen still to snap": line, polyline (e.g. axes),
// circle/ellipse, triangle, rectangle/quadrilateral, polygon.
// Input: raw points [[x, y, pressure], ...]. Output: { type, pts } with dense points, or null.

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const DEG = Math.PI / 180;

function pathLength(p) {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += dist(p[i - 1], p[i]);
  return L;
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

// Ramer-Douglas-Peucker simplification
function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const a = pts[0], b = pts[pts.length - 1];
  let idx = -1, dmax = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = segDist(pts[i], a, b);
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax <= eps) return [a, b];
  const left = rdp(pts.slice(0, idx + 1), eps);
  const right = rdp(pts.slice(idx), eps);
  return left.slice(0, -1).concat(right);
}

// mean distance from points to a polyline
function polyError(pts, poly) {
  let s = 0;
  for (const p of pts) {
    let m = Infinity;
    for (let i = 1; i < poly.length; i++) m = Math.min(m, segDist(p, poly[i - 1], poly[i]));
    s += m;
  }
  return s / pts.length;
}

function bboxDiag(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return Math.hypot(x1 - x0, y1 - y0);
}

// Snap direction a->b to a multiple of `stepDeg` if within tolerance
function snapDir(a, b, stepDeg = 45, tolDeg = 7) {
  const L = dist(a, b);
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const step = stepDeg * DEG;
  const r = Math.round(ang / step) * step;
  if (Math.abs(ang - r) < tolDeg * DEG) return [a[0] + L * Math.cos(r), a[1] + L * Math.sin(r)];
  return b;
}

function densify(vertices, step = 2) {
  const out = [];
  for (let i = 1; i < vertices.length; i++) {
    const a = vertices[i - 1], b = vertices[i];
    const n = Math.max(1, Math.ceil(dist(a, b) / step));
    for (let k = 0; k < n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n, 0.5]);
  }
  const last = vertices[vertices.length - 1];
  out.push([last[0], last[1], 0.5]);
  return out;
}

// Orientation, centre and semi-axes via principal axes of the point cloud
function fitEllipse(pts) {
  let cx = 0, cy = 0;
  for (const [x, y] of pts) { cx += x; cy += y; }
  cx /= pts.length; cy /= pts.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pts) { const dx = x - cx, dy = y - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  let theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  // nearly axis-aligned -> snap orientation
  const near = Math.round(theta / (Math.PI / 2)) * (Math.PI / 2);
  if (Math.abs(theta - near) < 10 * DEG) theta = near;
  const c = Math.cos(theta), s = Math.sin(theta);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [x, y] of pts) {
    const u = (x - cx) * c + (y - cy) * s, v = -(x - cx) * s + (y - cy) * c;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  let a = (u1 - u0) / 2, b = (v1 - v0) / 2;
  const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
  const ex = cx + uc * c - vc * s, ey = cy + uc * s + vc * c;
  if (Math.abs(a - b) / Math.max(a, b) < 0.15) a = b = (a + b) / 2; // circle
  let err = 0;
  for (const [x, y] of pts) {
    const u = (x - ex) * c + (y - ey) * s, v = -(x - ex) * s + (y - ey) * c;
    const r = Math.hypot(u / a, v / b);
    err += Math.abs(r - 1) * (a + b) / 2;
  }
  return { cx: ex, cy: ey, a, b, theta, err: err / pts.length, circle: a === b };
}

function ellipsePoints({ cx, cy, a, b, theta }) {
  const n = Math.max(48, Math.round(Math.PI * (a + b) / 2));
  const c = Math.cos(theta), s = Math.sin(theta);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * 2 * Math.PI;
    const u = a * Math.cos(t), v = b * Math.sin(t);
    out.push([cx + u * c - v * s, cy + u * s + v * c, 0.5]);
  }
  return out;
}

// drop vertices where the path hardly turns (e.g. the start point in the middle of an edge)
function dropStraightVertices(poly, minTurnDeg = 28) {
  const n = poly.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = poly[(i - 1 + n) % n], q = poly[i], r = poly[(i + 1) % n];
    const a1 = Math.atan2(q[1] - p[1], q[0] - p[0]), a2 = Math.atan2(r[1] - q[1], r[0] - q[0]);
    let turn = Math.abs(a2 - a1);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if (turn > minTurnDeg * DEG) out.push(q);
  }
  return out;
}

function interiorAngles(poly) {
  const n = poly.length;
  return poly.map((q, i) => {
    const p = poly[(i - 1 + n) % n], r = poly[(i + 1) % n];
    const v1 = [p[0] - q[0], p[1] - q[1]], v2 = [r[0] - q[0], r[1] - q[1]];
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2));
    return Math.acos(Math.max(-1, Math.min(1, cos))) / DEG;
  });
}

function fitRectangle(corners) {
  // orientation from the longest edge, snapped to the axes when close
  let best = 0, theta = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4];
    const L = dist(a, b);
    if (L > best) { best = L; theta = Math.atan2(b[1] - a[1], b[0] - a[0]); }
  }
  const near = Math.round(theta / (Math.PI / 2)) * (Math.PI / 2);
  if (Math.abs(theta - near) < 10 * DEG) theta = near;
  const c = Math.cos(theta), s = Math.sin(theta);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [x, y] of corners) {
    const u = x * c + y * s, v = -x * s + y * c;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const P = (u, v) => [u * c - v * s, u * s + v * c];
  return [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)];
}

// ---------------------------------------------------------------------------------------------
// Tidy a figure region: long near-straight strokes become exact lines (axes snapped to horizontal/
// vertical), strokes made of a few straight segments become clean polylines, small V-shapes at the
// end of a line become symmetric arrowheads, other long strokes (curves) are smoothed.
// Small strokes (labels, ticks, text) are left as written.
// Returns [{s, after:{pts, shape}}] for Board.applyEdits.

function resample(pts, step) {
  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    let a = pts[i - 1];
    const b = pts[i];
    let d = dist(a, b);
    while (carry + d >= step) {
      const t = (step - carry) / d;
      a = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      out.push(a);
      d = dist(a, b);
      carry = 0;
    }
    carry += d;
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function smoothCurve(pts, passes = 5, win = 4) {
  let p = resample(pts, 4);
  for (let k = 0; k < passes; k++) {
    p = p.map((q, i) => {
      if (i === 0 || i === p.length - 1) return q;
      let sx = 0, sy = 0, n = 0;
      for (let j = Math.max(0, i - win); j <= Math.min(p.length - 1, i + win); j++) { sx += p[j][0]; sy += p[j][1]; n++; }
      return [sx / n, sy / n];
    });
  }
  return p.map(([x, y]) => [x, y, 0.5]);
}

export function straightenFigure(strokes) {
  if (!strokes.length) return [];
  const all = strokes.flatMap(s => s.raw || s.pts);
  const D = bboxDiag(all);
  const changes = [];
  const ends = []; // line ends that may carry an arrowhead: {tip, dir}
  const small = [];

  for (const s of strokes) {
    const pts = (s.raw || s.pts).map(p => [p[0], p[1]]);
    const L = pathLength(pts);
    if (bboxDiag(pts) < 0.18 * D || L < 30) { small.push(s); continue; }
    const a = pts[0], b = pts[pts.length - 1];
    let maxDev = 0;
    for (const p of pts) maxDev = Math.max(maxDev, segDist(p, a, b));
    if (maxDev < Math.max(4, 0.045 * L)) {
      const b2 = snapDir(a, b, 90, 10);
      changes.push({ s, after: { pts: densify([a, b2]), shape: 'tidy' } });
      const d = [b2[0] - a[0], b2[1] - a[1]], n = Math.hypot(...d);
      ends.push({ tip: b2, dir: [d[0] / n, d[1] / n] }, { tip: a, dir: [-d[0] / n, -d[1] / n] });
      continue;
    }
    const simp = rdp(pts, Math.max(5, 0.03 * L));
    // a real polyline has sharp corners (axes "L", arrow drawn in one go); a gentle curve does not
    const sharp = simp.length >= 3 && simp.slice(1, -1).every((q, i) => {
      const p = simp[i], r = simp[i + 2];
      let turn = Math.abs(Math.atan2(r[1] - q[1], r[0] - q[0]) - Math.atan2(q[1] - p[1], q[0] - p[0]));
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      return turn > 40 * DEG;
    });
    if (sharp && simp.length <= 6 && polyError(pts, simp) < Math.max(3, 0.02 * L)) {
      // long segments (axes) snap to horizontal/vertical; short ones (arrowhead arms) keep their direction
      const v = [simp[0]];
      for (let i = 1; i < simp.length; i++) {
        const seg = dist(simp[i - 1], simp[i]);
        const target = seg > 0.25 * L ? snapDir(simp[i - 1], simp[i], 90, 10) : simp[i];
        v.push([v[i - 1][0] + target[0] - simp[i - 1][0], v[i - 1][1] + target[1] - simp[i - 1][1]]);
      }
      changes.push({ s, after: { pts: densify(v), shape: 'tidy' } });
      continue;
    }
    changes.push({ s, after: { pts: smoothCurve(pts), shape: 'tidy' } });
  }

  // separate small V-shaped strokes at a line end -> symmetric arrowhead
  for (const s of small) {
    const pts = (s.raw || s.pts).map(p => [p[0], p[1]]);
    const v = rdp(pts, Math.max(2, 0.08 * pathLength(pts)));
    if (v.length !== 3) continue;
    const apex = v[1];
    const end = ends.find(e => dist(e.tip, apex) < Math.max(18, 0.05 * D));
    if (!end) continue;
    const arm = (dist(v[0], apex) + dist(v[2], apex)) / 2;
    const back = [-end.dir[0], -end.dir[1]];
    const rot = (u, t) => [u[0] * Math.cos(t) - u[1] * Math.sin(t), u[0] * Math.sin(t) + u[1] * Math.cos(t)];
    const l = rot(back, 28 * DEG), r = rot(back, -28 * DEG);
    const tip = end.tip;
    const head = [[tip[0] + l[0] * arm, tip[1] + l[1] * arm], tip, [tip[0] + r[0] * arm, tip[1] + r[1] * arm]];
    changes.push({ s, after: { pts: densify(head), shape: 'tidy' } });
  }
  return changes;
}

export function recognize(raw) {
  const pts = raw.map(p => [p[0], p[1]]);
  const L = pathLength(pts);
  if (L < 24) return null;
  const size = bboxDiag(pts);
  const gap = dist(pts[0], pts[pts.length - 1]);
  const closed = gap < Math.max(16, 0.2 * L) && size > 2 * gap;

  if (!closed) {
    // straight line
    const a = pts[0], b = pts[pts.length - 1];
    let maxDev = 0;
    for (const p of pts) maxDev = Math.max(maxDev, segDist(p, a, b));
    if (maxDev < Math.max(3, 0.05 * L)) {
      return { type: 'line', pts: densify([a, snapDir(a, b)]) };
    }
    // polyline with a few straight segments (axes, arrows drawn in one stroke, zig-zags)
    const simp = rdp(pts, Math.max(4, 0.035 * L));
    if (simp.length <= 5 && polyError(pts, simp) < Math.max(2.5, 0.02 * L)) {
      const v = [simp[0]];
      for (let i = 1; i < simp.length; i++) {
        // keep each segment's length, snap its direction to horizontal/vertical/45°
        const prevRaw = simp[i - 1], curRaw = simp[i];
        const snapped = snapDir(prevRaw, curRaw);
        const d = [snapped[0] - prevRaw[0], snapped[1] - prevRaw[1]];
        v.push([v[i - 1][0] + d[0], v[i - 1][1] + d[1]]);
      }
      return { type: 'polyline', pts: densify(v) };
    }
    return null;
  }

  // closed shapes: compare ellipse fit with polygon fit, keep the better one
  const loop = pts.concat([pts[0]]);
  const ell = fitEllipse(pts);
  let poly = rdp(loop, Math.max(4, 0.04 * L)).slice(0, -1);
  poly = poly.length >= 3 ? dropStraightVertices(poly) : poly;
  let polyErr = Infinity;
  if (poly.length >= 3 && poly.length <= 6) polyErr = polyError(loop, poly.concat([poly[0]]));

  const eNorm = ell.err / size, pNorm = polyErr / size;
  const limit = 0.04;
  if (eNorm < limit && eNorm <= pNorm) {
    return { type: ell.circle ? 'circle' : 'ellipse', pts: ellipsePoints(ell) };
  }
  if (pNorm < limit) {
    if (poly.length === 4) {
      const ang = interiorAngles(poly);
      if (ang.every(a => Math.abs(a - 90) < 18)) {
        const r = fitRectangle(poly);
        return { type: 'rectangle', pts: densify(r.concat([r[0]])) };
      }
    }
    const name = { 3: 'triangle', 4: 'quadrilateral' }[poly.length] || 'polygon';
    return { type: name, pts: densify(poly.concat([poly[0]])) };
  }
  return null;
}
