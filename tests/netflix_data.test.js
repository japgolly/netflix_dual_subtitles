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
});
