import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  server: { host: '127.0.0.1', port: 1430, strictPort: true },
  build: {
    target: 'es2022',
    rollupOptions: { input: { stage: 'stage.html' } },
  },
  test: { include: ['src/**/*.test.ts'] },
} as never);
