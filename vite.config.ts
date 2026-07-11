import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'public',
  base: '/dist/',
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    modulePreload: false,
    rolldownOptions: {
      input: {
        app: 'public/index.html',
        manager: 'public/manager/index.html',
        dashboard2: 'public/dashboard2/index.html',
      },
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/@lucide/icons/')) {
            return 'vendor-icons';
          }
          if (id.includes('node_modules/marked/') ||
              id.includes('node_modules/highlight.js/') ||
              id.includes('node_modules/katex/') ||
              id.includes('node_modules/dompurify/') ||
              id.includes('dompurify')) {
            return 'vendor-render';
          }
          // Mermaid stays behind public/js/mermaid-loader.ts. Forcing a
          // manual vendor-mermaid chunk hoists preload helpers into app.
          if (id.includes('node_modules/lodash-es/') ||
              id.includes('node_modules/d3') ||
              id.includes('node_modules/chevrotain/')) {
            return 'vendor-utils';
          }
        },
      },
    },
    target: 'esnext',
    cssTarget: 'esnext',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3458',
    },
    hmr: { overlay: true },
  },
});
