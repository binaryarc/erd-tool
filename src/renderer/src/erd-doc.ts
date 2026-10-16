// ERD 탭 하나의 화면 상태 (STEP 10 결정 20). 탭마다 모델, 배치, 되돌리기 기록, 그룹 탭, AI 확정 대기가 따로다.
// App 은 지금 ERD 탭(cur)의 값을 가리키는 computed 로 이 묶음을 읽고 쓴다. 그래서 수정, 저장, AI, 시험 코드는 탭을 몰라도 된다.
import { computed, ref, shallowRef, type Ref, type ShallowRef, type WritableComputedRef } from 'vue';
import { DEFAULT_DIAGRAM } from '../../shared/model/arrange';
import { EditHistory } from '../../shared/model/edit';
import { emptyLayout, type Diagram, type Layout } from '../../shared/model/layout';
import type { ModelError, SchemaModel } from '../../shared/model/types';

export type Pins = Record<string, [number, number]>;
export interface AiStep { before: SchemaModel; beforePinned: Pins; after: SchemaModel }
export interface Viewport { x: number; y: number; zoom: number }
/** 되돌리기 한 칸: 모델과 그때 배치(깊은 복사). 배치는 그 자리에서 고쳐 쓰므로 복사해 둔다 */
export interface Snap { model: SchemaModel; layout: Layout }

export interface ErdDoc {
  id: string;
  modelDir: Ref<string>;
  model: ShallowRef<SchemaModel | null>;
  layout: ShallowRef<Layout>;
  diagram: ShallowRef<Diagram | null>;
  version: Ref<number>;
  errors: Ref<ModelError[]>;
  dirty: Ref<boolean>;
  /** 이 값이 바뀔 때만 캔버스를 전체 보기로 맞춘다 */
  fitKey: Ref<number>;
  history: EditHistory<Snap>;
  canUndo: Ref<boolean>;
  canRedo: Ref<boolean>;
  /** 편집 패널에 띄운 테이블 ID */
  editId: Ref<string>;
  /** Enter 로 컬럼을 더할 테이블 ID */
  pickId: Ref<string>;
  aiBase: ShallowRef<{ model: SchemaModel; pinned: Pins } | null>;
  aiSteps: AiStep[];
  /** 보이는 그룹 탭 이름 (「전체」 포함) */
  tab: Ref<string>;
  /** 미니 ERD 가운데 테이블 */
  miniName: Ref<string>;
  /** 다른 탭으로 갈 때 남긴 화면 위치. 돌아오면 그 자리로 */
  viewport?: Viewport;
}

export function newDoc(id: string, modelDir = ''): ErdDoc {
  return {
    id, modelDir: ref(modelDir), model: shallowRef(null), layout: shallowRef(emptyLayout()), diagram: shallowRef(null),
    version: ref(0), errors: ref([]), dirty: ref(false), fitKey: ref(0), history: new EditHistory<Snap>(),
    canUndo: ref(false), canRedo: ref(false), editId: ref(''), pickId: ref(''), aiBase: shallowRef(null), aiSteps: [],
    tab: ref(DEFAULT_DIAGRAM), miniName: ref(''),
  };
}

type RefKeys = Exclude<keyof ErdDoc, 'id' | 'history' | 'aiSteps' | 'viewport'>;
type RefValue<K extends RefKeys> = ErdDoc[K] extends Ref<infer V> ? V : never;

/** 지금 ERD 탭의 값 하나를 가리키는 ref 모양 값 (읽기, 쓰기 모두 그 탭으로 간다) */
export function docField<K extends RefKeys>(cur: ShallowRef<ErdDoc>, key: K): WritableComputedRef<RefValue<K>> {
  return computed({
    get: () => (cur.value[key] as Ref<RefValue<K>>).value,
    set: v => { (cur.value[key] as Ref<RefValue<K>>).value = v; },
  });
}

/** 모델 폴더 경로를 비교할 모양으로 (구분자, 대소문자, 끝 구분자) */
export const sameDir = (a: string, b: string) => !!a && !!b && norm(a) === norm(b);
const norm = (d: string) => d.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** 탭 제목: BE 레포의 docs/erd/model 이면 그 레포 이름, 아니면 폴더 이름 */
export function docTitle(d: ErdDoc, fallback: string): string {
  const dir = d.modelDir.value.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!dir) return fallback;
  const be = /([^/]+)\/docs\/erd\/model$/i.exec(dir);
  return be ? be[1] : dir.split('/').pop() || fallback;
}
