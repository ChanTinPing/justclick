"use strict";

/**
 * board_gen.js (NEW)
 * - Hard partitions the square into 3 convex regions by two random parallel lines.
 * - In each region: generate non-uniform sites (NO rejection sampling), optional constrained Lloyd (default 1),
 *   then compute Voronoi and CLIP each cell to the region half-planes (so the two lines are HARD boundaries).
 *
 * Requires:
 *  1) d3-delaunay loaded (global d3.Delaunay)
 *  2) rng.js loaded (window.JC.makeRng / shuffleInPlace)
 *
 * Exposes:
 *  window.JC.buildBoard(config, size) -> { cells }
 *
 * config:
 *  - seedStr: string
 *  - pieceCount: integer
 *  - relaxIters: optional int (default 1)   // constrained Lloyd inside each region
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
  function dot(ax, ay, bx, by) {
    return ax * bx + ay * by;
  }

  function polygonArea(poly) {
    // unsigned area
    let a = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      a += xj * yi - xi * yj;
    }
    return Math.abs(a) * 0.5;
  }

  function polygonCentroid(poly) {
    let a = 0,
      cx = 0,
      cy = 0;
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
    // d3 Voronoi cellPolygon often repeats first vertex as last; remove it.
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
    const sx = s[0],
      sy = s[1];
    const ex = e[0],
      ey = e[1];
    const dx = ex - sx,
      dy = ey - sy;

    const denom = plane.a * dx + plane.b * dy;
    if (Math.abs(denom) < 1e-12) {
      // Segment nearly parallel; return s (best effort, deterministic).
      return [sx, sy];
    }
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

  // If point is outside convex region, deterministically bring it inside by bisection
  // along segment from an interior point.
  function clampToPlanesByBisection(p, insidePoint, planes) {
    if (isInsideAllPlanes(p, planes)) return p;

    let lo = insidePoint; // guaranteed inside
    let hi = p;

    for (let i = 0; i < 32; i++) {
      const mid = [(lo[0] + hi[0]) * 0.5, (lo[1] + hi[1]) * 0.5];
      if (isInsideAllPlanes(mid, planes)) lo = mid;
      else hi = mid;
    }
    return lo;
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

    // project square corners onto n to get [minT, maxT]
    const corners = [
      [0, 0],
      [size, 0],
      [size, size],
      [0, size],
    ];
    let minT = Infinity,
      maxT = -Infinity;
    for (const [x, y] of corners) {
      const t = nx * x + ny * y;
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
    }
    const L = maxT - minT;

    const minFrac = 0.18; // each region at least 18% of projection width
    const minW = minFrac * L;
    const rem = L - 3 * minW; // guaranteed >=0 for minFrac < 1/3

    const eps = 1e-6;
    const r0 = rand() + eps,
      r1 = rand() + eps,
      r2 = rand() + eps;
    const rs = r0 + r1 + r2;

    const w0 = minW + (rem * r0) / rs;
    const w1 = minW + (rem * r1) / rs;
    // w2 implied

    const t1 = minT + w0;
    const t2 = minT + w0 + w1;

    return { nx, ny, t1, t2 };
  }

  function makeSquarePlanes(size) {
    // a*x + b*y <= c
    return [
      { a: -1, b: 0, c: 0 }, // x >= 0
      { a: 1, b: 0, c: size }, // x <= size
      { a: 0, b: -1, c: 0 }, // y >= 0
      { a: 0, b: 1, c: size }, // y <= size
    ];
  }

  function makeRegionPlanes(size, lines) {
    const sq = makeSquarePlanes(size);
    const { nx, ny, t1, t2 } = lines;

    // left:  n·p <= t1
    const left = sq.concat([{ a: nx, b: ny, c: t1 }]);

    // mid:   n·p >= t1  AND  n·p <= t2
    //  n·p >= t1  <=>  (-n)·p <= -t1
    const mid = sq.concat([
      { a: -nx, b: -ny, c: -t1 },
      { a: nx, b: ny, c: t2 },
    ]);

    // right: n·p >= t2  <=> (-n)·p <= -t2
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
    if (!poly || poly.length < 3) {
      // Should not happen given our min width guarantee; fallback to full square.
      return square;
    }
    return poly;
  }

  // -------------------------
  // Convex polygon uniform sampling (triangulate fan at v0) - NO rejection
  // -------------------------
  function triArea(a, b, c) {
    const abx = b[0] - a[0],
      aby = b[1] - a[1];
    const acx = c[0] - a[0],
      acy = c[1] - a[1];
    return Math.abs(abx * acy - aby * acx) * 0.5;
  }

  function samplePointInTriangle(a, b, c, rand) {
    // barycentric with reflection (uniform)
    let r1 = rand();
    let r2 = rand();
    if (r1 + r2 > 1) {
      r1 = 1 - r1;
      r2 = 1 - r2;
    }
    return [a[0] + r1 * (b[0] - a[0]) + r2 * (c[0] - a[0]), a[1] + r1 * (b[1] - a[1]) + r2 * (c[1] - a[1])];
  }

  function makeFanTriangles(poly) {
    // poly is convex
    const v0 = poly[0];
    const tris = [];
    let total = 0;
    for (let i = 1; i + 1 < poly.length; i++) {
      const a = v0,
        b = poly[i],
        c = poly[i + 1];
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
    if (!tris.length || total <= 0) {
      // degenerate; fallback to centroid
      return polygonCentroid(poly);
    }
    let r = rand() * total;
    for (let i = 0; i < tris.length; i++) {
      const t = tris[i];
      r -= t.area;
      if (r <= 0 || i === tris.length - 1) {
        return samplePointInTriangle(t.a, t.b, t.c, rand);
      }
    }
    return samplePointInTriangle(tris[0].a, tris[0].b, tris[0].c, rand);
  }

  // -------------------------
  // Non-uniform sites in region (NO rejection)
  // - macro: uniform points
  // - micro: convex-combination pull toward random centers (guaranteed inside)
  // -------------------------
  function generateRegionPoints(m, regionPoly, rand, params) {
    if (m <= 0) return [];

    const triCache = makeFanTriangles(regionPoly);

    const microFrac = params.microFrac; // 0.65~0.8
    const alpha = params.alpha; // 2.0~3.0
    const macroCount = Math.max(1, Math.round(m * (1 - microFrac)));
    const microCount = m - macroCount;

    const pts = [];

    // macro: uniform in region
    for (let i = 0; i < macroCount; i++) {
      pts.push(sampleUniformInConvexPoly(regionPoly, triCache, rand));
    }

    // centers for micro
    const K = 2 + Math.floor(rand() * 2); // 2..4
    const centers = [];
    const kUse = Math.min(K, Math.max(1, macroCount)); // 保持你原来的安全逻辑:contentReference[oaicite:2]{index=2}

    // 1) 候选池：多采一些均匀点（不算拒绝采样，因为 sampleUniform... 是直接采样）:contentReference[oaicite:3]{index=3}
    const candN = Math.max(32, kUse * 16);
    const candidates = [];
    for (let t = 0; t < candN; t++) {
      candidates.push(sampleUniformInConvexPoly(regionPoly, triCache, rand));
    }

    // 2) 第一个 center：随机从候选里取
    let idx0 = Math.floor(rand() * candidates.length);
    centers.push(candidates[idx0]);
    candidates.splice(idx0, 1);

    // 3) 后续：每次选“到已选 centers 的最近距离”最大的点（maximin）
    for (let k = 1; k < kUse; k++) {
      let bestIdx = 0;
      let bestScore = -1;

      for (let i = 0; i < candidates.length; i++) {
        const p = candidates[i];

        let minD2 = Infinity;
        for (let s = 0; s < centers.length; s++) {
          const dx = p[0] - centers[s][0];
          const dy = p[1] - centers[s][1];
          const d2 = dx * dx + dy * dy;
          if (d2 < minD2) minD2 = d2;
        }

        // 小噪声打破完全平局，避免“总选最早的”带来微小结构
        const score = minD2 + 1e-12 * rand();
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }

      centers.push(candidates[bestIdx]);
      candidates.splice(bestIdx, 1);
    }


    // micro: pull toward centers via convex combination
    for (let i = 0; i < microCount; i++) {
      const p = sampleUniformInConvexPoly(regionPoly, triCache, rand);
      const c = centers[Math.floor(rand() * centers.length)];
      const lam = Math.pow(rand(), alpha); // in [0,1], skewed to 0 => closer to center
      const qx = c[0] + lam * (p[0] - c[0]);
      const qy = c[1] + lam * (p[1] - c[1]);
      pts.push([qx, qy]);
    }

    return pts;
  }

  function nudgeDuplicatesWithinPlanes(points, planes, insidePoint, rand) {
    const seen = new Set();
    for (let i = 0; i < points.length; i++) {
      let [x, y] = points[i];
      let key = `${Math.round(x * 1000)}_${Math.round(y * 1000)}`;
      let tries = 0;

      while (seen.has(key) && tries < 24) {
        // small deterministic jitter
        x = x + (rand() - 0.5) * 0.8;
        y = y + (rand() - 0.5) * 0.8;
        const clamped = clampToPlanesByBisection([x, y], insidePoint, planes);
        x = clamped[0];
        y = clamped[1];
        key = `${Math.round(x * 1000)}_${Math.round(y * 1000)}`;
        tries++;
      }

      points[i] = [x, y];
      seen.add(key);
    }
    return points;
  }

  function enforceMinDistance(points, minDist, planes, insidePoint, rand) {
    const n = points.length;
    if (n <= 1 || !(minDist > 0)) return points;

    const min2 = minDist * minDist;
    const passes = 5; // 固定次数：更大更“硬”，也更慢；N=100 这点完全OK

    for (let pass = 0; pass < passes; pass++) {
      for (let i = 0; i < n; i++) {
        let pi = points[i];
        for (let j = i + 1; j < n; j++) {
          let pj = points[j];

          let dx = pj[0] - pi[0];
          let dy = pj[1] - pi[1];
          let d2 = dx * dx + dy * dy;

          if (d2 >= min2) continue;

          // 如果两个点几乎重合，用确定性的随机方向拆开（seeded rand）
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

          const push = (minDist - d) * 0.5;

          // 分别推开
          let aix = pi[0] - ux * push;
          let aiy = pi[1] - uy * push;
          let ajx = pj[0] + ux * push;
          let ajy = pj[1] + uy * push;

          // 保证仍在凸区域内（确定性二分 clamp）
          const ai = clampToPlanesByBisection([aix, aiy], insidePoint, planes);
          const aj = clampToPlanesByBisection([ajx, ajy], insidePoint, planes);

          pi = points[i] = ai;
          points[j] = aj;
        }
      }

      // 每一轮做一次轻微去重，避免推挤后又贴得太死
      nudgeDuplicatesWithinPlanes(points, planes, insidePoint, rand);
    }

    return points;
  }

  function minDistFromArea(area, m, factor) {
    if (m <= 1) return 0;
    const avg = Math.sqrt(area / m);     // 平均“线性尺度”
    return factor * avg;                  // 系数越大，下界越高（建议 0.52~0.60）
  }


  // -------------------------
  // Constrained Lloyd in a region (cell clipped by region planes)
  // -------------------------
  function lloydRelaxInRegion(points, size, iters, regionPlanes, regionInsidePoint, rand) {
    let pts = points;
    for (let t = 0; t < iters; t++) {
      const delaunay = d3.Delaunay.from(pts);
      const voronoi = delaunay.voronoi([0, 0, size, size]);

      const nextPts = [];
      for (let i = 0; i < pts.length; i++) {
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

        const c = polygonCentroid(clipped);
        if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) {
          nextPts.push(pts[i]);
          continue;
        }
        // centroid should already be inside, but clamp deterministically just in case.
        nextPts.push(clampToPlanesByBisection(c, regionInsidePoint, regionPlanes));
      }

      pts = nudgeDuplicatesWithinPlanes(nextPts, regionPlanes, regionInsidePoint, rand);
    }
    return pts;
  }

  // -------------------------
  // Build region cells (Voronoi + hard clip)
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

  function buildCellsForRegion(points, size, regionPlanes, rand) {
    const delaunay = d3.Delaunay.from(points);
    const voronoi = delaunay.voronoi([0, 0, size, size]);

    const cells = [];
    for (let i = 0; i < points.length; i++) {
      const raw = voronoi.cellPolygon(i);
      let cleaned = cleanD3Polygon(raw);

      if (!cleaned || cleaned.length < 3) {
        cleaned = makeFallbackTriangle(points[i], size);
      }

      let clipped = clipPolyByPlanes(cleaned, regionPlanes);
      if (!clipped || clipped.length < 3) {
        // Best-effort fallback: clip fallback triangle
        const fb = makeFallbackTriangle(points[i], size);
        clipped = clipPolyByPlanes(fb, regionPlanes) || fb;
      }

      // Still ensure numeric sanity
      if (!clipped || clipped.length < 3) {
        const [x, y] = points[i];
        const fb2 = [
          [clamp(x - 1, 0, size), clamp(y - 1, 0, size)],
          [clamp(x + 1, 0, size), clamp(y - 1, 0, size)],
          [clamp(x + 1, 0, size), clamp(y + 1, 0, size)],
          [clamp(x - 1, 0, size), clamp(y + 1, 0, size)],
        ];
        clipped = fb2;
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
  function allocateByArea(totalN, areas, rand) {
    const keys = Object.keys(areas); // ["left","mid","right"]
    const sumA = keys.reduce((s, k) => s + areas[k], 0);

    if (totalN <= 0) return { left: 0, mid: 0, right: 0 };
    if (totalN === 1) return { left: 0, mid: 1, right: 0 };
    if (totalN === 2) return { left: 1, mid: 0, right: 1 };

    const baseMin = 1;
    let remain = totalN - 3 * baseMin;

    const raw = {};
    const base = { left: baseMin, mid: baseMin, right: baseMin };
    const frac = [];

    for (const k of keys) {
      const x = (remain * areas[k]) / (sumA || 1);
      const f = Math.floor(x);
      raw[k] = x;
      base[k] += f;
      frac.push({ k, r: x - f });
    }

    let used = base.left + base.mid + base.right;
    let extra = totalN - used;

    // distribute remainder to largest fractional parts; stable tie-breaker with rand
    frac.sort((p, q) => q.r - p.r);
    let idx = 0;
    while (extra > 0) {
      const pick = frac[idx % frac.length].k;
      base[pick] += 1;
      extra--;
      idx++;
    }

    // if somehow over (shouldn't), take from largest area region first while >=1
    while (base.left + base.mid + base.right > totalN) {
      let k = "mid";
      if (areas.left >= areas.mid && areas.left >= areas.right) k = "left";
      else if (areas.right >= areas.left && areas.right >= areas.mid) k = "right";
      if (base[k] > 1) base[k] -= 1;
      else {
        // fallback: remove from any region >1
        if (base.mid > 1) base.mid -= 1;
        else if (base.left > 1) base.left -= 1;
        else if (base.right > 1) base.right -= 1;
        else break;
      }
    }

    return base;
  }

  // -------------------------
  // Main entry
  // -------------------------
  function buildBoard(config, size) {
    const { rand } = makeRng(config.seedStr);
    const N = Math.max(1, config.pieceCount | 0);

    // parameters (tuned to reduce spiderweb yet keep non-uniform)
    const params = {
      microFrac: 0.7, // 0.65~0.8
      alpha: 3, // 2.0~3.0
    };
    const minDistFactor = 0.6

    const relaxIters =
      typeof config.relaxIters === "number" && Number.isFinite(config.relaxIters)
        ? Math.max(0, config.relaxIters | 0)
        : 1; // default 1 (constrained Lloyd per region)

    // 1) parallel lines
    const lines = generateParallelLines(size, rand);

    // 2) region planes and region polygons (for sampling + centroid)
    const planes = makeRegionPlanes(size, lines);

    const polyL = regionPolyFromPlanes(size, planes.left);
    const polyM = regionPolyFromPlanes(size, planes.mid);
    const polyR = regionPolyFromPlanes(size, planes.right);

    const areaL = polygonArea(polyL);
    const areaM = polygonArea(polyM);
    const areaR = polygonArea(polyR);

    // 3) allocate piece counts by region area (hardly ever 0 because we enforce min width)
    const alloc = allocateByArea(N, { left: areaL, mid: areaM, right: areaR }, rand);

    // 4) generate sites per region (NO rejection)
    const insideL = polygonCentroid(polyL);
    const insideM = polygonCentroid(polyM);
    const insideR = polygonCentroid(polyR);

    let ptsL = generateRegionPoints(alloc.left, polyL, rand, params);
    let ptsM = generateRegionPoints(alloc.mid, polyM, rand, params);
    let ptsR = generateRegionPoints(alloc.right, polyR, rand, params);

    // ensure sites inside via deterministic clamp (numerical safety)
    ptsL = ptsL.map((p) => clampToPlanesByBisection(p, insideL, planes.left));
    ptsM = ptsM.map((p) => clampToPlanesByBisection(p, insideM, planes.mid));
    ptsR = ptsR.map((p) => clampToPlanesByBisection(p, insideR, planes.right));

    ptsL = nudgeDuplicatesWithinPlanes(ptsL, planes.left, insideL, rand);
    ptsM = nudgeDuplicatesWithinPlanes(ptsM, planes.mid, insideM, rand);
    ptsR = nudgeDuplicatesWithinPlanes(ptsR, planes.right, insideR, rand);

    // enforce a hard minimum distance to reduce tiny cells (esp. pieceCount=100)
    ptsL = enforceMinDistance(ptsL, minDistFromArea(areaL, ptsL.length, minDistFactor), planes.left, insideL, rand);
    ptsM = enforceMinDistance(ptsM, minDistFromArea(areaM, ptsM.length, minDistFactor), planes.mid, insideM, rand);
    ptsR = enforceMinDistance(ptsR, minDistFromArea(areaR, ptsR.length, minDistFactor), planes.right, insideR, rand);

    // 5) optional constrained Lloyd to reduce spiderweb thin edges
    if (relaxIters > 0) {
      ptsL = lloydRelaxInRegion(ptsL, size, relaxIters, planes.left, insideL, rand);
      ptsM = lloydRelaxInRegion(ptsM, size, relaxIters, planes.mid, insideM, rand);
      ptsR = lloydRelaxInRegion(ptsR, size, relaxIters, planes.right, insideR, rand);
    }

    // 6) build clipped cells for each region (hard boundary)
    const cellsL = buildCellsForRegion(ptsL, size, planes.left, rand);
    const cellsM = buildCellsForRegion(ptsM, size, planes.mid, rand);
    const cellsR = buildCellsForRegion(ptsR, size, planes.right, rand);

    const cellsAll = cellsL.concat(cellsM, cellsR);
    // if any numeric oddities lead to mismatch, fix deterministically (should not happen)
    if (cellsAll.length !== N) {
      // adjust by truncation or pad with small cells at center of middle region
      while (cellsAll.length > N) cellsAll.pop();
      while (cellsAll.length < N) {
        const p = insideM;
        const fb = makeFallbackTriangle(p, size);
        const clipped = clipPolyByPlanes(fb, planes.mid) || fb;
        cellsAll.push({ poly: clipped, centroid: polygonCentroid(clipped) });
      }
    }

    // 7) shuffle numbering globally
    const nums = Array.from({ length: N }, (_, i) => i + 1);
    shuffleInPlace(nums, rand);
    for (let i = 0; i < N; i++) {
      cellsAll[i].num = nums[i];
    }

    return { cells: cellsAll };
  }

  JC.buildBoard = buildBoard;
})(window);
