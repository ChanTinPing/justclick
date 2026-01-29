"use strict";

/**
 * HUD change:
 * - Top bar: left shows Time (optional), center shows "Click X" / "Done!"
 * - Buttons (Pause/New/Home) moved below board, above seed share
 */

const $ = (sel) => document.querySelector(sel);

const els = {
  startScreen: $("#startScreen"),
  gameScreen: $("#gameScreen"),

  seedInput: $("#seedInput"),
  seedShare: $("#seedShare"),
  showTimerToggle: $("#showTimerToggle"),

  startBtn: $("#startBtn"),

  timeStat: $("#timeStat"),
  timeText: $("#timeText"),
  clickBanner: $("#clickBanner"),
  modePill: $("#modePill"),
  penaltyHint: $("#penaltyHint"),

  pauseBtn: $("#pauseBtn"),
  newBoardBtn: $("#newBoardBtn"),
  backBtn: $("#backBtn"),

  boardWrap: $("#boardWrap"),
  boardSvg: $("#boardSvg"),
  pausedOverlay: $("#pausedOverlay"),
};

const PIECE_OPTIONS = [12, 20, 50, 100];
const DEFAULT_PIECE_COUNT = 20;
const MODE_OPTIONS = ["easy", "normal", "hard"];
const DEFAULT_MODE = "normal";
const FIXED_LLOYD_ITERS = 3;
const WRONG_PENALTY_SEC = 10;
const BOARD_SIZE = 1000;
const STATE = { IDLE: "idle", PLAYING: "playing", PAUSED: "paused", FINISHED: "finished" };

function gaEvent(name, params = {}) {
  if (typeof window.gtag === "function") window.gtag("event", name, params);
}

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

  runSeedStr: "",
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
function getModeFromRadios() {
  const picked = document.querySelector('input[name="mode"]:checked');
  const v = String(picked?.value || DEFAULT_MODE).toLowerCase();
  return MODE_OPTIONS.includes(v) ? v : DEFAULT_MODE;
}
function setModeRadios(mode) {
  const m = MODE_OPTIONS.includes(mode) ? mode : DEFAULT_MODE;
  const el = document.querySelector(`input[name="mode"][value="${m}"]`);
  if (el) el.checked = true;
}
function readConfigFromUI() {
  return {
    pieceCount: getPieceCountFromRadios(),
    mode: getModeFromRadios(),
    seedStr: els.seedInput.value || "",
    showTimer: !!els.showTimerToggle.checked,
    relaxIters: FIXED_LLOYD_ITERS,
    wrongPenaltySec: WRONG_PENALTY_SEC,
  };
}

function syncStartSettingsFromConfig() {
  if (!game.config) return;
  setPieceCountRadios(game.config.pieceCount ?? DEFAULT_PIECE_COUNT);
  setModeRadios(game.config.mode ?? DEFAULT_MODE); 
  els.seedInput.value = game.config.seedStr ?? "";
  els.showTimerToggle.checked = !!game.config.showTimer;
}

