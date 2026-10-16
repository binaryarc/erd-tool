import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import vue from '@vitejs/plugin-vue';

// 규약 경로(src/main, src/preload, src/renderer)를 그대로 쓴다
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [vue()],
    resolve: {
      alias: [
        // SQL 편집기만 쓰므로 Monaco 의 CSS, HTML, JSON, TypeScript 언어 기능은 빈 모듈로 바꾼다 (STEP 11).
        // 이 기능들이 언어 작업자 파일(ts.worker 13MB 등 약 17MB)을 따로 만들어 설치본에 들어갔다
        { find: /^.*\/languages\/features\/(css|html|json|typescript)\/register\.js$/, replacement: resolve(__dirname, 'src/renderer/src/sql/monaco-unused.ts') },
      ],
    },
  },
});
