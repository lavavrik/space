import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// `base: './'` keeps asset URLs relative, so the build works from any path (e.g. GitHub Pages).
export default defineConfig({
  base: './',
  plugins: [react()],
  // three.js alone is ~600 kB minified
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
  test: { environment: 'node' },
});
