"use strict";

/**
 * board_gen.js (MOTIF + STRUCT ANCHORED FINALIZE)
 *
 * Key changes (per your spec):
 *  - Introduce STRUCT sites as rule-based motifs (no jitter).
 *  - STRUCT count is EXACTLY the sum of motif point counts.
 *  - Motif plan (global, max 4 motifs; here 1/2/3 motifs):
 *      * P=20: pick one motif type in {1,2,3}, place ONE motif in the largest macro region.
 *      * P=50: TWO motifs: motif3 + (motif1 or motif2), placed in the two largest macro regions.
 *      * P=100: pick one type in {1,2,3} globally, place THREE motifs (same type), one per macro region.
 *  - STRUCT total <= floor(0.4*P) enforced by budgeted parameter sampling (no endless retries).
 *  - Macro/Micro points are pushed out of motif "avoid zones" (no rejection).
 *  - King bubble avoids moving STRUCT and never selects king from STRUCT.
 *  - FINALIZE order: Lloyd relax (STRUCT anchored) -> enforceMinDistance (STRUCT anchored).
 *
 * Requires:
 *  1) d3-delaunay loaded (global d3.Delaunay)
 *  2) rng.js loaded (window.JC.makeRng / shuffleInPlace)
 *
 * Exposes:
 *  window.JC.buildBoard(config, size) -> { cells }
 */

