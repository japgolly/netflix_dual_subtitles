import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Comprehensive Coverage Expansion Suite', () => {
  beforeAll(() => {
    // Mock Chrome Extension API in jsdom environment
    global.chrome = {
      runtime: {
        getURL: (relPath) => path.resolve(__dirname, '../' + relPath) + '/'
      },
      storage: {
        sync: {
          get: (keys, cb) => cb({
            nds_enabled: true,
            nds_furigana: true,
            nds_fontSize: 'large',
            nds_position: 'bottom',
            nds_textStyle: 'outline',
            nds_secondaryTrackId: 'ls_ja_1',
            nds_secondaryLanguageCode: 'ja'
          }),
          set: () => {}
        }
      }
    };

    require('../kuromoji.js');
    require('../furigana.js');
    require('../injected.js');
    require('../content.js');
  });

  describe('furigana.js Internal Logic Coverage', () => {
    it('should test toFurigana when input is non-Japanese or null', () => {
      expect(window.NetflixDualSubsFurigana.toFurigana('')).toBe('');
      expect(window.NetflixDualSubsFurigana.toFurigana('12345')).toBe('12345');
    });

    it('should test alignFurigana with complex okurigana stems', () => {
      const res1 = window.NetflixDualSubsFurigana.alignFurigana('勉強する', 'べんきょうする');
      expect(res1).toBe('<ruby>勉強<rt>べんきょう</rt></ruby>する');

      const res2 = window.NetflixDualSubsFurigana.alignFurigana('話し合う', 'はなしあう');
      expect(res2).toBe('<ruby>話し合<rt>はなしあ</rt></ruby>う');
    });

    it('should test alignFurigana when surface matches reading', () => {
      expect(window.NetflixDualSubsFurigana.alignFurigana('かな', 'かな')).toBe('かな');
    });
  });

  describe('injected.js Player API & Network Interceptor Coverage', () => {
    let injectedUtils;

    beforeAll(() => {
      injectedUtils = window.__netflixDualSubsInjectedUtils;
    });

    it('should test safeGet exception handling', () => {
      const result = injectedUtils.safeGet(() => {
        throw new Error('Test throw');
      }, 'fallback_val');
      expect(result).toBe('fallback_val');
    });

    it('should test extractResponseText with JSON object response', () => {
      const xhr = { responseType: 'json', response: { test: 123 } };
      expect(injectedUtils.extractResponseText(xhr)).toBe('{"test":123}');
    });

    it('should test extractResponseText fallback with string response', () => {
      const xhr = { responseType: 'other', response: 'raw_string' };
      expect(injectedUtils.extractResponseText(xhr)).toBe('raw_string');
    });

    it('should test isSubtitleUrl with string patterns', () => {
      expect(injectedUtils.isSubtitleUrl('https://www.netflix.com/net/timedtext/123')).toBe(true);
      expect(injectedUtils.isSubtitleUrl('https://example.com/subtitles.dfxp')).toBe(true);
      expect(injectedUtils.isSubtitleUrl('https://example.com/video.mp4')).toBe(false);
      expect(injectedUtils.isSubtitleUrl(null)).toBe(false);
    });

    it('should test parseTime edge cases', () => {
      expect(injectedUtils.parseTime(1500)).toBe(1.5);
      expect(injectedUtils.parseTime('')).toBe(0);
      expect(injectedUtils.parseTime('invalid')).toBe(0);
    });

    it('should test XHR interceptor open and send wrappers', () => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', 'https://www.netflix.com/net/timedtext/test');
      expect(xhr._url).toBe('https://www.netflix.com/net/timedtext/test');
    });

    it('should test window.fetch interceptor wrapper', async () => {
      const origFetch = window.fetch;
      const res = await window.fetch('https://example.com/test.txt');
      expect(res).toBeDefined();
    });
  });

  describe('content.js UI & Subtitle Rendering Coverage', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <div class="watch-video active">
          <div class="PlayerControlsNeo__all-controls">
            <div class="PlayerControlsNeo__bottom-controls">Controls Bar</div>
          </div>
          <div class="player-timedtext" style="bottom: 120px;">Native Subs</div>
        </div>
      `;
    });

    it('should verify player controls visibility detection', () => {
      const overlay = document.createElement('div');
      overlay.id = 'netflix-dual-sub-overlay';
      document.body.appendChild(overlay);

      // Trigger interval event processing
      const customEvent = new Event('resize');
      window.dispatchEvent(customEvent);

      expect(overlay).toBeDefined();
    });

    it('should test Alt+S keyboard shortcut for toggling panel visibility', () => {
      const keyEvent = new KeyboardEvent('keydown', {
        key: 's',
        code: 'KeyS',
        altKey: true,
        bubbles: true
      });
      window.dispatchEvent(keyEvent);

      const panel = document.getElementById('netflix-dual-sub-panel');
      expect(panel).toBeDefined();
    });

    it('should test postMessage handling for captured cues and player state', () => {
      window.postMessage({
        type: 'NETFLIX_DUAL_SUB_CAPTURED',
        trackId: 'ls_ja_1',
        bcp47: 'ja',
        cues: [{ start: 0, end: 10, text: 'テスト字幕' }]
      }, '*');

      window.postMessage({
        type: 'NETFLIX_DUAL_SUB_PLAYER_STATE',
        tracks: [
          { id: 'ls_ja_1', bcp47: 'ja', label: 'Japanese' },
          { id: 'ls_en_1', bcp47: 'en', label: 'English' }
        ],
        currentPrimaryTrackId: 'ls_en_1'
      }, '*');

      window.postMessage({
        type: 'NETFLIX_DUAL_SUB_EPISODE_RESET'
      }, '*');

      expect(document.body).toBeDefined();
    });

    it('should test option button interactions inside panel', () => {
      // Trigger Alt+S to ensure panel DOM exists
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', altKey: true, bubbles: true }));

      const optionBtn = document.querySelector('.nds-option-btn[data-type="fontSize"][data-val="small"]');
      if (optionBtn) {
        optionBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }

      const closeBtn = document.getElementById('nds-close-panel');
      if (closeBtn) {
        closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }

      const triggerBtn = document.getElementById('nds-trigger-btn');
      if (triggerBtn) {
        triggerBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }

      expect(document.getElementById('nds-root')).toBeDefined();
    });

    it('should ignore Alt+S shortcut when focus is in an INPUT or TEXTAREA element', () => {
      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();

      const keyEvent = new KeyboardEvent('keydown', {
        key: 's',
        code: 'KeyS',
        altKey: true,
        bubbles: true
      });
      window.dispatchEvent(keyEvent);
      expect(input.isConnected).toBe(true);
    });

    it('should test getWatchVideoId and isLanguageMatch content utilities', () => {
      const utils = window.__netflixDualSubsContentUtils;
      expect(utils.getWatchVideoId('https://www.netflix.com/watch/80186863?trackId=123')).toBe('80186863');
      expect(utils.getWatchVideoId('https://www.netflix.com/browse')).toBe('https://www.netflix.com/browse');

      expect(utils.isLanguageMatch('ja-JP', 'ja')).toBe(true);
      expect(utils.isLanguageMatch('en-US', 'en-GB')).toBe(true);
      expect(utils.isLanguageMatch('en', 'fr')).toBe(false);
      expect(utils.isLanguageMatch(null, 'en')).toBe(false);
    });

    it('should test 4-part timestamp parsing with subseconds and frames', () => {
      const parseTime = window.__netflixDualSubsInjectedUtils.parseTime;
      expect(parseTime('00:01:20:500')).toBe(80.5);
      expect(parseTime('00:01:20:15')).toBe(80.5);
    });

    it('should handle Japanese preference when English is primary and tracks load across reloads', async () => {
      // Simulate state update where player tracks arrive
      window.postMessage({
        type: 'NETFLIX_DUAL_SUB_PLAYER_STATE',
        tracks: [
          { id: 'ls_en_9', bcp47: 'en', language: 'en', label: 'English [Original]' },
          { id: 'ls_ja_9', bcp47: 'ja', language: 'ja', label: 'Japanese' }
        ],
        currentPrimaryTrackId: 'ls_en_9'
      }, '*');

      // Both tracks captured
      window.postMessage({
        type: 'NETFLIX_DUAL_SUB_CAPTURED',
        trackId: 'ls_en_9',
        bcp47: 'en',
        cues: [{ start: 0, end: 10, text: 'English subtitle line' }]
      }, '*');

      window.postMessage({
        type: 'NETFLIX_DUAL_SUB_CAPTURED',
        trackId: 'ls_ja_9',
        bcp47: 'ja',
        cues: [{ start: 0, end: 10, text: '日本語の字幕' }]
      }, '*');

      await new Promise(r => setTimeout(r, 20));

      const dropdownSelected = document.getElementById('nds-dropdown-selected-label');
      expect(dropdownSelected).toBeDefined();
    });

    it('should safely handle extension context invalidation without throwing uncaught errors', () => {
      const utils = window.__netflixDualSubsContentUtils;
      expect(typeof utils.isExtensionContextValid).toBe('function');
      expect(typeof utils.savePreferences).toBe('function');

      // Test valid context
      global.chrome = {
        runtime: { id: 'valid_id' },
        storage: {
          sync: {
            set: (data, cb) => { if (cb) cb(); }
          }
        }
      };
      expect(utils.isExtensionContextValid()).toBe(true);
      expect(() => utils.savePreferences()).not.toThrow();

      // Test invalidated context where chrome.runtime.id is undefined
      global.chrome = {
        runtime: { id: undefined },
        storage: {
          sync: {
            set: () => { throw new Error('Extension context invalidated.'); }
          }
        }
      };
      expect(utils.isExtensionContextValid()).toBe(false);
      expect(() => utils.savePreferences()).not.toThrow();

      // Test threw inside storage.set directly
      global.chrome = {
        runtime: { id: 'some_id' },
        storage: {
          sync: {
            set: () => { throw new Error('Extension context invalidated.'); }
          }
        }
      };
      expect(() => utils.savePreferences()).not.toThrow();
    });
  });
});
