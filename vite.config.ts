import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:8787' },
    // The Part D server rewrites server/cache/briefs.json on every brief; reloading the page would discard the reply.
    watch: { ignored: ['**/server/cache/**', '**/test-results/**', '**/e2e/__shots__/**'] },
  },
});