(function (global) {
  const JC = (global.JC = global.JC || {});
  const makeRng = JC.makeRng;
  const shuffleInPlace = JC.shuffleInPlace;

  if (typeof makeRng !== "function" || typeof shuffleInPlace !== "function") {
    throw new Error("board_gen.js: missing rng.js (window.JC.makeRng / shuffleInPlace).");
  }
  if (!global.d3 || !global.d3.Delaunay) {
    throw new Error("board_gen.js: missing d3-delaunay (global d3.Delaunay).");
  }

  // -------------------------
  // basic utils
  // -------------------------
  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function polygonArea(poly) {
    let a = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      a += xj * yi - xi * yj;
    }
    return Math.abs(a) * 0.5;
  }

  function polygonCentroid(poly) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      const f = xj * yi - xi * yj;
      a += f;
      cx += (xj + xi) * f;
      cy += (yj + yi) * f;
    }
    a *= 0.5;
    if (Math.abs(a) < 1e-9) return poly[Math.floor(poly.length / 2)] || [0, 0];
    cx /= 6 * a;
    cy /= 6 * a;
    return [cx, cy];
  }

  function cleanD3Polygon(poly) {
    if (!poly || poly.length < 3) return null;
    const cleaned = poly.slice();
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (first && last && first[0] === last[0] && first[1] === last[1]) cleaned.pop();
    return cleaned;
  }

  // -------------------------
  // Half-plane clipping: a*x + b*y <= c
  // -------------------------
  function isInsidePlane(p, plane, eps = 1e-9) {
    const v = plane.a * p[0] + plane.b * p[1] - plane.c;
    return v <= eps;
  }

  function intersectSegPlane(s, e, plane) {
    const sx = s[0], sy = s[1];
    const ex = e[0], ey = e[1];
    const dx = ex - sx, dy = ey - sy;

    const denom = plane.a * dx + plane.b * dy;
    if (Math.abs(denom) < 1e-12) return [sx, sy];

    const t = (plane.c - (plane.a * sx + plane.b * sy)) / denom;
    const tt = clamp(t, 0, 1);
    return [sx + tt * dx, sy + tt * dy];
  }

  function clipPolyByPlane(poly, plane) {
    if (!poly || poly.length < 3) return null;
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const s = poly[i];
      const e = poly[(i + 1) % poly.length];
      const sIn = isInsidePlane(s, plane);
      const eIn = isInsidePlane(e, plane);

      if (eIn) {
        if (!sIn) out.push(intersectSegPlane(s, e, plane));
        out.push(e);
      } else if (sIn) {
        out.push(intersectSegPlane(s, e, plane));
      }
    }
    return out.length >= 3 ? out : null;
  }

  function clipPolyByPlanes(poly, planes) {
    let p = poly;
    for (const pl of planes) {
      p = clipPolyByPlane(p, pl);
      if (!p) return null;
    }
    return p;
  }

  function isInsideAllPlanes(p, planes) {
    for (const pl of planes) {
      if (!isInsidePlane(p, pl)) return false;
    }
    return true;
  }

  // Deterministically bring point inside by bisection along segment from an interior point
  function clampToPlanesByBisection(p, insidePoint, planes) {
    if (isInsideAllPlanes(p, planes)) return p;

    let lo = insidePoint; // inside
    let hi = p;

    for (let i = 0; i < 32; i++) {
      const mid = [(lo[0] + hi[0]) * 0.5, (lo[1] + hi[1]) * 0.5];
      if (isInsideAllPlanes(mid, planes)) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  // Distance to each plane boundary (inside slack / ||n||), take min
  function minPlaneDistance(p, planes) {
    let best = Infinity;
    for (const pl of planes) {
      const denom = Math.hypot(pl.a, pl.b) || 1;
      const slack = pl.c - (pl.a * p[0] + pl.b * p[1]); // inside means slack >= 0
      const d = slack / denom;
      if (d < best) best = d;
    }
    return best;
  }

  // Move p toward insidePoint until minPlaneDistance >= margin (deterministic, no rejection)
  function moveTowardInsideToSatisfyMargin(p, insidePoint, planes, margin) {
    let q = p;
    for (let i = 0; i < 28; i++) {
      if (minPlaneDistance(q, planes) >= margin) return q;
      q = [(q[0] + insidePoint[0]) * 0.5, (q[1] + insidePoint[1]) * 0.5];
    }
    return q;
  }

  // -------------------------
  // Random parallel lines with hard minimum widths (NO retry)
  // -------------------------
  function generateParallelLines(size, rand) {
    const DEG = Math.PI / 180;
    const thetaMax = 18 * DEG;

    const theta = Math.PI / 2 + (rand() * 2 - 1) * thetaMax;
    const nx = Math.cos(theta);
    const ny = Math.sin(theta);

    const corners = [
      [0, 0],
      [size, 0],
      [size, size],
      [0, size],
    ];
    let minT = Infinity, maxT = -Infinity;
    for (const [x, y] of corners) {
      const t = nx * x + ny * y;
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
    }
    const L = maxT - minT;

    const minFrac = 0.18;
    const minW = minFrac * L;
    const rem = L - 3 * minW;

    const eps = 1e-6;
    const r0 = rand() + eps, r1 = rand() + eps, r2 = rand() + eps;
    const rs = r0 + r1 + r2;

    const w0 = minW + (rem * r0) / rs;
    const w1 = minW + (rem * r1) / rs;

    const t1 = minT + w0;
    const t2 = minT + w0 + w1;

    return { nx, ny, t1, t2 };
  }

  function makeSquarePlanes(size) {
    return [
      { a: -1, b: 0, c: 0 },       // x >= 0
      { a: 1, b: 0, c: size },     // x <= size
      { a: 0, b: -1, c: 0 },       // y >= 0
      { a: 0, b: 1, c: size },     // y <= size
    ];
  }

  function makeRegionPlanes(size, lines) {
    const sq = makeSquarePlanes(size);
    const { nx, ny, t1, t2 } = lines;

    const left = sq.concat([{ a: nx, b: ny, c: t1 }]);
    const mid = sq.concat([
      { a: -nx, b: -ny, c: -t1 },
      { a: nx, b: ny, c: t2 },
    ]);
    const right = sq.concat([{ a: -nx, b: -ny, c: -t2 }]);

    return { left, mid, right };
  }

  function regionPolyFromPlanes(size, planes) {
    const square = [
      [0, 0],
      [size, 0],
      [size, size],
      [0, size],
    ];
    const poly = clipPolyByPlanes(square, planes);
    return poly && poly.length >= 3 ? poly : square;
  }

  // -------------------------
  // Convex polygon uniform sampling (triangulate fan at v0)
  // -------------------------
  function triArea(a, b, c) {
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const acx = c[0] - a[0], acy = c[1] - a[1];
    return Math.abs(abx * acy - aby * acx) * 0.5;
  }

  function samplePointInTriangle(a, b, c, rand) {
    let r1 = rand();
    let r2 = rand();
    if (r1 + r2 > 1) {
      r1 = 1 - r1;
      r2 = 1 - r2;
    }
    return [
      a[0] + r1 * (b[0] - a[0]) + r2 * (c[0] - a[0]),
      a[1] + r1 * (b[1] - a[1]) + r2 * (c[1] - a[1]),
    ];
  }

  function makeFanTriangles(poly) {
    const v0 = poly[0];
    const tris = [];
    let total = 0;
    for (let i = 1; i + 1 < poly.length; i++) {
      const a = v0, b = poly[i], c = poly[i + 1];
      const area = triArea(a, b, c);
      if (area > 1e-12) {
        tris.push({ a, b, c, area });
        total += area;
      }
    }
    return { tris, total };
  }

  function sampleUniformInConvexPoly(poly, triCache, rand) {
    const { tris, total } = triCache;
    if (!tris.length || total <= 0) return polygonCentroid(poly);

    let r = rand() * total;
    for (let i = 0; i < tris.length; i++) {
      const t = tris[i];
      r -= t.area;
      if (r <= 0 || i === tris.length - 1) return samplePointInTriangle(t.a, t.b, t.c, rand);
    }
    return samplePointInTriangle(tris[0].a, tris[0].b, tris[0].c, rand);
  }

  // -------------------------
  // Avoid-zones (soft constraint): push point out (NO rejection)
  // zone: {cx, cy, r}
  // -------------------------
  function pushOutOfZones(p, zones, rand) {
    if (!zones || zones.length === 0) return p;

    let x = p[0], y = p[1];

    // one pass is usually enough because zones are placed with clearance
    for (let t = 0; t < zones.length; t++) {
      const z = zones[t];
      const dx = x - z.cx;
      const dy = y - z.cy;
      const d = Math.hypot(dx, dy);

      if (d < z.r) {
        // deterministic direction if extremely close
        let ux, uy;
        if (d < 1e-9) {
          const ang = rand() * Math.PI * 2;
          ux = Math.cos(ang);
          uy = Math.sin(ang);
        } else {
          ux = dx / d;
          uy = dy / d;
        }
        const rr = z.r + 1e-6;
        x = z.cx + ux * rr;
        y = z.cy + uy * rr;
      }
    }

    return [x, y];
  }

  // -------------------------
  // Duplicate nudging (skip fixed points)
  // -------------------------
  function nudgeDuplicatesWithinPlanes(points, planes, insidePoint, rand, fixedMask) {
    const seen = new Map(); // key -> first index
    for (let i = 0; i < points.length; i++) {
      let [x, y] = points[i];
      let key = `${Math.round(x * 1000)}_${Math.round(y * 1000)}`;

      if (!seen.has(key)) {
        seen.set(key, i);
        continue;
      }

      // If current is fixed, try to move the earlier non-fixed one (best effort)
      const j = seen.get(key);
      const iFixed = fixedMask ? !!fixedMask[i] : false;
      const jFixed = fixedMask ? !!fixedMask[j] : false;

      // Choose which index to nudge: prefer non-fixed
      let k = i;
      if (iFixed && !jFixed) k = j;
      else if (iFixed && jFixed) {
        // both fixed; leave them (should be extremely rare for motifs)
        continue;
      }

      let tries = 0;
      let px = points[k][0], py = points[k][1];
      let kkey = `${Math.round(px * 1000)}_${Math.round(py * 1000)}`;

      while (seen.has(kkey) && tries < 24) {
        px = px + (rand() - 0.5) * 0.8;
        py = py + (rand() - 0.5) * 0.8;
        const clamped = clampToPlanesByBisection([px, py], insidePoint, planes);
        px = clamped[0];
        py = clamped[1];
        kkey = `${Math.round(px * 1000)}_${Math.round(py * 1000)}`;
        tries++;
      }

      points[k] = [px, py];
      seen.set(kkey, k);
    }
    return points;
  }

  // -------------------------
  // Min-distance enforcement (FINAL GUARANTEE)
  // - ALL points participate (including STRUCT/motif).
  // - Avoid-zones are soft and only applied to NON-STRUCT points.
  // - IMPORTANT: the LAST operation is a pure minDist sweep (no zones, no nudge),
  //   so the returned points satisfy minDist much more reliably.
  // -------------------------
  function enforceMinDistanceAnchored(points, fixedMask, minDist, planes, insidePoint, zones, rand) {
    const n = points.length;
    if (n <= 1 || !(minDist > 0)) return points;

    const min2 = minDist * minDist;
    const passes = 5;

    function clampIn(p) {
      return clampToPlanesByBisection(p, insidePoint, planes);
    }

    // One sweep of pairwise separation; optionally apply zones for NON-STRUCT points.
    function separationSweep(applyZones) {
      for (let i = 0; i < n; i++) {
        let pi = points[i];

        for (let j = i + 1; j < n; j++) {
          let pj = points[j];

          let dx = pj[0] - pi[0];
          let dy = pj[1] - pi[1];
          let d2 = dx * dx + dy * dy;
          if (d2 >= min2) continue;

          let d = Math.sqrt(d2);
          let ux, uy;
          if (d < 1e-9) {
            const ang = rand() * Math.PI * 2;
            ux = Math.cos(ang);
            uy = Math.sin(ang);
            d = 0;
          } else {
            ux = dx / d;
            uy = dy / d;
          }

          const need = (minDist - d);
          const push = need * 0.5;

          let ai = [pi[0] - ux * push, pi[1] - uy * push];
          let aj = [pj[0] + ux * push, pj[1] + uy * push];

          ai = clampIn(ai);
          aj = clampIn(aj);

          if (applyZones && zones && zones.length) {
            if (!(fixedMask && fixedMask[i])) {
              ai = pushOutOfZones(ai, zones, rand);
              ai = clampIn(ai);
            }
            if (!(fixedMask && fixedMask[j])) {
              aj = pushOutOfZones(aj, zones, rand);
              aj = clampIn(aj);
            }
          }

          points[i] = ai;
          points[j] = aj;
          pi = ai;
          pj = aj;
        }
      }
    }

    // Main passes: zones first (soft), then separation, then de-dup.
    for (let pass = 0; pass < passes; pass++) {
      // Soft zones: keep NON-STRUCT out before separation (can help stability)
      if (zones && zones.length) {
        for (let i = 0; i < n; i++) {
          if (fixedMask && fixedMask[i]) continue;
          let q = pushOutOfZones(points[i], zones, rand);
          q = clampIn(q);
          points[i] = q;
        }
      }

      separationSweep(false);

      // De-dup: allow ALL points to move; this might break minDist temporarily,
      // so we will fix it in later sweeps and in the final guarantee sweeps.
      nudgeDuplicatesWithinPlanes(points, planes, insidePoint, rand, null);

      // After de-dup, do a separation sweep again (still not final guarantee)
      separationSweep(false);
    }

    // FINAL GUARANTEE: last operations are pure separation sweeps
    // (no zones, no de-dup) so returned points are not modified afterwards.
    separationSweep(false);
    separationSweep(false);

    return points;
  }



  function minDistFromArea(area, m, factor) {
    if (m <= 1) return 0;
    const avg = Math.sqrt(area / m);
    return factor * avg;
  }

  // -------------------------
  // King bubble (FINAL STEP, can break motifs)
  // - King can be ANY point (including motif/STRUCT).
  // - King push affects ALL other points (including motif/STRUCT).
  // - Does NOT guarantee minDist (leave that to Lloyd / enforceMinDistance).
  // - Does NOT apply pushOutOfZones (since motifs may be destroyed and this is final).
  // -------------------------
  function applyKingBubbleAnchored(points, fixedMask, planes, insidePoint, regionArea, strength, zones, rand) {
    const n = points.length;
    if (n < 2) return points;

    // king can be ANY point (including motif/STRUCT)
    const kingIdx = Math.floor(rand() * n);
    const king = points[kingIdx];

    const avg = Math.sqrt(regionArea / Math.max(1, n));
    const R = avg * strength;
    const keep = 0.85;

    for (let i = 0; i < n; i++) {
      if (i === kingIdx) continue;

      const p = points[i];
      let dx = p[0] - king[0];
      let dy = p[1] - king[1];
      let d = Math.hypot(dx, dy);

      if (d < 1e-9) {
        // coincident: kick it out to radius R in a random direction
        const ang = rand() * Math.PI * 2;
        let np = [king[0] + Math.cos(ang) * R, king[1] + Math.sin(ang) * R];
        np = clampToPlanesByBisection(np, insidePoint, planes);
        points[i] = np;
        continue;
      }

      if (d < R) {
        const ux = dx / d, uy = dy / d;
        const newD = d + (R - d) * keep;
        let np = [king[0] + ux * newD, king[1] + uy * newD];
        np = clampToPlanesByBisection(np, insidePoint, planes);
        points[i] = np;
      }
    }

    // optional, but helps avoid exact duplicates / degeneracy; allow ALL points to move
    nudgeDuplicatesWithinPlanes(points, planes, insidePoint, rand, null);
    return points;
  }

  // -------------------------
  // Constrained Lloyd in a region (STRUCT anchored)
  // -------------------------
  function lloydRelaxInRegionAnchored(points, fixedMask, size, iters, regionPlanes, regionInsidePoint, zones, rand) {
    let pts = points;
    for (let t = 0; t < iters; t++) {
      const delaunay = d3.Delaunay.from(pts);
      const voronoi = delaunay.voronoi([0, 0, size, size]);

      const nextPts = [];
      for (let i = 0; i < pts.length; i++) {
        if (fixedMask && fixedMask[i]) {
          nextPts.push(pts[i]); // keep STRUCT
          continue;
        }

        const raw = voronoi.cellPolygon(i);
        const cleaned = cleanD3Polygon(raw);
        if (!cleaned || cleaned.length < 3) {
          nextPts.push(pts[i]);
          continue;
        }

        const clipped = clipPolyByPlanes(cleaned, regionPlanes);
        if (!clipped || clipped.length < 3) {
          nextPts.push(pts[i]);
          continue;
        }

        let c = polygonCentroid(clipped);
        if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) {
          nextPts.push(pts[i]);
          continue;
        }

        c = clampToPlanesByBisection(c, regionInsidePoint, regionPlanes);
        c = pushOutOfZones(c, zones, rand);
        c = clampToPlanesByBisection(c, regionInsidePoint, regionPlanes);
        nextPts.push(c);
      }

      pts = nudgeDuplicatesWithinPlanes(nextPts, regionPlanes, regionInsidePoint, rand, fixedMask);

      // keep free points out of zones (soft)
      if (zones && zones.length) {
        for (let i = 0; i < pts.length; i++) {
          if (fixedMask && fixedMask[i]) continue;
          let q = pushOutOfZones(pts[i], zones, rand);
          q = clampToPlanesByBisection(q, regionInsidePoint, regionPlanes);
          pts[i] = q;
        }
      }
    }
    return pts;
  }

  // -------------------------
  // Voronoi cells with hard clip
  // -------------------------
  function makeFallbackTriangle(pt, size) {
    const [x, y] = pt;
    const d = Math.max(1.1, size * 0.002);
    return [
      [x - d, y - d],
      [x + d, y - d],
      [x, y + d],
    ];
  }

  function buildCellsForRegion(points, size, regionPlanes) {
    const delaunay = d3.Delaunay.from(points);
    const voronoi = delaunay.voronoi([0, 0, size, size]);

    const cells = [];
    for (let i = 0; i < points.length; i++) {
      const raw = voronoi.cellPolygon(i);
      let cleaned = cleanD3Polygon(raw);

      if (!cleaned || cleaned.length < 3) cleaned = makeFallbackTriangle(points[i], size);

      let clipped = clipPolyByPlanes(cleaned, regionPlanes);
      if (!clipped || clipped.length < 3) {
        const fb = makeFallbackTriangle(points[i], size);
        clipped = clipPolyByPlanes(fb, regionPlanes) || fb;
      }

      if (!clipped || clipped.length < 3) {
        const [x, y] = points[i];
        clipped = [
          [clamp(x - 1, 0, size), clamp(y - 1, 0, size)],
          [clamp(x + 1, 0, size), clamp(y - 1, 0, size)],
          [clamp(x + 1, 0, size), clamp(y + 1, 0, size)],
          [clamp(x - 1, 0, size), clamp(y + 1, 0, size)],
        ];
      }

      cells.push({
        poly: clipped,
        centroid: polygonCentroid(clipped),
      });
    }
    return cells;
  }

  // -------------------------
  // Piece allocation by region area (with minimum 1 each when possible)
  // -------------------------
  function allocateByArea(totalN, areas) {
    const keys = Object.keys(areas);
    const sumA = keys.reduce((s, k) => s + areas[k], 0);

    if (totalN <= 0) return { left: 0, mid: 0, right: 0 };
    if (totalN === 1) return { left: 0, mid: 1, right: 0 };
    if (totalN === 2) return { left: 1, mid: 0, right: 1 };

    const baseMin = 1;
    let remain = totalN - 3 * baseMin;

    const base = { left: baseMin, mid: baseMin, right: baseMin };
    const frac = [];

    for (const k of keys) {
      const x = (remain * areas[k]) / (sumA || 1);
      const f = Math.floor(x);
      base[k] += f;
      frac.push({ k, r: x - f });
    }

    let used = base.left + base.mid + base.right;
    let extra = totalN - used;

    frac.sort((p, q) => q.r - p.r);
    let idx = 0;
    while (extra > 0) {
      const pick = frac[idx % frac.length].k;
      base[pick] += 1;
      extra--;
      idx++;
    }

    while (base.left + base.mid + base.right > totalN) {
      // take from the currently largest region if possible
      let k = "mid";
      if (areas.left >= areas.mid && areas.left >= areas.right) k = "left";
      else if (areas.right >= areas.left && areas.right >= areas.mid) k = "right";
      if (base[k] > 1) base[k] -= 1;
      else if (base.mid > 1) base.mid -= 1;
      else if (base.left > 1) base.left -= 1;
      else if (base.right > 1) base.right -= 1;
      else break;
    }

    return base;
  }

  // -------------------------
  // Motifs: type 1/2/3
  //  1: regular n-gon (n in [3,8])
  //  2: regular n-gon + center (n in [3,8]) => n+1 points
  //  3: k x n grid (k in {1,2,3}, n in [3,5]) => k*n points
  // No jitter.
  // -------------------------
  function motifMinPoints(type) {
    if (type === 1) return 3;
    if (type === 2) return 4;
    return 3; // type 3
  }

  function chooseMotifParam(type, maxPoints, rand) {
    maxPoints = Math.max(0, maxPoints | 0);

    if (type === 1) {
      // regular n-gon, n in [3,8], count = n
      const nMax = Math.min(8, maxPoints);
      const n = 3 + Math.floor(rand() * Math.max(1, nMax - 3 + 1));
      return { type: 1, n, count: n };
    }

    if (type === 2) {
      // regular n-gon + center, n in [3,8], count = n+1
      const nMax = Math.min(8, maxPoints - 1);
      const n = 3 + Math.floor(rand() * Math.max(1, nMax - 3 + 1));
      return { type: 2, n, count: n + 1 };
    }

    // type === 3: k x n grid, k in {1,2,3}, n in [3,5], count = k*n
    const feasible = [];
    for (let k = 1; k <= 3; k++) {
      for (let n = 3; n <= 5; n++) {
        const c = k * n;
        if (c <= maxPoints) feasible.push({ k, n, c });
      }
    }

    // In your pipeline maxPoints is guaranteed >= motifMinPoints(type), so feasible should not be empty.
    if (!feasible.length) return { type: 3, k: 1, n: 3, count: 3 };

    const pick = feasible[Math.floor(rand() * feasible.length)];
    return { type: 3, k: pick.k, n: pick.n, count: pick.c };
  }

  // Create motif points and avoid zone in a region
  function buildMotifInRegion(region, motifParam, rand) {
    const { planes, inside, poly, triCache, area, allocN } = region;
    const avg = Math.sqrt(area / Math.max(1, allocN));

    const extra = avg * 0.9;          // clearance to boundary
    const avoidMargin = avg * 1.15;   // push-away ring for macro/micro

    // pick a random center, then deterministically move inward to satisfy margin
    let c = sampleUniformInConvexPoly(poly, triCache, rand);
    c = clampToPlanesByBisection(c, inside, planes);

    let extentTarget = avg * 2.6;
    if (motifParam.type === 1 || motifParam.type === 2) {
      // larger n -> a bit larger extent
      extentTarget = avg * (2.4 + 0.12 * (motifParam.n - 3));
    } else {
      // grid: extent depends on k,n and spacing
      // initial spacing target
      const spacingTarget = avg * 1.45;
      const halfW = spacingTarget * (motifParam.n - 1) * 0.5;
      const halfH = spacingTarget * (motifParam.k - 1) * 0.5;
      extentTarget = Math.hypot(halfW, halfH);
    }

    // enforce boundary clearance by moving center inward (no retry)
    c = moveTowardInsideToSatisfyMargin(c, inside, planes, extentTarget + extra);

    // compute allowed extent at this center (may need shrink)
    const allow = Math.max(0, minPlaneDistance(c, planes) - extra);
    const extent = Math.min(extentTarget, allow > 1e-6 ? allow : extentTarget * 0.6);

    const phi = rand() * Math.PI * 2;

    const pts = [];
    let motifExtent = extent;

    if (motifParam.type === 1 || motifParam.type === 2) {
      // regular n-gon on circle of radius=extent
      const n = motifParam.n;
      const r = extent;
      motifExtent = r;

      for (let i = 0; i < n; i++) {
        const ang = phi + (2 * Math.PI * i) / n;
        const x = c[0] + Math.cos(ang) * r;
        const y = c[1] + Math.sin(ang) * r;
        const q = clampToPlanesByBisection([x, y], inside, planes);
        pts.push(q);
      }
      if (motifParam.type === 2) {
        pts.push([c[0], c[1]]);
      }
    } else {
      // grid k x n with spacing (scaled to match extent)
      const k = motifParam.k;
      const n = motifParam.n;

      const spacingTarget = avg * 1.45;
      const halfW0 = spacingTarget * (n - 1) * 0.5;
      const halfH0 = spacingTarget * (k - 1) * 0.5;
      const extent0 = Math.hypot(halfW0, halfH0) || 1;

      const scale = clamp(extent / extent0, 0.5, 1.0);
      const spacing = spacingTarget * scale;

      const cos = Math.cos(phi);
      const sin = Math.sin(phi);

      const x0 = -(n - 1) * 0.5 * spacing;
      const y0 = -(k - 1) * 0.5 * spacing;

      let maxR = 0;

      for (let row = 0; row < k; row++) {
        for (let col = 0; col < n; col++) {
          const lx = x0 + col * spacing;
          const ly = y0 + row * spacing;
          const rx = lx * cos - ly * sin;
          const ry = lx * sin + ly * cos;
          const x = c[0] + rx;
          const y = c[1] + ry;
          const q = clampToPlanesByBisection([x, y], inside, planes);
          pts.push(q);
          maxR = Math.max(maxR, Math.hypot(rx, ry));
        }
      }
      motifExtent = maxR;
    }

    // avoid zone for macro/micro
    const zone = { cx: c[0], cy: c[1], r: motifExtent + avoidMargin };

    return { structPts: pts, avoidZone: zone };
  }

  // -------------------------
  // Generate macro/micro (counts are explicit; avoid zones; no rejection)
  // -------------------------
  function pickCentersMaximin(candidates, kUse, rand) {
    if (kUse <= 1) return [candidates[Math.floor(rand() * candidates.length)]];

    const cand = candidates.slice();
    const centers = [];

    // first center random
    let idx0 = Math.floor(rand() * cand.length);
    centers.push(cand[idx0]);
    cand.splice(idx0, 1);

    for (let k = 1; k < kUse; k++) {
      let bestIdx = 0;
      let bestScore = -1;

      for (let i = 0; i < cand.length; i++) {
        const p = cand[i];
        let minD2 = Infinity;
        for (let s = 0; s < centers.length; s++) {
          const dx = p[0] - centers[s][0];
          const dy = p[1] - centers[s][1];
          const d2 = dx * dx + dy * dy;
          if (d2 < minD2) minD2 = d2;
        }
        const score = minD2 + 1e-12 * rand();
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }

      centers.push(cand[bestIdx]);
      cand.splice(bestIdx, 1);
      if (cand.length === 0) break;
    }

    return centers;
  }

  function generateNonStructPoints(macroCount, microCount, region, zones, rand, params) {
    const { poly, triCache, planes, inside } = region;

    const ptsMacro = [];
    for (let i = 0; i < macroCount; i++) {
      let p = sampleUniformInConvexPoly(poly, triCache, rand);
      p = pushOutOfZones(p, zones, rand);
      p = clampToPlanesByBisection(p, inside, planes);
      ptsMacro.push(p);
    }

    // micro centers: from a fresh candidate pool (better spread, no rejection)
    const K = clamp(2 + Math.floor(rand() * 3), 2, 4); // 2..4
    const kUse = Math.min(K, Math.max(1, macroCount || 1));

    const candN = Math.max(32, kUse * 16);
    const candidates = [];
    for (let t = 0; t < candN; t++) {
      let p = sampleUniformInConvexPoly(poly, triCache, rand);
      p = pushOutOfZones(p, zones, rand);
      p = clampToPlanesByBisection(p, inside, planes);
      candidates.push(p);
    }
    const centers = pickCentersMaximin(candidates, kUse, rand);

    const pts = [];
    // include macros first
    for (const p of ptsMacro) pts.push(p);

    // micros
    for (let i = 0; i < microCount; i++) {
      let p = sampleUniformInConvexPoly(poly, triCache, rand);
      p = clampToPlanesByBisection(p, inside, planes);

      const c = centers[Math.floor(rand() * centers.length)];
      const lam = Math.pow(rand(), params.alpha); // skew toward 0 -> closer to center
      let q = [c[0] + lam * (p[0] - c[0]), c[1] + lam * (p[1] - c[1])];

      q = pushOutOfZones(q, zones, rand);
      q = clampToPlanesByBisection(q, inside, planes);
      pts.push(q);
    }

    return pts;
  }

  // -------------------------
  // Build motif plan (global) per your rules
  // -------------------------
  function pickMotifType123(rand) {
    const r = Math.floor(rand() * 3); // 0,1,2
    return r === 0 ? 1 : (r === 1 ? 2 : 3);
  }

  function buildMotifPlan(pieceCount, rand) {
    const P = pieceCount;

    if (P === 20) {
      return [{ type: pickMotifType123(rand) }]; // one motif
    }
    if (P === 50) {
      return [
        { type: 3 }, // must include motif3
        { type: rand() < 0.5 ? 1 : 2 },
      ];
    }
    if (P === 100) {
      // You asked: for 100 pieces, ALWAYS use motif types 1,2,3 exactly once each.
      // Shuffle so the mapping to macro regions depends on the seed.
      const types = [1, 2, 3];
      for (let i = types.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const tmp = types[i];
        types[i] = types[j];
        types[j] = tmp;
      }
      return types.map((t) => ({ type: t }));
    }

    // Fallback (shouldn't happen with your UI):
    if (P <= 30) return [{ type: pickMotifType123(rand) }];
    if (P <= 70) return [{ type: 3 }, { type: rand() < 0.5 ? 1 : 2 }];
    const t = pickMotifType123(rand);
    return [{ type: t }, { type: t }, { type: t }];
  }

  // -------------------------
  // Main entry
  // -------------------------
  function buildBoard(config, size) {
    const { rand } = makeRng(config.seedStr);
    const N = Math.max(1, config.pieceCount | 0);

    // FINALIZE config
    const relaxIters =
      typeof config.relaxIters === "number" && Number.isFinite(config.relaxIters)
        ? Math.max(0, config.relaxIters | 0)
        : 1;

    // non-struct micro behavior (higher micro ratio per your request)
    const params = {
      microFrac: 0.88, // used for non-struct remainder
      alpha: 3.0,
    };

    // min distance (final pass)
    const minDistFactor = 0.6;

    // king bubble (before finalize)
    const kingStrength = 20;

    // 1) parallel lines
    const lines = generateParallelLines(size, rand);

    // 2) region planes and polygons
    const planes = makeRegionPlanes(size, lines);

    const polyL = regionPolyFromPlanes(size, planes.left);
    const polyM = regionPolyFromPlanes(size, planes.mid);
    const polyR = regionPolyFromPlanes(size, planes.right);

    const areaL = polygonArea(polyL);
    const areaM = polygonArea(polyM);
    const areaR = polygonArea(polyR);

    const insideL = polygonCentroid(polyL);
    const insideM = polygonCentroid(polyM);
    const insideR = polygonCentroid(polyR);

    // 3) allocate piece counts by region area
    const alloc = allocateByArea(N, { left: areaL, mid: areaM, right: areaR });

    // region descriptors
    const regionL = {
      key: "left", planes: planes.left, poly: polyL, inside: insideL, area: areaL,
      triCache: makeFanTriangles(polyL), allocN: alloc.left,
    };
    const regionM = {
      key: "mid", planes: planes.mid, poly: polyM, inside: insideM, area: areaM,
      triCache: makeFanTriangles(polyM), allocN: alloc.mid,
    };
    const regionR = {
      key: "right", planes: planes.right, poly: polyR, inside: insideR, area: areaR,
      triCache: makeFanTriangles(polyR), allocN: alloc.right,
    };

    const regions = [regionL, regionM, regionR];

    // 4) motif plan (global)
    const motifPlan = buildMotifPlan(N, rand);

    // decide which regions receive motifs (by area rank)
    const byArea = regions.slice().sort((a, b) => b.area - a.area);

    // For P=20: 1 motif -> largest region
    // For P=50: 2 motifs -> largest and 2nd largest
    // For P=100: 3 motifs -> each region (largest,2nd,3rd) (same type)
    const targetRegions = byArea.slice(0, Math.min(motifPlan.length, 3));

    // 5) Determine motif params with global budget S <= floor(0.4N), respecting per-region capacity
    const Smax = Math.floor(0.4 * N);
    let usedS = 0;

    // storage per region
    const regionStruct = { left: [], mid: [], right: [] };
    const regionZones = { left: [], mid: [], right: [] };

    // sequential budgeted assignment: each target region gets exactly one motif
    for (let i = 0; i < motifPlan.length; i++) {
      const type = motifPlan[i].type;
      const reg = targetRegions[i];
      if (!reg) break;

      const minP = motifMinPoints(type);

      // reserve minimal points for remaining motifs
      let minRemain = 0;
      for (let j = i + 1; j < motifPlan.length; j++) minRemain += motifMinPoints(motifPlan[j].type);

      // per-region capacity: do not exceed allocN; try to keep at least a tiny remainder if possible
      const cap = Math.max(0, reg.allocN | 0);
      const leave = Math.min(2, Math.max(0, cap - minP)); // leave up to 2 non-struct points if possible
      const capMax = Math.max(minP, cap - leave);

      const budgetMax = Math.max(minP, Smax - usedS - minRemain);
      const maxPoints = Math.min(capMax, budgetMax);

      const param = chooseMotifParam(type, maxPoints, rand);
      usedS += param.count;

      const built = buildMotifInRegion(reg, param, rand);
      regionStruct[reg.key] = built.structPts;
      regionZones[reg.key].push(built.avoidZone);
    }

    // 6) Build points per region: STRUCT first, then macro/micro on remainder
    function buildRegionPoints(region) {
      const key = region.key;
      const structPts = regionStruct[key] || [];
      const S = structPts.length;
      const m = Math.max(0, region.allocN | 0);
      const zones = regionZones[key] || [];

      const remain = Math.max(0, m - S);
      let microCount = Math.round(remain * params.microFrac);
      microCount = clamp(microCount, 0, remain);
      let macroCount = remain - microCount;

      // ensure at least 1 macro if we have remaining points (stable centers)
      if (remain > 0 && macroCount === 0) {
        macroCount = 1;
        microCount = remain - 1;
      }

      const nonStruct = generateNonStructPoints(macroCount, microCount, region, zones, rand, params);

      const pts = structPts.concat(nonStruct);
      const fixedMask = new Array(pts.length).fill(false);
      for (let i = 0; i < S; i++) fixedMask[i] = true;

      // final clamp + de-dup
      for (let i = 0; i < pts.length; i++) {
        pts[i] = clampToPlanesByBisection(pts[i], region.inside, region.planes);
      }
      nudgeDuplicatesWithinPlanes(pts, region.planes, region.inside, rand, fixedMask);

      return { pts, fixedMask, zones };
    }

    let L = buildRegionPoints(regionL);
    let M = buildRegionPoints(regionM);
    let R = buildRegionPoints(regionR);

    // // 7) King bubble: always pick the largest-area region (L/M/R)
    // let pick = "M";
    // let bestA = regionM.area;

    // if (regionL.area > bestA) { bestA = regionL.area; pick = "L"; }
    // if (regionR.area > bestA) { bestA = regionR.area; pick = "R"; }

    // // (Optional safety) only apply if the chosen region has enough points
    // if (pick === "L") {
    //   if (L.pts.length >= 2) {
    //     L.pts = applyKingBubbleAnchored(L.pts, L.fixedMask, regionL.planes, regionL.inside, regionL.area, kingStrength, L.zones, rand);
    //   }
    // } else if (pick === "M") {
    //   if (M.pts.length >= 2) {
    //     M.pts = applyKingBubbleAnchored(M.pts, M.fixedMask, regionM.planes, regionM.inside, regionM.area, kingStrength, M.zones, rand);
    //   }
    // } else {
    //   if (R.pts.length >= 2) {
    //     R.pts = applyKingBubbleAnchored(R.pts, R.fixedMask, regionR.planes, regionR.inside, regionR.area, kingStrength, R.zones, rand);
    //   }
    // }

    // 8) FINALIZE: Lloyd (STRUCT anchored) -> enforceMinDistance (STRUCT anchored)
    if (relaxIters > 0) {
      L.pts = lloydRelaxInRegionAnchored(L.pts, L.fixedMask, size, relaxIters, regionL.planes, regionL.inside, L.zones, rand);
      M.pts = lloydRelaxInRegionAnchored(M.pts, M.fixedMask, size, relaxIters, regionM.planes, regionM.inside, M.zones, rand);
      R.pts = lloydRelaxInRegionAnchored(R.pts, R.fixedMask, size, relaxIters, regionR.planes, regionR.inside, R.zones, rand);
    }

    L.pts = enforceMinDistanceAnchored(
      L.pts, L.fixedMask,
      minDistFromArea(regionL.area, L.pts.length, minDistFactor),
      regionL.planes, regionL.inside, L.zones, rand
    );
    M.pts = enforceMinDistanceAnchored(
      M.pts, M.fixedMask,
      minDistFromArea(regionM.area, M.pts.length, minDistFactor),
      regionM.planes, regionM.inside, M.zones, rand
    );
    R.pts = enforceMinDistanceAnchored(
      R.pts, R.fixedMask,
      minDistFromArea(regionR.area, R.pts.length, minDistFactor),
      regionR.planes, regionR.inside, R.zones, rand
    );

    // 9) build clipped cells for each region (hard boundary)
    const cellsL = buildCellsForRegion(L.pts, size, regionL.planes);
    const cellsM = buildCellsForRegion(M.pts, size, regionM.planes);
    const cellsR = buildCellsForRegion(R.pts, size, regionR.planes);

    const cellsAll = cellsL.concat(cellsM, cellsR);

    // deterministic fix (should not happen): truncate/pad
    if (cellsAll.length !== N) {
      while (cellsAll.length > N) cellsAll.pop();
      while (cellsAll.length < N) {
        const p = insideM;
        const fb = makeFallbackTriangle(p, size);
        const clipped = clipPolyByPlanes(fb, planes.mid) || fb;
        cellsAll.push({ poly: clipped, centroid: polygonCentroid(clipped) });
      }
    }

    // 10) shuffle numbering globally
    const nums = Array.from({ length: N }, (_, i) => i + 1);
    shuffleInPlace(nums, rand);
    for (let i = 0; i < N; i++) cellsAll[i].num = nums[i];

    return { cells: cellsAll };
  }

  JC.buildBoard = buildBoard;
})(window);
