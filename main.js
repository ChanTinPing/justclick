"use strict";

/**
 * Updates requested:
 * - Bigger number font
 * - HUD shows Current and Next
 * - No colored pieces (uniform neutral fill)
 * - Settings seed: no "e.g." / no "optional" wording
 * - Remove fixed parameter note
 * - Settings in English
 */

const $ = (sel) => document.querySelector(sel);

const els = {
  startScreen: $("#startScreen"),
  gameScreen: $("#gameScreen"),

  settingsBtn: $("#settingsBtn"),
  settingsModal: $("#settingsModal"),
  modalBackdrop: $("#modalBackdrop"),
  closeSettingsBtn: $("#closeSettingsBtn"),

  seedInput: $("#seedInput"),
  showTimerToggle: $("#showTimerToggle"),

  startBtn: $("#startBtn"),

  timeStat: $("#timeStat"),
  timeText: $("#timeText"),
  currentText: $("#currentText"),
  nextText: $("#nextText"),
  msg: $("#msg"),

  pauseBtn: $("#pauseBtn"),
  newBoardBtn: $("#newBoardBtn"),
  backBtn: $("#backBtn"),

  boardWrap: $("#boardWrap"),
  boardSvg: $("#boardSvg"),
  pausedOverlay: $("#pausedOverlay"),
};

