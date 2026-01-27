"use strict";

/**
 * rng.js
 * - Seeded RNG helpers used by board generation.
 * - Exposes window.JC.makeRng(seedStr) and window.JC.shuffleInPlace(arr, rand)
 */
(function (global) {
  const JC = (global.JC = global.JC || {});

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
    const s =
      seedStr && seedStr.trim().length > 0 ? seedStr.trim() : String(Date.now());
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

  JC.makeRng = makeRng;
  JC.shuffleInPlace = shuffleInPlace;
})(window);
