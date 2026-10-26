import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // The server reads PORT from `.env` (server/config.ts loadDotEnv); the dev proxy must follow the same file, or a
  // custom port breaks `npm run dev`. The empty prefix exposes every variable; a value exported in the shell wins.
  const env = loadEnv(mode, process.cwd(), '');
  const API_PORT = env.PORT || '8787';
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: false,
      proxy: {
        '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: false },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
  };
});
