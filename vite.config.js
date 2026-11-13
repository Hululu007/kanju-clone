import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// BASE_PATH lets the same source deploy either at a domain root ("/")
// or under a project sub-path such as "/kanju-clone/" on GitHub Pages.
// Example: BASE_PATH=/kanju-clone/ npx vite build
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 这台机器的沙箱不允许删除系统 Temp 目录里的文件，esbuild 的
    // transpile/minify 会因此报 "Access is denied"，改为走 rollup 原生输出。
    target: 'esnext',
    minify: false,
    cssMinify: false,
    rollupOptions: {
      input: {
        home: resolve(__dirname, 'index.html'),
        playlists: resolve(__dirname, 'playlists/index.html'),
        history: resolve(__dirname, 'library/history/index.html'),
        sessions: resolve(__dirname, 'library/sessions/index.html'),
        download: resolve(__dirname, 'download/index.html'),
        player: resolve(__dirname, 'player/index.html'),
      },
    },
  },
})
