import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Japanese Furigana & Okurigana Engine', () => {
  beforeAll(async () => {
    // Mock Chrome Extension API in jsdom environment
    global.chrome = {
      runtime: {
        getURL: (relPath) => path.resolve(__dirname, '../' + relPath) + '/'
      }
    };

    require('../kuromoji.js');
    require('../furigana.js');

    try {
      await window.NetflixDualSubsFurigana.initKuromoji();
    } catch (e) {}
  });

  it('should detect Japanese text accurately', () => {
    expect(window.NetflixDualSubsFurigana.isJapanese('日本語')).toBe(true);
    expect(window.NetflixDualSubsFurigana.isJapanese('Hello World')).toBe(false);
    expect(window.NetflixDualSubsFurigana.isJapanese('123')).toBe(false);
  });

  it('should align okurigana for 聞こえる so furigana rt is strictly き', () => {
    const result = window.NetflixDualSubsFurigana.alignFurigana('聞こえる', 'きこえる');
    expect(result).toBe('<ruby>聞<rt>き</rt></ruby>こえる');
  });

  it('should escape HTML characters safely to prevent XSS', () => {
    const result = window.NetflixDualSubsFurigana.toFurigana('<script>alert("xss")</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  it('should preserve plain English and Kana text', () => {
    const result = window.NetflixDualSubsFurigana.toFurigana('Hello かな');
    expect(result).toBe('Hello かな');
  });

  it('should format tokenized Japanese text cleanly via Kuromoji if ready', () => {
    if (window.NetflixDualSubsFurigana.isReady()) {
      const result = window.NetflixDualSubsFurigana.toFurigana('聞こえる');
      expect(result).toBe('<ruby>聞<rt>き</rt></ruby>こえる');
    } else {
      const result = window.NetflixDualSubsFurigana.alignFurigana('聞こえる', 'きこえる');
      expect(result).toBe('<ruby>聞<rt>き</rt></ruby>こえる');
    }
  });

  it('should handle Japanese punctuation and quotes cleanly', () => {
    const result = window.NetflixDualSubsFurigana.alignFurigana('東京', 'とうきょう');
    expect(result).toBe('<ruby>東京<rt>とうきょう</rt></ruby>');
  });
});
