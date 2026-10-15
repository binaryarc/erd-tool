<script setup lang="ts">
// 직접 입력 접속 양식: 이름, 호스트, 포트, DB, 사용자, 비밀번호, 읽기 전용, 비밀번호 저장 여부
import { reactive, ref } from 'vue';
import type { ConnTestResult, ManualConn, ManualConnInfo } from '../../../shared/ipc';

const props = defineProps<{ conn?: ManualConnInfo }>();
const emit = defineEmits<{ saved: [c: ManualConnInfo]; cancel: [] }>();

const form = reactive<ManualConn>(props.conn
  ? { id: props.conn.id, name: props.conn.name, driver: 'postgresql', host: props.conn.host, port: props.conn.port,
      database: props.conn.database, user: props.conn.user, readOnly: props.conn.readOnly, savePassword: props.conn.savePassword }
  : { id: '', name: '', driver: 'postgresql', host: 'localhost', port: 5432, database: '', user: '', readOnly: false, savePassword: false });
const password = ref('');
const test = ref<ConnTestResult | null>(null);
const error = ref('');

const plain = () => ({ ...form, port: Number(form.port) });
const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

async function doTest() {
  error.value = ''; test.value = null;
  if (!password.value) { error.value = '접속 시험에는 비밀번호를 입력해야 한다'; return; }
  test.value = await window.erd.conn.testDraft(plain(), password.value);
}

async function save() {
  error.value = '';
  if (!form.name || !form.host || !form.database || !form.user) { error.value = '이름, 호스트, DB, 사용자는 꼭 넣어야 한다'; return; }
  try {
    // 편집 때 비밀번호 칸을 비워 두면 기존 비밀번호를 그대로 쓴다
    emit('saved', await window.erd.manual.save(plain(), password.value || undefined));
  } catch (e) { error.value = clean(e); }
}
</script>

<template>
  <div class="form">
    <label>이름<input v-model="form.name" placeholder="예: 로컬 dev" /></label>
    <div class="two">
      <label>호스트<input v-model="form.host" /></label>
      <label class="port">포트<input v-model.number="form.port" type="number" /></label>
    </div>
    <label>DB<input v-model="form.database" /></label>
    <label>사용자<input v-model="form.user" /></label>
    <label>비밀번호<input v-model="password" type="password" :placeholder="conn?.hasPassword ? '비워 두면 기존 비밀번호 사용' : ''" /></label>
    <label class="check"><input v-model="form.savePassword" type="checkbox" /> 비밀번호 저장 (Windows 계정으로 암호화)</label>
    <label class="check"><input v-model="form.readOnly" type="checkbox" /> 읽기 전용</label>
    <p class="muted">DB 종류: PostgreSQL (다른 DB 는 STEP 7)</p>
    <div class="row">
      <button @click="doTest">접속 시험</button>
      <button @click="save">저장</button>
      <button @click="emit('cancel')">취소</button>
    </div>
    <p v-if="error" class="warn">{{ error }}</p>
    <p v-if="test" :class="test.ok ? 'ok' : 'warn'">{{ test.message }}<template v-if="test.ok">: 테이블 {{ test.tables }}, FK {{ test.fks }}</template></p>
  </div>
</template>

<style scoped>
.form { border: 1px solid var(--line); padding: 8px; margin: 6px 0; font-size: 12px; }
label { display: block; color: var(--muted); margin-bottom: 4px; }
label input:not([type=checkbox]) { display: block; width: 100%; box-sizing: border-box; }
.check { color: var(--fg); }
.two { display: flex; gap: 6px; } .two label { flex: 1; } .two .port { flex: 0 0 70px; }
.row { display: flex; gap: 6px; margin-top: 6px; }
.ok { color: var(--ok); } .warn { color: var(--warn); } .muted { color: var(--muted); }
</style>