function showStartScreen() {
  els.startScreen.classList.remove("hidden");
  els.gameScreen.classList.add("hidden");
  syncStartSettingsFromConfig();
  setSeedShare("");
}
function showGameScreen() {
  els.startScreen.classList.add("hidden");
  els.gameScreen.classList.remove("hidden");
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

function genAutoSeed() {
  // 足够短、可复制、基本不会撞
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function setSeedShare(seedOrEmpty) {
  if (!els.seedShare) return;

  const s = (seedOrEmpty || "").trim();
  if (!s) {
    els.seedShare.textContent = "";
    els.seedShare.classList.add("hidden");
    return;
  }

  els.seedShare.textContent = `seed\n${s}`;
  els.seedShare.classList.remove("hidden");
}

function applyTimerVisibility() {
  if (game.config?.showTimer) els.timeStat.classList.remove("hidden");
  else els.timeStat.classList.add("hidden");
}

let bannerLockUntil = 0;

function bannerBaseText() {
  if (game.state === STATE.FINISHED) return "Done!";
  return `Click ${game.next}`;
}

function setBanner(text, kind = "") {
  if (!els.clickBanner) return;
  els.clickBanner.textContent = text || "";
  els.clickBanner.classList.remove("bad", "good", "doneBanner");
  if (kind === "bad") els.clickBanner.classList.add("bad");
  if (kind === "good") els.clickBanner.classList.add("good", "doneBanner");
}

function updateHUD() {
  if (game.config?.showTimer) {
    const cur = game.elapsedMs + (game.state === STATE.PLAYING ? (performance.now() - game.startPerf) : 0);
    els.timeText.textContent = fmtTime(cur);
  }

  // center banner: Click X / Done!
  if (game.state === STATE.FINISHED) {
    bannerLockUntil = 0;
    setBanner("Done!", "good");
  } else {
    const now = performance.now();
    if (now >= bannerLockUntil) {
      setBanner(bannerBaseText());
    }
  }

  if (els.modePill) {
    const raw = String(game.config?.mode || "normal").trim().toLowerCase();
    const modeName = (raw === "easy") ? "Easy" : (raw === "hard") ? "Hard" : "Normal";
    els.modePill.textContent = `${modeName}`;
    els.modePill.classList.toggle("done", game.state === STATE.FINISHED); // Done 后变绿
  }

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

let penaltyHideId = null;
function showPenaltyHint(seconds) {
  if (!els.penaltyHint) return;

  els.penaltyHint.textContent = `+${seconds}s`;
  els.penaltyHint.classList.remove("hidden");

  // restart animation
  els.penaltyHint.classList.remove("pop");
  void els.penaltyHint.offsetWidth;
  els.penaltyHint.classList.add("pop");

  if (penaltyHideId) window.clearTimeout(penaltyHideId);
  penaltyHideId = window.setTimeout(() => {
    els.penaltyHint.classList.add("hidden");
    els.penaltyHint.classList.remove("pop");
  }, 650);
}

function buildBoard(config) {
  return JC.buildBoard(config, game.size);
}

function clearSvg(svg) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
}

function getFontSizeForN(n) {
  const size = Math.round(225 / Math.sqrt(n));
  return size;
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

  // Root group (this is what pause hides)
  const root = document.createElementNS("http://www.w3.org/2000/svg", "g");
  root.setAttribute("id", "cellsGroup");
  svg.appendChild(root);
  game.cellsGroupEl = root;

  // Layers: fill -> edges -> text
  const fillsG = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const edgesG = document.createElementNS("http://www.w3.org/2000/svg", "g");
  const textsG = document.createElementNS("http://www.w3.org/2000/svg", "g");
  root.appendChild(fillsG);
  root.appendChild(edgesG);
  root.appendChild(textsG);

  // --- helpers ---
  function q(x) { return Math.round(x * 8) / 8; } // 量化更粗一点，更容易匹配共享边
  function edgeKey(a, b) {
    const ax = q(a[0]), ay = q(a[1]);
    const bx = q(b[0]), by = q(b[1]);
    const A = `${ax},${ay}`, B = `${bx},${by}`;
    return (A < B) ? `${A}|${B}` : `${B}|${A}`; // undirected
  }
  function samePoint(p, r) {
    return Math.abs(p[0] - r[0]) < 1e-6 && Math.abs(p[1] - r[1]) < 1e-6;
  }
  function hash32(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function rand01(key) { return (hash32(key) % 1000000) / 1000000; }

  // build edge map: key -> {a,b,count,c1,c2}
  const edgeMap = new Map();
  for (const cell of cells) {
    const poly = cell.poly;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const k = edgeKey(a, b);
      let e = edgeMap.get(k);
      if (!e) { e = { a, b, count: 0, c1: null, c2: null }; edgeMap.set(k, e); }
      e.count++;
    }
  }

  // curve ONLY truly shared edges (count==2)
  for (const [k, e] of edgeMap) {
    if (e.count !== 2) continue;

    const ax = e.a[0], ay = e.a[1], bx = e.b[0], by = e.b[1];
    const vx = bx - ax, vy = by - ay;
    const len = Math.hypot(vx, vy);
    if (len < 18) continue;

    const nx = -vy / len, ny = vx / len;
    const r = rand01(game.runSeedStr + "|" + k);

    // “一点点点”：幅度更保守，避免看起来像乱扭
    const amp = Math.min(4, 0.06 * len) * (r * 2 - 1);

    e.c1 = [ax + vx * 0.33 + nx * amp, ay + vy * 0.33 + ny * amp];
    e.c2 = [ax + vx * 0.66 + nx * amp, ay + vy * 0.66 + ny * amp];
  }

  function polyToPathD(poly) {
    let d = `M ${poly[0][0]} ${poly[0][1]}`;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const k = edgeKey(a, b);
      const e = edgeMap.get(k);

      if (e && e.count === 2 && e.c1 && e.c2) {
        const forward = samePoint(a, e.a) && samePoint(b, e.b);
        const c1 = forward ? e.c1 : e.c2;
        const c2 = forward ? e.c2 : e.c1;
        d += ` C ${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${b[0]} ${b[1]}`;
      } else {
        d += ` L ${b[0]} ${b[1]}`;
      }
    }
    return d + " Z";
  }

  // map num -> elements
  game.numToPolygon.clear();
  game.numToText.clear();

  const fontSize = getFontSizeForN(game.total);

  // 1) draw fills (curved path for shared edges)
  for (const cell of cells) {
    const pathEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
    pathEl.setAttribute("d", polyToPathD(cell.poly));
    pathEl.classList.add("cell");
    pathEl.dataset.num = String(cell.num);
    pathEl.addEventListener("click", () => onCellClick(cell.num));
    fillsG.appendChild(pathEl);
    game.numToPolygon.set(cell.num, pathEl);

    const textEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
    textEl.setAttribute("x", String(cell.centroid[0]));
    textEl.setAttribute("y", String(cell.centroid[1]));
    textEl.setAttribute("text-anchor", "middle");
    textEl.setAttribute("dominant-baseline", "middle");
    textEl.classList.add("cellText");
    textEl.style.fontSize = `${fontSize}px`;
    textEl.textContent = String(cell.num);
    textsG.appendChild(textEl);
    game.numToText.set(cell.num, textEl);
  }

  // 2) draw edges ONCE for ALL edges:
  // - count==2: shared internal edges (curved if exists)
  // - count==1: hard boundaries / outer boundaries (straight)
  for (const [k, e] of edgeMap) {
    const a = e.a, b = e.b;
    const edgeEl = document.createElementNS("http://www.w3.org/2000/svg", "path");

    if (e.count === 2 && e.c1 && e.c2) {
      edgeEl.setAttribute(
        "d",
        `M ${a[0]} ${a[1]} C ${e.c1[0]} ${e.c1[1]} ${e.c2[0]} ${e.c2[1]} ${b[0]} ${b[1]}`
      );
    } else {
      edgeEl.setAttribute("d", `M ${a[0]} ${a[1]} L ${b[0]} ${b[1]}`);
    }

    edgeEl.classList.add("edgePath");
    edgesG.appendChild(edgeEl);
  }
}

function applyHardTextRule() {
  const hard = (game.config?.mode === "hard");
  const hideAll = hard && game.state === STATE.PLAYING && game.current >= 1; // 仅游玩中隐藏
  for (const [, t] of game.numToText) {
    if (!t) continue;
    t.style.display = hideAll ? "none" : "block";
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
  bannerLockUntil = 0;

  updateHUD();
}

function startNewGame(config) {
  game.config = config;
  els.boardWrap.classList.toggle("mode-hard", config.mode === "hard");
  applyTimerVisibility();

  const userSeed = (config.seedStr || "").trim();
  const autoSeedUsed = (userSeed.length === 0);
  const runSeed = autoSeedUsed ? genAutoSeed() : userSeed;

  game.runSeedStr = runSeed;

  // 用 runSeed 生成棋盘，但不污染用户配置（seed 为空时 New 仍会每次随机）
  const runConfig = { ...config, seedStr: runSeed };

  // 只有“用户没填 seed”时，才在底部显示 seed 方便复制
  setSeedShare(autoSeedUsed ? runSeed : "");

  const { cells } = buildBoard(runConfig);

  game.total = config.pieceCount; // ensure font uses correct N
  renderBoard(cells);
  resetRunState(config.pieceCount);
  applyHardTextRule();

  game.state = STATE.PLAYING;
  setCellsVisible(true);
  startTimer();
  updateHUD();
}

function finishGame() {
  freezeElapsed();
  stopTimer();
  game.state = STATE.FINISHED;
  applyHardTextRule();
  updateHUD();

  gaEvent("game_complete", {
    piece_count: game.total,             // 12/20/50/100
    mode: game.config?.mode || "unknown",
    time_ms: Math.round(game.elapsedMs), // 你的用时
  });
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

function showWrongHint() {
  bannerLockUntil = performance.now() + 180;
  setBanner("Wrong!", "bad");
}

function onCellClick(num) {
  if (game.state !== STATE.PLAYING) return;

  if (num === game.next) {
    const polyEl = game.numToPolygon.get(num);
    const textEl = game.numToText.get(num);

    if (polyEl) {
      polyEl.classList.add("hit");
      window.setTimeout(() => polyEl.classList.remove("hit"), 160);
    }
    if (textEl) {
      textEl.classList.add("done");
      window.setTimeout(() => textEl.classList.remove("done"), 160);
    }

    game.current = num;
    game.next = num + 1;
    bannerLockUntil = 0;

    // Easy: mark cell permanently
    if (game.config?.mode === "easy" && polyEl) {
      polyEl.classList.add("easyDone");
    }

    // Hard: after clicking 1, hide unfinished numbers; after each correct click, reveal only finished ones
    applyHardTextRule();

    if (game.next > game.total) {
      finishGame();
      return;
    }
    updateHUD();
  } else {
    const textEl = game.numToText.get(num);
    if (textEl) {
      textEl.classList.add("wrong");
      window.setTimeout(() => textEl.classList.remove("wrong"), 180);
    }
    flashWrong();
    showWrongHint();
    addPenalty(game.config.wrongPenaltySec);
    showPenaltyHint(game.config.wrongPenaltySec);
  }
}

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