const PIECE_OPTIONS = [20, 50, 100];
const DEFAULT_PIECE_COUNT = 20;
const FIXED_LLOYD_ITERS = 0;
const WRONG_PENALTY_SEC = 10;
const BOARD_SIZE = 1000;

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}
function mulberry32(a) {
  return function () {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeRng(seedStr) {
  const s = (seedStr && seedStr.trim().length > 0) ? seedStr.trim() : String(Date.now());
  const h = xmur3(s);
  return { seed: s, rand: mulberry32(h()) };
}
function shuffleInPlace(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function polygonCentroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const f = (xj * yi - xi * yj);
    a += f;
    cx += (xj + xi) * f;
    cy += (yj + yi) * f;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-9) return poly[Math.floor(poly.length / 2)] || [0, 0];
  cx /= (6 * a);
  cy /= (6 * a);
  return [cx, cy];
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

const STATE = { IDLE: "idle", PLAYING: "playing", PAUSED: "paused", FINISHED: "finished" };

let game = {
  state: STATE.IDLE,
  config: null,
  size: BOARD_SIZE,

  // timing
  startPerf: 0,
  elapsedMs: 0,
  timerId: null,

  // run
  current: 0,
  next: 1,
  total: 20,

  // map num -> elements
  numToPolygon: new Map(),
  numToText: new Map(),
  cellsGroupEl: null,
};

function getPieceCountFromRadios() {
  const picked = document.querySelector('input[name="pieceCount"]:checked');
  const val = parseInt(picked?.value || String(DEFAULT_PIECE_COUNT), 10);
  return PIECE_OPTIONS.includes(val) ? val : DEFAULT_PIECE_COUNT;
}
function setPieceCountRadios(n) {
  const v = PIECE_OPTIONS.includes(n) ? n : DEFAULT_PIECE_COUNT;
  const el = document.querySelector(`input[name="pieceCount"][value="${v}"]`);
  if (el) el.checked = true;
}
function readConfigFromUI() {
  return {
    pieceCount: getPieceCountFromRadios(),
    seedStr: els.seedInput.value || "",
    showTimer: !!els.showTimerToggle.checked,
    relaxIters: FIXED_LLOYD_ITERS,
    wrongPenaltySec: WRONG_PENALTY_SEC,
  };
}

function showStartScreen() {
  els.startScreen.classList.remove("hidden");
  els.gameScreen.classList.add("hidden");
}
function showGameScreen() {
  els.startScreen.classList.add("hidden");
  els.gameScreen.classList.remove("hidden");
}

function setMsg(text, kind = "") {
  els.msg.textContent = text || "";
  els.msg.classList.remove("bad", "good", "doneBanner");
  if (kind === "bad") els.msg.classList.add("bad");
  if (kind === "good") els.msg.classList.add("good");
}

function fmtTime(ms) {
  const total = Math.max(0, ms);
  const sec = total / 1000;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const sInt = Math.floor(s);
  const tenths = Math.floor((s - sInt) * 10);
  return `${String(m).padStart(2, "0")}:${String(sInt).padStart(2, "0")}.${tenths}`;
}

function applyTimerVisibility() {
  if (game.config?.showTimer) els.timeStat.classList.remove("hidden");
  else els.timeStat.classList.add("hidden");
}

function updateHUD() {
  if (game.config?.showTimer) {
    const cur = game.elapsedMs + (game.state === STATE.PLAYING ? (performance.now() - game.startPerf) : 0);
    els.timeText.textContent = fmtTime(cur);
  }
  els.currentText.textContent = String(game.current);
  els.nextText.textContent = String(game.next);
  els.timeText.classList.toggle("doneTime", game.state === STATE.FINISHED);
}

function startTimer() {
  stopTimer();
  game.startPerf = performance.now();
  game.timerId = window.setInterval(updateHUD, 60);
}
function stopTimer() {
  if (game.timerId != null) {
    window.clearInterval(game.timerId);
    game.timerId = null;
  }
}
function freezeElapsed() {
  if (game.state === STATE.PLAYING) {
    game.elapsedMs += performance.now() - game.startPerf;
  }
}
function addPenalty(seconds) {
  game.elapsedMs += seconds * 1000;
  updateHUD();
}

function generatePointsJitteredGrid(n, size, rand) {
  const g = Math.ceil(Math.sqrt(n));
  const pts = [];
  for (let gy = 0; gy < g; gy++) {
    for (let gx = 0; gx < g; gx++) {
      pts.push([((gx + rand()) / g) * size, ((gy + rand()) / g) * size]);
    }
  }
  shuffleInPlace(pts, rand);
  return pts.slice(0, n);
}

function lloydRelax(points, size, iters) {
  let pts = points;
  for (let t = 0; t < iters; t++) {
    const delaunay = d3.Delaunay.from(pts);
    const voronoi = delaunay.voronoi([0, 0, size, size]);

    const nextPts = [];
    for (let i = 0; i < pts.length; i++) {
      const poly = voronoi.cellPolygon(i);
      if (!poly || poly.length < 3) { nextPts.push(pts[i]); continue; }

      const cleaned = poly.slice();
      const first = cleaned[0];
      const last = cleaned[cleaned.length - 1];
      if (first && last && first[0] === last[0] && first[1] === last[1]) cleaned.pop();

      const [cx, cy] = polygonCentroid(cleaned);
      nextPts.push([clamp(cx, 0, size), clamp(cy, 0, size)]);
    }
    pts = nextPts;
  }
  return pts;
}

function randn(rand) {
  // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function dist2(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}

function makeScene(size, rand) {
  // 两个大圆（你也可以把位置/半径写死成你想要的）
  const circles = [
    {
      cx: size * (0.25 + 0.10 * rand()),
      cy: size * (0.30 + 0.15 * rand()),
      r:  size * (0.18 + 0.05 * rand()),
    },
    {
      cx: size * (0.70 + 0.10 * (rand() - 0.5)),
      cy: size * (0.70 + 0.10 * (rand() - 0.5)),
      r:  size * (0.16 + 0.06 * rand()),
    },
  ];

  // 两条“主干曲线”：为了好实现，把它们写成 x = f(y) 的形式（y 单调）
  // 这样就能用 x 与 f(y) 比较来分三区：left / middle / right
  const base1 = size * (0.32 + 0.03 * (rand() - 0.5));
  const base2 = size * (0.68 + 0.03 * (rand() - 0.5));
  const amp1  = size * (0.06 + 0.02 * rand());
  const amp2  = size * (0.06 + 0.02 * rand());
  const ph1   = 2 * Math.PI * rand();
  const ph2   = 2 * Math.PI * rand();

  function curve1X(y) {
    const t = y / size;
    const x = base1 + amp1 * Math.sin(2 * Math.PI * t + ph1) * 0.9
                    + amp1 * Math.sin(4 * Math.PI * t + ph1) * 0.2;
    return clamp(x, size * 0.10, size * 0.45);
  }

  function curve2X(y) {
    const t = y / size;
    const x = base2 + amp2 * Math.sin(2 * Math.PI * t + ph2) * 0.9
                    + amp2 * Math.sin(4 * Math.PI * t + ph2) * 0.2;
    return clamp(x, size * 0.55, size * 0.90);
  }

  // 宏区域判定：圆优先（“遮盖曲线”）
  function regionOf(x, y) {
    for (let i = 0; i < circles.length; i++) {
      const c = circles[i];
      if (dist2(x, y, c.cx, c.cy) <= c.r * c.r) return `C${i}`; // C0 / C1
    }
    const x1 = curve1X(y);
    const x2 = curve2X(y);
    if (x < x1) return "R0";      // 左
    if (x < x2) return "R1";      // 中
    return "R2";                  // 右
  }

  return { circles, curve1X, curve2X, regionOf };
}

function samplePointWhere(size, rand, predicate, maxTry = 20000) {
  for (let t = 0; t < maxTry; t++) {
    const x = rand() * size;
    const y = rand() * size;
    if (predicate(x, y)) return [x, y];
  }
  // 兜底：返回任意点（极小概率）
  return [rand() * size, rand() * size];
}

function generatePointsStructured(n, size, rand) {
  const scene = makeScene(size, rand);

  // 你想要：两个圆 + 三个非圆区域
  // 点数分配（可调）：圆区域点数少 -> 圆附近碎片更大；非圆区域点数多 -> 可做大小差异
  const nC0 = Math.max(1, Math.round(n * 0.06));
  const nC1 = Math.max(1, Math.round(n * 0.06));
  const nRest = n - nC0 - nC1;

  // 三个非圆宏区域的点数（可随机扰动一下避免每次都差不多）
  let nR0 = Math.round(nRest * (0.34 + 0.06 * (rand() - 0.5)));
  let nR1 = Math.round(nRest * (0.40 + 0.08 * (rand() - 0.5)));
  let nR2 = nRest - nR0 - nR1;
  nR0 = Math.max(0, nR0); nR1 = Math.max(0, nR1); nR2 = Math.max(0, nR2);

  const counts = { C0: nC0, C1: nC1, R0: nR0, R1: nR1, R2: nR2 };

  // “在某个宏区域里再随机切分成大小差很大的一些小区域”
  // 用“宏点(稀疏) + 微点(簇状高密度)”来实现：稀疏处 Voronoi cell 会更大；簇里会更小。
  function genForRegion(regionKey, m) {
    if (m <= 0) return [];
    const pts = [];

    // macro seeds：少量、均匀 -> 大碎片
    const macro = Math.max(1, Math.round(m * (0.18 + 0.10 * rand())));
    // micro seeds：剩下的做成几个 cluster -> 小碎片
    const micro = m - macro;

    // 先采 macro
    for (let i = 0; i < macro; i++) {
      pts.push(samplePointWhere(size, rand, (x, y) => scene.regionOf(x, y) === regionKey));
    }

    // 再做 micro clusters（子区域大小差异主要来自这里）
    if (micro > 0) {
      const clusterCount = clamp(Math.round(2 + rand() * 3), 2, 5); // 2~5 个簇
      const centers = [];
      for (let k = 0; k < clusterCount; k++) {
        centers.push(samplePointWhere(size, rand, (x, y) => scene.regionOf(x, y) === regionKey));
      }

      // 簇的“紧密程度”（越小越像小块挤在一起）
      const sigma = size * (0.03 + 0.03 * rand());

      for (let i = 0; i < micro; i++) {
        const c = centers[Math.floor(rand() * centers.length)];
        // 高斯扰动，形成 cluster
        let x = c[0] + randn(rand) * sigma;
        let y = c[1] + randn(rand) * sigma;

        // 如果跑出边界或跑到别的区域，就用 rejection 纠正
        if (x < 0 || x > size || y < 0 || y > size || scene.regionOf(x, y) !== regionKey) {
          [x, y] = samplePointWhere(size, rand, (xx, yy) => scene.regionOf(xx, yy) === regionKey);
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

  // 防止极端情况下点数不对
  while (points.length < n) points.push([rand() * size, rand() * size]);
  if (points.length > n) points.length = n;

  // 打散
  shuffleInPlace(points, rand);
  return points;
}

function buildBoard(config) {
  const { rand } = makeRng(config.seedStr);
  let points = generatePointsStructured(config.pieceCount, game.size, rand);
  // 强烈建议 relaxIters=0 或 1，否则你想要的不均匀会被抹平
  points = lloydRelax(points, game.size, config.relaxIters);

  const delaunay = d3.Delaunay.from(points);
  const voronoi = delaunay.voronoi([0, 0, game.size, game.size]);

  const nums = Array.from({ length: config.pieceCount }, (_, i) => i + 1);
  shuffleInPlace(nums, rand);

  const cells = [];
  for (let i = 0; i < config.pieceCount; i++) {
    const poly = voronoi.cellPolygon(i);
    if (!poly || poly.length < 3) continue;

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

  if (cells.length !== config.pieceCount) cells.length = config.pieceCount;
  return { cells };
}

function clearSvg(svg) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
}

function getFontSizeForN(n) {
  const size = Math.round(170 / Math.sqrt(n)); // 220 -> 170：整体更小
  return clamp(size, 18, 44);                  // 下限/上限也一起缩
}

function renderBoard(cells) {
  const svg = els.boardSvg;
  clearSvg(svg);

  // Border (always visible even when paused)
  const border = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  border.setAttribute("x", "0");
  border.setAttribute("y", "0");
  border.setAttribute("width", String(game.size));
  border.setAttribute("height", String(game.size));
  border.setAttribute("fill", "none");
  border.setAttribute("stroke", "rgba(44,125,255,0.30)");
  border.setAttribute("stroke-width", "3");
  svg.appendChild(border);

  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.setAttribute("id", "cellsGroup");
  svg.appendChild(g);
  game.cellsGroupEl = g;

  game.numToPolygon.clear();
  game.numToText.clear();

  const fontSize = getFontSizeForN(game.total);

  for (const cell of cells) {
    const polyEl = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    const ptsStr = cell.poly.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
    polyEl.setAttribute("points", ptsStr);
    polyEl.classList.add("cell");
    polyEl.dataset.num = String(cell.num);

    polyEl.addEventListener("click", () => onCellClick(cell.num));

    const textEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
    textEl.setAttribute("x", String(cell.centroid[0]));
    textEl.setAttribute("y", String(cell.centroid[1]));
    textEl.setAttribute("text-anchor", "middle");
    textEl.setAttribute("dominant-baseline", "middle");
    textEl.classList.add("cellText");
    textEl.style.fontSize = `${fontSize}px`;
    textEl.textContent = String(cell.num);

    g.appendChild(polyEl);
    g.appendChild(textEl);

    game.numToPolygon.set(cell.num, polyEl);
    game.numToText.set(cell.num, textEl);
  }
}

function setCellsVisible(visible) {
  if (!game.cellsGroupEl) return;
  game.cellsGroupEl.style.display = visible ? "block" : "none";
}

function resetRunState(total) {
  game.total = total;
  game.current = 0;
  game.next = 1;

  game.elapsedMs = 0;
  game.startPerf = 0;
  stopTimer();

  els.boardWrap.classList.remove("flash-bad");
  els.pausedOverlay.classList.add("hidden");
  els.pauseBtn.textContent = "Pause";
  setMsg("");
  updateHUD();
}

function startNewGame(config) {
  game.config = config;
  applyTimerVisibility();

  const { cells } = buildBoard(config);
  game.total = config.pieceCount; // ensure font uses correct N
  renderBoard(cells);
  resetRunState(config.pieceCount);

  game.state = STATE.PLAYING;
  setCellsVisible(true);
  startTimer();
  updateHUD();
}

function finishGame() {
  freezeElapsed();
  stopTimer();
  game.state = STATE.FINISHED;
  updateHUD();

  setMsg("Done!", "good");
  els.msg.classList.add("doneBanner");   // 让 Done 变大（只对 Done 生效）
  els.timeText.classList.add("doneTime"); // 计时变绿（如果你想立刻生效）
}

function pauseGame() {
  if (game.state !== STATE.PLAYING) return;
  freezeElapsed();
  stopTimer();
  game.state = STATE.PAUSED;

  setCellsVisible(false); // only square remains
  els.pausedOverlay.classList.remove("hidden");
  els.pauseBtn.textContent = "Resume";
  updateHUD();
}

function resumeGame() {
  if (game.state !== STATE.PAUSED) return;
  game.state = STATE.PLAYING;

  setCellsVisible(true);
  els.pausedOverlay.classList.add("hidden");
  els.pauseBtn.textContent = "Pause";

  startTimer();
  updateHUD();
}

function flashWrong() {
  els.boardWrap.classList.remove("flash-bad");
  void els.boardWrap.offsetWidth;
  els.boardWrap.classList.add("flash-bad");
}

function onCellClick(num) {
  if (game.state !== STATE.PLAYING) return;

  if (num === game.next) {
    const polyEl = game.numToPolygon.get(num);
    const textEl = game.numToText.get(num);

    if (polyEl) {
      polyEl.classList.add("hit");                     // 短暂提示
      window.setTimeout(() => polyEl.classList.remove("hit"), 160);
    }
    if (textEl) {
      // 数字变绿：只闪一下，不永久
      textEl.classList.add("done");
      window.setTimeout(() => textEl.classList.remove("done"), 160);
    }

    game.current = num;
    game.next = num + 1;
    setMsg("");

    if (game.next > game.total) {
      finishGame();
      return;
    }
    updateHUD();
  } else {
    const textEl = game.numToText.get(num);
    if (textEl) {
      textEl.classList.add("wrong");
      window.setTimeout(() => textEl.classList.remove("wrong"), 220);
    }
    flashWrong();
    setMsg(`Wrong: next is ${game.next} (you clicked ${num})`, "bad");
    addPenalty(game.config.wrongPenaltySec);
  }
}

// modal
function openSettings() {
  setPieceCountRadios(game.config?.pieceCount ?? DEFAULT_PIECE_COUNT);
  els.modalBackdrop.classList.remove("hidden");
  els.settingsModal.classList.remove("hidden");
}
function closeSettings() {
  els.modalBackdrop.classList.add("hidden");
  els.settingsModal.classList.add("hidden");
}

els.settingsBtn.addEventListener("click", openSettings);
els.closeSettingsBtn.addEventListener("click", closeSettings);
els.modalBackdrop.addEventListener("click", closeSettings);
window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSettings(); });

els.startBtn.addEventListener("click", () => {
  const config = readConfigFromUI();
  showGameScreen();
  startNewGame(config);
});

els.pauseBtn.addEventListener("click", () => {
  if (game.state === STATE.PLAYING) pauseGame();
  else if (game.state === STATE.PAUSED) resumeGame();
});

els.newBoardBtn.addEventListener("click", () => {
  if (!game.config) return;
  startNewGame(game.config);
});

els.backBtn.addEventListener("click", () => {
  if (game.state === STATE.PLAYING) freezeElapsed();
  stopTimer();
  game.state = STATE.IDLE;
  showStartScreen();
});

showStartScreen();
