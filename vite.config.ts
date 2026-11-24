import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative base: the build works from any sub-path (e.g. GitHub Pages) and from file servers.
  base: './',
  server: { host: true, port: 5173 },
  worker: { format: 'es' },
});
