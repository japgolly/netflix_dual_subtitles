import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Internationalized Language Label Formatter', () => {
  let formatLanguageLabel;

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

    require('../content.js');

    formatLanguageLabel = window.__netflixDualSubsContentUtils.formatLanguageLabel;
  });

  it('should preserve valid raw labels from content.js', () => {
    expect(formatLanguageLabel('Japanese [CC]', 'ja')).toBe('Japanese [CC]');
    expect(formatLanguageLabel('English [Original]', 'en')).toBe('English [Original]');
  });

  it('should format BCP-47 codes directly from content.js when raw label is undefined or unk', () => {
    expect(formatLanguageLabel('undefined', 'ja')).toBe('Japanese');
    expect(formatLanguageLabel('unk', 'es')).toBe('Spanish');
    expect(formatLanguageLabel(null, 'fr-FR')).toBe('French');
    expect(formatLanguageLabel('undefined', 'zh-Hans')).toBe('Chinese');
  });

  it('should return fallback title directly from content.js when both raw label and BCP-47 are missing', () => {
    expect(formatLanguageLabel(null, null)).toBe('Subtitle Track');
    expect(formatLanguageLabel('undefined', 'unk')).toBe('Subtitle Track');
  });
});
