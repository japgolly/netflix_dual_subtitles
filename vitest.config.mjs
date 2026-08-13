import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['furigana.js', 'injected.js', 'content.js'],
      reporter: ['text', 'json', 'html']
    }
  }
});
