import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Версия сборки для обращений в поддержку: дата и время сборки
  define: { __APP_VERSION__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')) },
  // Две страницы: CRM (/) и отдельное приложение-мессенджер для сотрудников (/team/)
  build: { rollupOptions: { input: { main: 'index.html', team: 'team/index.html' } } },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3000' } },
});
