(function () {
  'use strict';

  const SOUND_MAP = {
    'card-hover':       '/sounds/option-select.wav',
    'card-tap':         '/sounds/confirm-chime-menu.wav',
    'card-confirm':     '/sounds/confirm-chime-menu.wav',
    'transition-slash': '/sounds/slash.mp3',
    'button-hover':     '/sounds/option-select.wav',
    'button-confirm':   '/sounds/confirm-chime-menu.wav',
    'mega-transition':  '/sounds/slash-alt.mp3',
  };

  const SOUND_VOLUME = {
    'card-hover':       0.18,
    'card-tap':         0.70,
    'card-confirm':     0.70,
    'transition-slash': 0.90,
    'button-hover':     0.15,
    'button-confirm':   0.70,
    'mega-transition':  0.90,
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
