(function () {
  'use strict';

  const SOUND_MAP = {
    'card-hover':       '/sounds/select-chime.wav',
    'card-tap':         '/sounds/card-tap.wav',
    'card-confirm':     '/sounds/alt-option.wav',
    'transition-slash': '/sounds/transition-slash.wav',
    'button-hover':     '/sounds/button-hover.wav',
    'button-confirm':   '/sounds/button-confirm.wav',
    'menu-open':        '/sounds/menu-open.wav',
    'slash':            '/sounds/slash.mp3',
    'slash-alt':        '/sounds/slash-alt.mp3',
    'mega-transition':  '/sounds/mega-transition.wav',
  };

  const SOUND_VOLUME = {
    'card-hover':       0.12,
    'card-tap':         0.55,
    'card-confirm':     0.75,
    'transition-slash': 0.80,
    'button-hover':     0.10,
    'button-confirm':   0.70,
    'menu-open':        0.55,
    'slash':            0.9,
    'slash-alt':        0.9,
    'mega-transition':  0.70,
  };

  const audioCache = new Map();
  function getAudio(src) {
    if (audioCache.has(src)) return audioCache.get(src);
    const a = new Audio(src);
    a.preload = 'auto';
    audioCache.set(src, a);
    return a;
  }

  // Prime engine on first pointer gesture so hover sounds don't get blocked
  window.addEventListener('pointerdown', function primeAudio() {
    const a = getAudio(SOUND_MAP['card-hover']);
    const p = a.play();
    if (p) p.then(() => { a.pause(); a.currentTime = 0; }).catch(() => {});
    window.removeEventListener('pointerdown', primeAudio);
  }, { once: true });

  const lastPlayed = {};

  const SoundEngine = {
    play: function (name) {
      if (this.isMuted()) return;
      const src = SOUND_MAP[name];
      if (!src) return;

      const minGap = name === 'char-stamp' ? 80 : 40;
      const now = performance.now();
      if ((now - (lastPlayed[name] || 0)) < minGap) return;
      lastPlayed[name] = now;

      try {
        const audio = getAudio(src);
        const clone = audio.cloneNode();
        clone.volume = SOUND_VOLUME[name] !== undefined ? SOUND_VOLUME[name] : 0.5;
        const p = clone.play();
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (e) {}
    },

    setMuted: function (muted) {
      try { localStorage.setItem('sc-muted', muted ? '1' : '0'); } catch (e) {}
    },

    isMuted: function () {
      try { return localStorage.getItem('sc-muted') === '1'; } catch (e) { return false; }
    },
  };

  window.SoundEngine = SoundEngine;
})();
