(function () {
  'use strict';

  // Kanji and Japanese Character Regex Ranges
  const KANJI_REGEX = /[\u4e00-\u9faf\u3400-\u4dbf]/;
  const JAPANESE_CHAR_REGEX = /[\u3040-\u30ff\u4e00-\u9faf]/;

  let kuromojiTokenizer = null;
  let initPromise = null;

  const DEBUG = false;
  // Log output to console if DEBUG is enabled
  const log = (...args) => DEBUG && console.log('[Netflix Dual Subtitles]', ...args);
  // Log error output to console
  const logError = (...args) => console.error('[Netflix Dual Subtitles]', ...args);

  // Safe lookup for Kuromoji library in global environment
  function getKuromojiLib() {
    if (typeof kuromoji !== 'undefined') return kuromoji;
    if (typeof window !== 'undefined' && window.kuromoji) return window.kuromoji;
    if (typeof global !== 'undefined' && global.kuromoji) return global.kuromoji;
    return null;
  }

  // Initialize Kuromoji.js morphological analyzer
  function initKuromoji() {
    if (kuromojiTokenizer) return Promise.resolve(kuromojiTokenizer);
    if (initPromise) return initPromise;

    const kuromojiLib = getKuromojiLib();

    if (!kuromojiLib) {
      logError('Kuromoji library not loaded');
      return Promise.resolve(null);
    }

    initPromise = new Promise((resolve) => {
      try {
        let dictPath = './dict/';
        try {
          if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id && chrome.runtime.getURL) {
            dictPath = chrome.runtime.getURL('dict/');
          }
        } catch (e) {}
        log('Initializing Kuromoji.js with dictPath:', dictPath);

        kuromojiLib.builder({ dicPath: dictPath }).build((err, tokenizer) => {
          if (err) {
            logError('Error building Kuromoji tokenizer:', err);
            initPromise = null;
            resolve(null);
            return;
          }
          kuromojiTokenizer = tokenizer;
          log('Kuromoji.js Tokenizer built successfully!');
          resolve(kuromojiTokenizer);
        });
      } catch (e) {
        logError('Exception initializing Kuromoji:', e);
        initPromise = null;
        resolve(null);
      }
    });

    return initPromise;
  }

  // Convert Katakana characters to Hiragana
  function kataToHira(str) {
    if (!str) return '';
    return str.replace(/[\u30a1-\u30f6]/g, (match) => {
      return String.fromCharCode(match.charCodeAt(0) - 0x60);
    });
  }

  // Escape HTML special characters for safe DOM insertion
  function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Trim Okurigana and align Kanji stems with Kana reading annotations
  function alignFurigana(surface, reading) {
    if (!KANJI_REGEX.test(surface)) {
      return escapeHtml(surface);
    }

    if (!reading || reading === surface) {
      return escapeHtml(surface);
    }

    // 1. Trim common prefix (e.g. お, ご)
    let prefixLen = 0;
    while (
      prefixLen < surface.length &&
      prefixLen < reading.length &&
      surface[prefixLen] === reading[prefixLen] &&
      !KANJI_REGEX.test(surface[prefixLen])
    ) {
      prefixLen++;
    }

    const prefix = surface.slice(0, prefixLen);
    let restSurface = surface.slice(prefixLen);
    let restReading = reading.slice(prefixLen);

    // 2. Trim common suffix (Okurigana e.g. こえる in 聞こえる, べます in 食べます)
    let suffixLen = 0;
    while (
      suffixLen < restSurface.length &&
      suffixLen < restReading.length &&
      restSurface[restSurface.length - 1 - suffixLen] === restReading[restReading.length - 1 - suffixLen] &&
      !KANJI_REGEX.test(restSurface[restSurface.length - 1 - suffixLen])
    ) {
      suffixLen++;
    }

    const suffix = restSurface.slice(restSurface.length - suffixLen);
    const kanjiStem = restSurface.slice(0, restSurface.length - suffixLen);
    const readingStem = restReading.slice(0, restReading.length - suffixLen);

    if (kanjiStem && readingStem && KANJI_REGEX.test(kanjiStem)) {
      return `${escapeHtml(prefix)}<ruby>${escapeHtml(kanjiStem)}<rt>${escapeHtml(readingStem)}</rt></ruby>${escapeHtml(suffix)}`;
    }

    return `${escapeHtml(prefix)}${escapeHtml(kanjiStem)}${escapeHtml(suffix)}`;
  }

  // Parse text and return HTML with ruby furigana annotations
  function toFurigana(text) {
    if (!text || typeof text !== 'string' || !JAPANESE_CHAR_REGEX.test(text)) {
      return escapeHtml(text || '');
    }

    if (!kuromojiTokenizer) {
      initKuromoji();
      return escapeHtml(text);
    }

    try {
      const tokens = kuromojiTokenizer.tokenize(text);
      let resultHtml = '';
      for (const token of tokens) {
        const surface = token.surface_form;
        const reading = token.reading ? kataToHira(token.reading) : null;
        resultHtml += alignFurigana(surface, reading);
      }
      return resultHtml;
    } catch (e) {
      logError('Kuromoji Furigana conversion error:', e);
      return escapeHtml(text);
    }
  }

  initKuromoji();

  window.NetflixDualSubsFurigana = {
    toFurigana: toFurigana,
    alignFurigana: alignFurigana,
    initKuromoji: initKuromoji,
    isJapanese: (str) => typeof str === 'string' && JAPANESE_CHAR_REGEX.test(str),
    isReady: () => kuromojiTokenizer !== null
  };

})();
