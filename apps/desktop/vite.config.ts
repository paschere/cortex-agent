import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
  },
  define: {
    // Replaced at build time. Defaults to localhost:3000 for local dev.
    __CORTEX_WEB_URL__: JSON.stringify(process.env.CORTEX_WEB_URL || 'http://localhost:3000'),
  },
});
