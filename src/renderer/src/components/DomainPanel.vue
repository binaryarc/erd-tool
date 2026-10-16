<script setup lang="ts">
// 도메인 관리 패널 (STEP 10): 목록, 이름과 타입 고치기, 쓰는 컬럼 수, 추가, 삭제.
// 모델을 직접 고치지 않고 edit 이벤트로 수정 명령(shared/model/edit.ts)을 보낸다. 삭제 확인 창은 App 이 띄운다.
import { computed, ref } from 'vue';
import { NEW_COLUMN_TYPE, addDomain, domainUsage, updateDomain } from '../../../shared/model/edit';
import type { SchemaModel } from '../../../shared/model/types';

const props = defineProps<{ model: SchemaModel }>();
const emit = defineEmits<{
  edit: [fn: (m: SchemaModel) => SchemaModel, done?: (ok: boolean) => void, note?: string];
  remove: [name: string];
  close: [];
}>();

const rows = computed(() => [...(props.model.domains ?? [])].sort((a, b) => (a.name < b.name ? -1 : 1))
  .map(d => ({ ...d, used: domainUsage(props.model, d.name) })));
const open = ref('');

/** 입력 칸 값이 바뀌었을 때만 보낸다. 실패하면 칸을 원래 값으로 */
function onText(e: Event, old: string, fn: (v: string) => (m: SchemaModel) => SchemaModel, note?: (v: string) => string) {
  const el = e.target as HTMLInputElement;
  const v = el.value.trim();
  if (v === old) return;
  emit('edit', fn(v), ok => { if (!ok) el.value = old; }, note?.(v));
}

const draft = ref({ name: '', type: NEW_COLUMN_TYPE });
const nameBox = ref<HTMLInputElement>();
function add() {
  const d = { ...draft.value };
  emit('edit', m => addDomain(m, d.name, d.type), ok => { if (ok) { draft.value = { name: '', type: NEW_COLUMN_TYPE }; nameBox.value?.focus(); } }, `도메인 ${d.name.trim()} 을 만듦 (저장 전)`);
}
defineExpose({ /** 시험용 */ addDraft: (name: string, type: string) => { draft.value = { name, type }; add(); } });
</script>

<template>
  <section class="domains">
    <header>
      <b>도메인 {{ rows.length }}개</b>
      <span class="spacer" />
      <button title="닫기" @click="emit('close')">×</button>
    </header>
    <div class="dm-body">
      <p class="muted">도메인은 타입만 정한다. 타입을 고치면 이 도메인을 쓰는 컬럼이 모두 같은 타입으로 바뀐다. 컬럼에는 테이블 편집 패널의 「도메인」 칸에서 지정한다.</p>
      <table>
        <thead><tr><th>No.</th><th>이름</th><th>타입</th><th>쓰는 컬럼</th><th></th></tr></thead>
        <tbody>
          <template v-for="(d, i) in rows" :key="d.name">
            <tr :data-domain="d.name">
              <td class="no">{{ i + 1 }}</td>
              <td><input :value="d.name" spellcheck="false" @change="e => onText(e, d.name, v => m => updateDomain(m, d.name, { name: v }), v => `도메인 이름을 ${v} 로 바꿈: 연결된 컬럼 ${d.used.length}개가 따라감 (저장 전)`)" @keydown.enter="($event.target as HTMLInputElement).blur()" /></td>
              <td><input :value="d.type" spellcheck="false" class="type" @change="e => onText(e, d.type, v => m => updateDomain(m, d.name, { type: v }), v => `도메인 ${d.name} 타입을 ${v} 로 바꿈: 컬럼 ${d.used.length}개가 함께 바뀜 (저장 전)`)" @keydown.enter="($event.target as HTMLInputElement).blur()" /></td>
              <td><button class="link" :disabled="!d.used.length" @click="open = open === d.name ? '' : d.name">{{ d.used.length }}개</button></td>
              <td class="act"><button class="danger" title="도메인 삭제 (연결만 풀고 컬럼 타입은 그대로)" @click="emit('remove', d.name)">×</button></td>
            </tr>
            <tr v-if="open === d.name" class="used"><td /><td colspan="4">{{ d.used.map(u => `${u.table}.${u.column}`).join(', ') }}</td></tr>
          </template>
          <tr class="new" @keydown.enter="add">
            <td class="no">+</td>
            <td><input ref="nameBox" v-model="draft.name" placeholder="새 도메인" spellcheck="false" /></td>
            <td><input v-model="draft.type" spellcheck="false" class="type" /></td>
            <td />
            <td class="act"><button :disabled="!draft.name.trim()" @click="add">추가</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.domains { height: 100%; display: flex; flex-direction: column; border-left: 1px solid var(--line); background: var(--bg); font-size: 12px; }
header { display: flex; gap: 6px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--line); }
.spacer { flex: 1; }
.dm-body { flex: 1; min-height: 0; overflow: auto; padding: 8px 10px; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid var(--line); padding: 1px 3px; text-align: left; white-space: nowrap; }
td input { width: 100%; min-width: 60px; box-sizing: border-box; border: 1px solid transparent; background: transparent; color: var(--fg); font: 12px Consolas, 'Malgun Gothic', monospace; padding: 1px 2px; }
td input:focus { border-color: var(--accent); background: var(--bg); outline: none; }
.no { color: var(--muted); text-align: right; width: 24px; }
.act { width: 1%; }
.act button { padding: 0 4px; }
.link { border: none; background: transparent; color: var(--accent); cursor: pointer; padding: 0; }
.link:disabled { color: var(--muted); cursor: default; }
.used td { color: var(--muted); white-space: normal; font: 11px Consolas, 'Malgun Gothic', monospace; }
.new td { background: var(--panel-bg); }
.danger { color: var(--warn); }
.muted { color: var(--muted); margin: 0 0 6px; }
</style>
