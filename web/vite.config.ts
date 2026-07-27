import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Build-time version metadata for the About menu.
const pkgVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const gitCommit = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'dev';
  }
})();
const buildDate = new Date().toISOString();

export default defineConfig({
  // @ts-expect-error vitest augments the vite config
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
  plugins: [react()],
  base: './',
  define: {
    __SIGIL_VERSION__: JSON.stringify(pkgVersion),
    __SIGIL_COMMIT__: JSON.stringify(gitCommit),
    __SIGIL_BUILD__: JSON.stringify(buildDate),
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          xterm: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-webgl', '@xterm/addon-search'],
          mosaic: ['react-mosaic-component'],
          markdown: ['marked', 'ansi-to-html'],
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:7777',
      '/ws': {
        target: 'ws://localhost:7777',
        ws: true,
      },
    },
  },
});
