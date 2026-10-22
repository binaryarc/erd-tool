import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import vue from '@vitejs/plugin-vue';

// 규약 경로(src/main, src/preload, src/renderer)를 그대로 쓴다.
// __ERD_AUTO__: 시험 모드(ERD_AUTO) 시나리오를 넣을지. 설치용 빌드(npm run build, dist, mode production)는 false 라
// 시험 코드(src/main/auto, src/renderer/src/auto)가 빌드 결과에 들어가지 않는다. 시나리오는 npm run build:auto 나 npm run dev 로 돌린다
export default defineConfig(({ mode }) => {
  const define = { __ERD_AUTO__: JSON.stringify(mode !== 'production') };
  return {
    main: { define },
    preload: {},
    renderer: {
      define,
      plugins: [vue()],
      resolve: {
        alias: [
          // SQL 편집기만 쓰므로 Monaco 의 CSS, HTML, JSON, TypeScript 언어 기능은 빈 모듈로 바꾼다 (STEP 11).
          // 이 기능들이 언어 작업자 파일(ts.worker 13MB 등 약 17MB)을 따로 만들어 설치본에 들어갔다
          { find: /^.*\/languages\/features\/(css|html|json|typescript)\/register\.js$/, replacement: resolve(__dirname, 'src/renderer/src/sql/monaco-unused.ts') },
        ],
      },
    },
  };
});
