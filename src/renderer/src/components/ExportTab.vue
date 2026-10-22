<script setup lang="ts">
// 내보내기 (STEP 7, 설계 8-1): 지금 ERD 모델로 그룹별 테이블 정의서 MD 와 메뉴 물리 테이블 목록 조각을 만든다.
// 폴더는 내보낼 때마다 고르고 마지막 위치를 기억한다. 파일 이름에 시각을 붙이지 않고 같은 이름은 덮어쓴다(사용자 지정 2026-10-16).
// Flyway 파일은 DB 비교 탭의 「Flyway 파일 만들기」 에서 만든다(두 쪽 차이가 필요하다).
import { ref } from 'vue';
import { buildMenuTables, buildSchemaDocs, type MdFile } from '../../../shared/export/md';
import type { SchemaModel } from '../../../shared/model/types';

const props = defineProps<{ model: SchemaModel | null; selected: string[] }>();
const emit = defineEmits<{ compare: [] }>();

const menuCode = ref('');
const written = ref<string[]>([]);
const replaced = ref(0);
const error = ref('');

const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

async function write(dir: string, files: MdFile[]) {
  error.value = ''; written.value = []; replaced.value = 0;
  try {
    const r = await window.erd.export.write(dir, files, undefined, { overwrite: true });
    written.value = r.written;
    replaced.value = r.replaced.length;
  } catch (e) { error.value = clean(e); }
  return written.value;
}

/** 폴더를 고르고 기억한다 (처음에는 모델 폴더 옆) */
async function pickDir(): Promise<string | null> {
  const s = await window.erd.settings.get();
  const dir = await window.erd.pickFolder(s.exportDirs?.md ?? s.modelDir);
  if (dir) await window.erd.settings.set({ exportDirs: { ...s.exportDirs, md: dir } });
  return dir;
}

function schemaFiles() {
  if (!props.model) throw new Error('ERD 에 열린 모델이 없습니다');
  return buildSchemaDocs(props.model, new Date());
}
function menuFile(code = menuCode.value, tables = props.selected) {
  if (!props.model) throw new Error('ERD 에 열린 모델이 없습니다');
  return buildMenuTables(props.model, code.trim(), tables, new Date());
}

async function run(make: () => MdFile[]) {
  let files: MdFile[];
  try { files = make(); } catch (e) { error.value = clean(e); return; }
  const dir = await pickDir();
  if (dir) await write(dir, files);
}

defineExpose({
  /** 시험용: 폴더 고르기 없이 쓴다 */
  writeSchema: (dir: string) => write(dir, schemaFiles()),
  writeMenu: (dir: string, code: string, tables: string[]) => write(dir, [menuFile(code, tables)]),
});
</script>

<template>
  <section class="export">
    <p v-if="!model" class="muted">ERD 에 모델을 먼저 여세요.</p>
    <template v-else>
      <div class="box">
        <h4>스키마 문서 (MD)</h4>
        <p class="muted">그룹마다 테이블 정의서 한 개(컬럼, PK, FK, UNIQUE, 인덱스)와 색인 00-tables-overview 를 만듭니다. 같은 이름 파일이 있으면 덮어씁니다.</p>
        <p>그룹 {{ model.groups.length }}개, 테이블 {{ model.tables.length }}개</p>
        <button @click="run(schemaFiles)">폴더 골라 만들기</button>
      </div>
      <div class="box">
        <h4>메뉴 물리 테이블 목록</h4>
        <p class="muted">{메뉴코드}-03-data-model.md 「물리 테이블 목록」 절에 붙여 넣을 조각입니다. ERD 에서 Ctrl+클릭으로 고른 테이블을 고른 순서대로 넣습니다.</p>
        <label>메뉴코드 <input v-model="menuCode" spellcheck="false" placeholder="menu01" /></label>
        <p>고른 테이블 {{ selected.length }}개<span v-if="selected.length">: {{ selected.join(', ') }}</span></p>
        <button :disabled="!selected.length || !menuCode.trim()" @click="run(() => [menuFile()])">폴더 골라 만들기</button>
      </div>
      <div class="box">
        <h4>Flyway 파일</h4>
        <p class="muted">두 쪽 차이로 만들기 때문에 DB 비교 탭에서 비교한 뒤 「Flyway 파일 만들기」를 누르세요. 파일만 만들고 DB 에는 실행하지 않습니다.</p>
        <button @click="emit('compare')">DB 비교 탭 열기</button>
      </div>
      <div v-if="written.length" class="ok">
        <b>만든 파일 {{ written.length }}개<span v-if="replaced"> (그중 덮어쓴 파일 {{ replaced }}개)</span></b>
        <ul><li v-for="w in written" :key="w">{{ w }}</li></ul>
      </div>
      <p v-if="error" class="warn">{{ error }}</p>
    </template>
  </section>
</template>

<style scoped>
.export { height: 100%; overflow: auto; padding: 8px 12px; box-sizing: border-box; font-size: 12px; }
.box { border: 1px solid var(--line); padding: 6px 10px; margin-bottom: 8px; }
h4 { margin: 2px 0 4px; }
p { margin: 4px 0; }
ul { margin: 4px 0; padding-left: 18px; }
input { color: var(--fg); background: var(--bg); border: 1px solid var(--line); }
.ok { color: var(--ok); } .warn { color: var(--warn); } .muted { color: var(--muted); }
</style>
