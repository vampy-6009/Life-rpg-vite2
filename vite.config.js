import { defineConfig } from 'vite';

// Capacitor loads the built app through capacitor://localhost (Android)
// or a similar custom scheme, not a normal absolute web root — so asset
// paths must be relative ("./") or they'll 404 on-device even though
// they work fine under `vite dev`'s regular HTTP server.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
