import { defineConfig } from 'vite';

// base: './' keeps asset paths relative so the build works on GitHub Pages
// project subpaths, Netlify, Vercel, or a plain static host without changes.
export default defineConfig({
  base: './',
  server: {
    port: 5180,
    strictPort: true,
  },
  build: {
    target: 'esnext',
  },
});
