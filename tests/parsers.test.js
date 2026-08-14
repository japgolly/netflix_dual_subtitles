import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Subtitle Payload & Timestamp Parsers', () => {
  let parseTime, parseTTML, parseJSONTimedText, parseVTT, isSubtitleUrl, extractResponseText;

  beforeAll(() => {
    require('../injected.js');

    const utils = window.__netflixDualSubsInjectedUtils;
    parseTime = utils.parseTime;
    parseTTML = utils.parseTTML;
    parseJSONTimedText = utils.parseJSONTimedText;
    parseVTT = utils.parseVTT;
    isSubtitleUrl = utils.isSubtitleUrl;
    extractResponseText = utils.extractResponseText;
  });

  describe('Subtitle URL Matcher (isSubtitleUrl)', () => {
    it('should correctly match Netflix subtitle URLs', () => {
      expect(isSubtitleUrl('https://www.netflix.com/net/timedtext/12345')).toBe(true);
      expect(isSubtitleUrl('https://example.com/subtitles.vtt')).toBe(true);
      expect(isSubtitleUrl('https://example.com/subtitles.ttml')).toBe(true);
      expect(isSubtitleUrl('https://example.com/video.mp4')).toBe(false);
    });
  });

  describe('XHR Response Extraction (extractResponseText)', () => {
    it('should handle text responseType', () => {
      const xhr = { responseType: 'text', responseText: 'sample text' };
      expect(extractResponseText(xhr)).toBe('sample text');
    });

    it('should handle arraybuffer responseType without throwing InvalidStateError', () => {
      const encoder = new TextEncoder();
      const buf = encoder.encode('binary text').buffer;
      const xhr = { responseType: 'arraybuffer', response: buf };
      expect(extractResponseText(xhr)).toBe('binary text');
    });
  });

  describe('Timestamp Parsing (parseTime)', () => {
    it('should parse millisecond format (e.g. 1500ms -> 1.5s)', () => {
      expect(parseTime('1500ms')).toBe(1.5);
    });

    it('should parse second format (e.g. 45s -> 45.0s)', () => {
      expect(parseTime('45s')).toBe(45.0);
    });

    it('should parse Netflix tick format (e.g. 10000000t -> 1.0s)', () => {
      expect(parseTime('10000000t')).toBe(1.0);
    });

    it('should parse HH:MM:SS,mmm comma separator format', () => {
      expect(parseTime('00:01:23,456')).toBe(83.456);
    });

    it('should parse short MM:SS format (e.g. 05:30 -> 330.0s)', () => {
      expect(parseTime('05:30')).toBe(330.0);
    });
  });

  describe('TTML XML Parser', () => {
    it('should parse TTML XML subtitles directly from injected.js', () => {
      const xml = `
        <tt>
          <body>
            <div>
              <p begin="00:01:10.500" end="00:01:15.000">Hello World<br/>Second Line</p>
            </div>
          </body>
        </tt>
      `;
      const cues = parseTTML(xml);
      expect(cues.length).toBe(1);
      expect(cues[0].start).toBe(70.5);
      expect(cues[0].end).toBe(75.0);
      expect(cues[0].text).toBe('Hello World\nSecond Line');
    });
  });

  describe('WebVTT Parser', () => {
    it('should parse WebVTT subtitles directly from injected.js', () => {
      const vtt = `WEBVTT

00:00:02.000 --> 00:00:05.500
Subtitle Line 1
Subtitle Line 2
`;
      const cues = parseVTT(vtt);
      expect(cues.length).toBe(1);
      expect(cues[0].start).toBe(2.0);
      expect(cues[0].end).toBe(5.5);
      expect(cues[0].text).toBe('Subtitle Line 1\nSubtitle Line 2');
    });

    it('should ignore thumbnail sprite VTT cues with #xywh or image urls', () => {
      const vttWithThumbs = `WEBVTT

00:00:00.000 --> 00:00:05.000
#xywh=0,0,160,90

00:00:05.000 --> 00:00:10.000
https://example.com/thumb.jpg#xywh=160,0,160,90

00:00:10.000 --> 00:00:15.000
Real Subtitle Text
`;
      const cues = parseVTT(vttWithThumbs);
      expect(cues.length).toBe(1);
      expect(cues[0].text).toBe('Real Subtitle Text');
    });
  });

  describe('Netflix JSON TimedText Parser', () => {
    it('should parse Netflix event-based JSON timedtext directly from injected.js', () => {
      const jsonObj = {
        events: [
          {
            start: 2000,
            duration: 3500,
            lines: [{ text: 'JSON Subtitle Line 1' }, { text: 'JSON Subtitle Line 2' }]
          }
        ]
      };
      const cues = parseJSONTimedText(jsonObj);
      expect(cues.length).toBe(1);
      expect(cues[0].start).toBe(2.0);
      expect(cues[0].end).toBe(5.5);
      expect(cues[0].text).toBe('JSON Subtitle Line 1\nJSON Subtitle Line 2');
    });

    it('should parse Netflix JSON with tStartMs, dDurationMs, and segs format', () => {
      const jsonObj = {
        events: [
          {
            tStartMs: 1200,
            dDurationMs: 2800,
            segs: [
              { utf8: 'Hello ' },
              { utf8: 'World' }
            ]
          },
          {
            tStartMs: 5000,
            dDurationMs: 3000,
            lines: [
              { segs: [{ utf8: 'Line 1' }] },
              { segs: [{ utf8: 'Line 2' }] }
            ]
          }
        ]
      };
      const cues = parseJSONTimedText(jsonObj);
      expect(cues.length).toBe(2);
      expect(cues[0].start).toBe(1.2);
      expect(cues[0].end).toBe(4.0);
      expect(cues[0].text).toBe('Hello World');
      expect(cues[1].text).toBe('Line 1\nLine 2');
    });
  });
});
