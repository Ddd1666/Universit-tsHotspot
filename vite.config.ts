import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Nur im Dev-Modus: Token aus der Umgebung (scripts/dev.mjs) in index.html einsetzen.
 * Im Produktions-Build bleibt der Platzhalter – der Server setzt das Token beim Ausliefern ein.
 */
function devToken(): Plugin {
  return {
    name: 'hotspot-dev-token',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace('__HOTSPOT_TOKEN__', process.env.HOTSPOT_TOKEN ?? '');
    },
  };
}

const apiPort = Number(process.env.HOTSPOT_API_PORT ?? 4317);

export default defineConfig({
  root: 'web',
  plugins: [react(), devToken()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 800,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
    },
  },
});
