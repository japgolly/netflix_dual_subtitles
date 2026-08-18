import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Netflix Mock Data Integration Tests', () => {
  let parseJSONTimedText, parseTTML, parseVTT, extractTrackId, extractTrackLabel, formatLanguageLabel, mergeCues;

  beforeAll(() => {
    // Mock Chrome extension API in jsdom environment
    global.chrome = {
      runtime: {
        getURL: (relPath) => path.resolve(__dirname, '../' + relPath)
      },
      storage: {
        sync: {
          get: (keys, cb) => cb({}),
          set: () => {}
        }
      }
    };

    require('../injected.js');

    const injectedUtils = window.__netflixDualSubsInjectedUtils;
    parseJSONTimedText = injectedUtils.parseJSONTimedText;
    parseTTML = injectedUtils.parseTTML;
    parseVTT = injectedUtils.parseVTT;

    require('../content.js');

    const contentUtils = window.__netflixDualSubsContentUtils;
    formatLanguageLabel = contentUtils.formatLanguageLabel;
  });

  describe('Netflix Event-Based JSON TimedText Stream Parsing', () => {
    it('should parse realistic Netflix JSON timedtext event stream with nested lines', () => {
      const mockNetflixJson = {
        events: [
          {
            start: 1000,
            duration: 3500,
            lines: [
              { text: 'こんにちは、世界！' },
              { text: 'Netflix TimedText Line 2' }
            ]
          },
          {
            start: 5000,
            duration: 4000,
            text: ['Simple text array item 1', 'item 2']
          }
        ]
      };

      const cues = parseJSONTimedText(mockNetflixJson);
      expect(cues.length).toBe(2);

      // Event 1
      expect(cues[0].start).toBe(1.0);
      expect(cues[0].end).toBe(4.5);
      expect(cues[0].text).toBe('こんにちは、世界！\nNetflix TimedText Line 2');

      // Event 2
      expect(cues[1].start).toBe(5.0);
      expect(cues[1].end).toBe(9.0);
      expect(cues[1].text).toBe('Simple text array item 1 item 2');
    });

    it('should parse Netflix result.timedtext format', () => {
      const mockResultJson = {
        result: {
          timedtext: [
            {
              start: 2000,
              dur: 3000,
              lines: [{ text: 'Result TimedText Cue' }]
            }
          ]
        }
      };

      const cues = parseJSONTimedText(mockResultJson);
      expect(cues.length).toBe(1);
      expect(cues[0].start).toBe(2.0);
      expect(cues[0].end).toBe(5.0);
      expect(cues[0].text).toBe('Result TimedText Cue');
    });
  });

  describe('Netflix TTML / DFXP XML Payload Parsing', () => {
    it('should parse realistic Netflix TTML XML with begin, end, and br line breaks', () => {
      const mockTtml = `
        <tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling">
          <body>
            <div>
              <p begin="00:00:01.500" end="00:00:05.000">字幕ライン1<br/>字幕ライン2</p>
              <p begin="00:00:06.000" dur="00:00:03.500"><span>次の字幕セリフ</span></p>
            </div>
          </body>
        </tt>
      `;

      const cues = parseTTML(mockTtml);
      expect(cues.length).toBe(2);

      expect(cues[0].start).toBe(1.5);
      expect(cues[0].end).toBe(5.0);
      expect(cues[0].text).toBe('字幕ライン1\n字幕ライン2');

      expect(cues[1].start).toBe(6.0);
      expect(cues[1].end).toBe(9.5);
      expect(cues[1].text).toBe('次の字幕セリフ');
    });

    it('should handle br tags with XML attributes while ignoring non-break tags like brg or brand', () => {
      const xmlWithBrg = `
        <tt>
          <body>
            <div>
              <p begin="00:00:01.000" end="00:00:03.000">Line 1<br xmlns="http://www.w3.org/ns/ttml"/>Line 2<brg>ignored tag</brg></p>
            </div>
          </body>
        </tt>
      `;

      const cues = parseTTML(xmlWithBrg);
      expect(cues.length).toBe(1);
      expect(cues[0].text).toBe('Line 1\nLine 2ignored tag');
    });
  });

  describe('Netflix Player Track & Language Metadata Resolution', () => {
    it('should format regional BCP-47 language codes cleanly', () => {
      expect(formatLanguageLabel('undefined', 'ja-JP')).toBe('Japanese');
      expect(formatLanguageLabel('undefined', 'zh-Hans')).toBe('Chinese');
      expect(formatLanguageLabel('undefined', 'pt-BR')).toBe('Portuguese');
      expect(formatLanguageLabel('undefined', 'es-ES')).toBe('Spanish');
      expect(formatLanguageLabel('undefined', 'de-DE')).toBe('German');
    });

    it('should preserve native raw track labels when available', () => {
      expect(formatLanguageLabel('Japanese [CC]', 'ja')).toBe('Japanese [CC]');
      expect(formatLanguageLabel('English [Original]', 'en')).toBe('English [Original]');
    });
  });

  describe('Subtitle Payload Language Detection & Race Condition Guard', () => {
    it('should accurately detect language from TTML XML, JSON, and text script heuristic', () => {
      const injectedUtils = window.__netflixDualSubsInjectedUtils;

      const jaTtml = `<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="ja"><body><div><p begin="00:00:01.000" end="00:00:04.000">日本語字幕</p></div></body></tt>`;
      const enTtml = `<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en-US"><body><div><p begin="00:00:01.000" end="00:00:04.000">English line</p></div></body></tt>`;

      expect(injectedUtils.detectSubtitleLanguage(jaTtml, null, [{ start: 1, end: 4, text: '日本語字幕' }])).toBe('ja');
      expect(injectedUtils.detectSubtitleLanguage(enTtml, null, [{ start: 1, end: 4, text: 'English line' }])).toBe('en-US');

      // Content fallback
      const noHeaderJa = `<tt><body><div><p begin="00:00:01.000" end="00:00:04.000">こんにちは</p></div></body></tt>`;
      expect(injectedUtils.detectSubtitleLanguage(noHeaderJa, null, [{ start: 1, end: 4, text: 'こんにちは' }])).toBe('ja');

      expect(injectedUtils.isJapaneseText('ありがとうございます')).toBe(true);
      expect(injectedUtils.isJapaneseText('English words')).toBe(false);
    });

    it('should guard against in-flight primary English subtitle responses overwriting pending Japanese track', async () => {
      const injectedUtils = window.__netflixDualSubsInjectedUtils;
      const messages = [];
      const listener = (event) => {
        if (event.data && event.data.type === 'NETFLIX_DUAL_SUB_CAPTURED') {
          messages.push(event.data);
        }
      };
      window.addEventListener('message', listener);

      const enTrack = { id: 'ls_en_1', bcp47: 'en', language: 'en', languageDescription: 'English' };
      const jaTrack = { id: 'ls_ja_1', bcp47: 'ja', language: 'ja', languageDescription: 'Japanese' };

      window.netflix = {
        appContext: {
          state: {
            playerApp: {
              getAPI: () => ({
                videoPlayer: {
                  getAllPlayerSessionIds: () => ['session_test_123'],
                  getVideoPlayerBySessionId: () => ({
                    getTimedTextTrackList: () => [enTrack, jaTrack],
                    getTimedTextTrack: () => enTrack,
                    setTimedTextTrack: () => {}
                  })
                }
              })
            }
          }
        }
      };

      // Trigger fetch for Japanese track
      window.postMessage({
        type: 'NETFLIX_DUAL_SUB_FETCH_TRACK',
        trackId: 'ls_ja_1'
      }, '*');

      await new Promise(resolve => setTimeout(resolve, 20));

      // English response arrives while Japanese is pending
      const englishTtml = `<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en">
        <body><div><p begin="00:00:01.000" end="00:00:04.000">Hello, welcome!</p></div></body>
      </tt>`;
      injectedUtils.handleInterceptedSubtitles(englishTtml, 'https://www.netflix.com/net/timedtext/en');

      // Japanese response arrives
      const japaneseTtml = `<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="ja">
        <body><div><p begin="00:00:01.000" end="00:00:04.000">ようこそ！</p></div></body>
      </tt>`;
      injectedUtils.handleInterceptedSubtitles(japaneseTtml, 'https://www.netflix.com/net/timedtext/ja');

      await new Promise(resolve => setTimeout(resolve, 20));

      window.removeEventListener('message', listener);

      const englishMsg = messages.find(m => m.url.includes('/en'));
      expect(englishMsg).toBeDefined();
      expect(englishMsg.bcp47).toBe('en');
      expect(englishMsg.trackId).not.toBe('ls_ja_1');

      const japaneseMsg = messages.find(m => m.url.includes('/ja'));
      expect(japaneseMsg).toBeDefined();
      expect(japaneseMsg.trackId).toBe('ls_ja_1');
      expect(japaneseMsg.bcp47).toBe('ja');
      expect(japaneseMsg.cues[0].text).toBe('ようこそ！');
    });
  });
});
