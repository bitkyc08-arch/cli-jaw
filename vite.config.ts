import { defineConfig } from 'vite';

export default defineConfig({
  root: 'public',
  base: '/dist/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    modulePreload: false,
    rolldownOptions: {
      input: 'public/index.html',
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/@lucide/icons/')) {
            return 'vendor-icons';
          }
          if (id.includes('node_modules/marked/') ||
              id.includes('node_modules/highlight.js/') ||
              id.includes('node_modules/katex/') ||
              id.includes('node_modules/dompurify/')) {
            return 'vendor-render';
          }
          if (id.includes('node_modules/mermaid/') ||
              id.includes('node_modules/chevrotain/') ||
              id.includes('node_modules/lodash-es/') ||
              id.includes('node_modules/dagre-d3-es/') ||
              id.includes('node_modules/d3') ||
              id.includes('node_modules/elkjs/') ||
              id.includes('node_modules/cytoscape/')) {
            return 'vendor-mermaid';
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
