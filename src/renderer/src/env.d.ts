/// <reference types="vite/client" />
import type { ErdApi } from '../../shared/ipc';

declare global {
  interface Window {
    erd: ErdApi;
    /** 시험 모드용: 메인이 executeJavaScript 로 부른다 */
    __erdAuto?: (args: { scenario: string; beDir: string; profile: string; modelDir: string; exportDir?: string; measure?: string; dbms?: string }) => Promise<unknown>;
    __erdBench?: () => Promise<unknown>;
    __erdActivate?: (tabId: string) => Promise<void>;
    __erdView?: (opts: { mode?: 'grid' | 'tree'; edge?: 'smoothstep' | 'straight' | 'default' }) => Promise<unknown>;
    __erdNodeRect?: (name: string) => Promise<{ x: number; y: number } | null>;
    __erdInspect?: () => unknown;
    __erdGrid?: () => unknown;
    __erdStep6Shot?: () => Promise<unknown>;
    __erdAiCancel?: () => unknown;
  }
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent;
  export default component;
}
