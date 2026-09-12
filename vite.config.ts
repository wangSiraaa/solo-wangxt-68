/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  base: './',
  plugins: [
    svelte({
      preprocess: vitePreprocess(),
      onwarn(warning, handler) {
        // 忽略无障碍提示，专注功能正确性
        if (warning.code?.startsWith('a11y')) return;
        handler?.(warning);
      },
    }),
  ],
  build: {
    target: 'es2022',
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
  },
});
