// 웹 버전 화면 빌드 (server.mjs가 out/web을 준다). Electron 화면 빌드는 electron.vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  build: { outDir: '../../out/web', emptyOutDir: true },
})
