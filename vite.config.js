import { defineConfig } from 'vite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Dev-only endpoint so the game can save canvas captures straight into the repo
// (the report is graded entirely on screenshots from our own game). The browser
// POSTs { name, data: <dataURL> } to /__capture and we decode it to captures/.
function capturePlugin() {
  return {
    name: 'capture-endpoint',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__capture', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const { name, data } = JSON.parse(body);
            const b64 = data.replace(/^data:image\/\w+;base64,/, '');
            const safe = String(name).replace(/[^a-z0-9_-]/gi, '_');
            const dir = resolve(process.cwd(), 'captures');
            mkdirSync(dir, { recursive: true });
            const file = resolve(dir, `${safe}.png`);
            writeFileSync(file, Buffer.from(b64, 'base64'));
            res.statusCode = 200;
            res.end(JSON.stringify({ ok: true, file }));
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: String(e) }));
          }
        });
      });
    },
  };
}

// base: './' keeps asset paths relative so the build works on GitHub Pages
// project subpaths, Netlify, Vercel, or a plain static host without changes.
export default defineConfig({
  base: './',
  plugins: [capturePlugin()],
  server: {
    port: 5180,
    strictPort: true,
  },
  build: {
    target: 'esnext',
  },
});
