"use strict";

/**
 * board_gen.js
 * - Generates structured points (2 circles + 3 macro regions) and builds Voronoi cells.
 * - Requires:
 *   1) d3-delaunay loaded (global d3.Delaunay)
 *   2) rng.js loaded (window.JC.makeRng / shuffleInPlace)
 * - Exposes: window.JC.buildBoard(config, size) -> { cells }
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

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
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

  function randn(rand) {
    // Box-Muller
    let u = 0,
      v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  function dist2(ax, ay, bx, by) {
    const dx = ax - bx,
      dy = ay - by;
    return dx * dx + dy * dy;
  }

  function makeScene(size, rand) {
    const circles = [
      {
        cx: size * (0.25 + 0.1 * rand()),
        cy: size * (0.3 + 0.15 * rand()),
        r: size * (0.18 + 0.05 * rand()),
      },
      {
        cx: size * (0.7 + 0.1 * (rand() - 0.5)),
        cy: size * (0.7 + 0.1 * (rand() - 0.5)),
        r: size * (0.16 + 0.06 * rand()),
      },
    ];

    const base1 = size * (0.32 + 0.03 * (rand() - 0.5));
    const base2 = size * (0.68 + 0.03 * (rand() - 0.5));
    const amp1 = size * (0.06 + 0.02 * rand());
    const amp2 = size * (0.06 + 0.02 * rand());
    const ph1 = 2 * Math.PI * rand();
    const ph2 = 2 * Math.PI * rand();

    function curve1X(y) {
      const t = y / size;
      const x =
        base1 +
        amp1 * Math.sin(2 * Math.PI * t + ph1) * 0.9 +
        amp1 * Math.sin(4 * Math.PI * t + ph1) * 0.2;
      return clamp(x, size * 0.1, size * 0.45);
    }

    function curve2X(y) {
      const t = y / size;
      const x =
        base2 +
        amp2 * Math.sin(2 * Math.PI * t + ph2) * 0.9 +
        amp2 * Math.sin(4 * Math.PI * t + ph2) * 0.2;
      return clamp(x, size * 0.55, size * 0.9);
    }

    function regionOf(x, y) {
      for (let i = 0; i < circles.length; i++) {
        const c = circles[i];
        if (dist2(x, y, c.cx, c.cy) <= c.r * c.r) return `C${i}`; // C0 / C1
      }
      const x1 = curve1X(y);
      const x2 = curve2X(y);
      if (x < x1) return "R0";
      if (x < x2) return "R1";
      return "R2";
    }

    return { circles, curve1X, curve2X, regionOf };
  }

  function samplePointWhere(size, rand, predicate, maxTry = 20000) {
    for (let t = 0; t < maxTry; t++) {
      const x = rand() * size;
      const y = rand() * size;
      if (predicate(x, y)) return [x, y];
    }
    return [rand() * size, rand() * size];
  }

  function generatePointsStructured(n, size, rand) {
    const scene = makeScene(size, rand);

    const nC0 = Math.max(1, Math.round(n * 0.06));
    const nC1 = Math.max(1, Math.round(n * 0.06));
    const nRest = n - nC0 - nC1;

    let nR0 = Math.round(nRest * (0.34 + 0.06 * (rand() - 0.5)));
    let nR1 = Math.round(nRest * (0.4 + 0.08 * (rand() - 0.5)));
    let nR2 = nRest - nR0 - nR1;
    nR0 = Math.max(0, nR0);
    nR1 = Math.max(0, nR1);
    nR2 = Math.max(0, nR2);

    const counts = { C0: nC0, C1: nC1, R0: nR0, R1: nR1, R2: nR2 };

    function genForRegion(regionKey, m) {
      if (m <= 0) return [];
      const pts = [];

      const macro = Math.max(1, Math.round(m * (0.18 + 0.1 * rand())));
      const micro = m - macro;

      for (let i = 0; i < macro; i++) {
        pts.push(
          samplePointWhere(size, rand, (x, y) => scene.regionOf(x, y) === regionKey)
        );
      }

      if (micro > 0) {
        const clusterCount = clamp(Math.round(2 + rand() * 3), 2, 5);
        const centers = [];
        for (let k = 0; k < clusterCount; k++) {
          centers.push(
            samplePointWhere(size, rand, (x, y) => scene.regionOf(x, y) === regionKey)
          );
        }

        const sigma = size * (0.03 + 0.03 * rand());
        for (let i = 0; i < micro; i++) {
          const c = centers[Math.floor(rand() * centers.length)];
          let x = c[0] + randn(rand) * sigma;
          let y = c[1] + randn(rand) * sigma;

          if (
            x < 0 ||
            x > size ||
            y < 0 ||
            y > size ||
            scene.regionOf(x, y) !== regionKey
          ) {
            [x, y] = samplePointWhere(
              size,
              rand,
              (xx, yy) => scene.regionOf(xx, yy) === regionKey
            );
          }
          pts.push([x, y]);
        }
      }
      return pts;
    }

    const points = [];
    points.push(...genForRegion("C0", counts.C0));
    points.push(...genForRegion("C1", counts.C1));
    points.push(...genForRegion("R0", counts.R0));
    points.push(...genForRegion("R1", counts.R1));
    points.push(...genForRegion("R2", counts.R2));

    while (points.length < n) points.push([rand() * size, rand() * size]);
    if (points.length > n) points.length = n;

    shuffleInPlace(points, rand);
    return points;
  }

  function nudgeDuplicates(points, size, rand) {
    const seen = new Set();
    for (let i = 0; i < points.length; i++) {
      let [x, y] = points[i];
      let key = `${Math.round(x * 1000)}_${Math.round(y * 1000)}`;
      let tries = 0;
      while (seen.has(key) && tries < 20) {
        x = clamp(x + (rand() - 0.5) * 0.8, 0, size);
        y = clamp(y + (rand() - 0.5) * 0.8, 0, size);
        key = `${Math.round(x * 1000)}_${Math.round(y * 1000)}`;
        tries++;
      }
      points[i] = [x, y];
      seen.add(key);
    }
    return points;
  }

  function lloydRelax(points, size, iters) {
    let pts = points;
    for (let t = 0; t < iters; t++) {
      const delaunay = d3.Delaunay.from(pts);
      const voronoi = delaunay.voronoi([0, 0, size, size]);

      const nextPts = [];
      for (let i = 0; i < pts.length; i++) {
        const poly = voronoi.cellPolygon(i);
        if (!poly || poly.length < 3) {
          nextPts.push(pts[i]);
          continue;
        }

        const cleaned = poly.slice();
        const first = cleaned[0];
        const last = cleaned[cleaned.length - 1];
        if (first && last && first[0] === last[0] && first[1] === last[1]) cleaned.pop();

        const [cx, cy] = polygonCentroid(cleaned);
        nextPts.push([clamp(cx, 0, size), clamp(cy, 0, size)]);
      }
      pts = nudgeDuplicates(nextPts, size, Math.random); // 这里用 Math.random 足够做去重微扰
    }
    return pts;
  }

  function buildBoard(config, size) {
    const { rand } = makeRng(config.seedStr);

    let points = generatePointsStructured(config.pieceCount, size, rand);
    points = nudgeDuplicates(points, size, rand);

    // 你当前代码里 relaxIters=0（推荐保持 0 或 1，不然不均匀会被抹平）
    points = lloydRelax(points, size, config.relaxIters || 0);
    points = nudgeDuplicates(points, size, rand);

    const delaunay = d3.Delaunay.from(points);
    const voronoi = delaunay.voronoi([0, 0, size, size]);

    const nums = Array.from({ length: config.pieceCount }, (_, i) => i + 1);
    shuffleInPlace(nums, rand);

    const cells = [];
    for (let i = 0; i < config.pieceCount; i++) {
      const poly = voronoi.cellPolygon(i);

      // 正常情况下不会触发；但为了不让 renderBoard 崩溃，给一个兜底小三角
      if (!poly || poly.length < 3) {
        const [x, y] = points[i] || [size * 0.5, size * 0.5];
        const d = 1.2;
        const fallback = [
          [clamp(x - d, 0, size), clamp(y - d, 0, size)],
          [clamp(x + d, 0, size), clamp(y - d, 0, size)],
          [clamp(x, 0, size), clamp(y + d, 0, size)],
        ];
        cells.push({ num: nums[i], poly: fallback, centroid: [x, y] });
        continue;
      }

      const cleaned = poly.slice();
      const first = cleaned[0];
      const last = cleaned[cleaned.length - 1];
      if (first && last && first[0] === last[0] && first[1] === last[1]) cleaned.pop();

      cells.push({
        num: nums[i],
        poly: cleaned,
        centroid: polygonCentroid(cleaned),
      });
    }

    return { cells };
  }

  JC.buildBoard = buildBoard;
})(window);
