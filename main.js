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
  seedShare: $("#seedShare"),
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
  setSeedShare("");
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

  els.seedShare.textContent = `seed\n${s}`;  // 去掉 random 字眼
  els.seedShare.classList.remove("hidden");
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

function buildBoard(config) {
  return JC.buildBoard(config, game.size);
}

function clearSvg(svg) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
}

function getFontSizeForN(n) {
  const size = Math.round(170 / Math.sqrt(n));
  return Math.max(18, Math.min(44, size));
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

  const userSeed = (config.seedStr || "").trim();
  const autoSeedUsed = (userSeed.length === 0);
  const runSeed = autoSeedUsed ? genAutoSeed() : userSeed;

  game.runSeedStr = runSeed;

  // 用 runSeed 生成棋盘，但不污染用户配置（seed 为空时 New 仍会每次随机）
  const runConfig = { ...config, seedStr: runSeed };

  // 只有“用户没填 seed”时，才在底部显示 seed 方便复制
  setSeedShare(runSeed);

  const { cells } = buildBoard(runConfig);

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
