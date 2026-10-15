import type { ErdApi } from '../../shared/ipc';

declare global {
  interface Window {
    erd: ErdApi;
    /** 시험 모드용: 메인이 executeJavaScript 로 부른다 */
    __erdOpen?: (dir: string) => Promise<void>;
  }
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent;
  export default component;
}
