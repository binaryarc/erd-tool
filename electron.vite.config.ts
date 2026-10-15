import { defineConfig } from 'electron-vite';
import vue from '@vitejs/plugin-vue';

// 규약 경로(src/main, src/preload, src/renderer)를 그대로 쓴다
export default defineConfig({
  main: {},
  preload: {},
  renderer: { plugins: [vue()] },
});
