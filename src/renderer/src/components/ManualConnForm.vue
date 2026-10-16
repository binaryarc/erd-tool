<script setup lang="ts">
// 직접 입력 접속 양식: DB 종류, 이름, 호스트, 포트, DB, 스키마, 사용자, 비밀번호, 읽기 전용, 비밀번호 저장 여부
import { computed, reactive, ref } from 'vue';
import { DIALECT_LABEL, DIALECTS, type Dialect } from '../../../shared/dialect/names';
import type { ConnTestResult, ManualConn, ManualConnInfo } from '../../../shared/ipc';

const props = defineProps<{ conn?: ManualConnInfo }>();
const emit = defineEmits<{ saved: [c: ManualConnInfo]; cancel: [] }>();

const PORT: Record<Dialect, number> = { postgresql: 5432, sqlserver: 1433, mysql: 3306, oracle: 1521 };
const SCHEMA_HINT: Record<Dialect, string> = { postgresql: 'public', sqlserver: 'dbo', mysql: 'DB 이름과 같음', oracle: '사용자 이름(대문자)' };
const DB_HINT: Record<Dialect, string> = { postgresql: 'DB', sqlserver: 'DB', mysql: 'DB', oracle: '서비스 이름 (예: FREEPDB1)' };

const form = reactive<ManualConn>(props.conn
  ? { id: props.conn.id, name: props.conn.name, driver: props.conn.driver ?? 'postgresql', host: props.conn.host, port: props.conn.port,
      database: props.conn.database, schema: props.conn.schema, trustCert: props.conn.trustCert,
      user: props.conn.user, readOnly: props.conn.readOnly, savePassword: props.conn.savePassword }
  : { id: '', name: '', driver: 'postgresql', host: 'localhost', port: 5432, database: '', user: '', readOnly: false, savePassword: false });
/** 서버가 읽기 전용을 막지 못하는 DB (사용자 결정 2026-10-16) */
const byAccount = computed(() => form.driver === 'sqlserver' || form.driver === 'oracle');

/** DB 종류를 바꾸면 기본 포트였던 포트만 새 기본 포트로 */
function changeDriver(d: Dialect) {
  if (Object.values(PORT).includes(Number(form.port))) form.port = PORT[d];
  form.driver = d;
}
const password = ref('');
const test = ref<ConnTestResult | null>(null);
const error = ref('');

const plain = (): ManualConn => ({ ...form, port: Number(form.port), schema: form.schema?.trim() || undefined, trustCert: form.driver === 'sqlserver' ? !!form.trustCert : undefined });
const clean = (e: unknown) => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

async function doTest() {
  error.value = ''; test.value = null;
  if (!password.value) { error.value = '접속 시험에는 비밀번호를 입력하세요'; return; }
  test.value = await window.erd.conn.testDraft(plain(), password.value);
}

async function save() {
  error.value = '';
  if (!form.name || !form.host || !form.database || !form.user) { error.value = '이름, 호스트, DB, 사용자를 입력하세요'; return; }
  try {
    // 편집 때 비밀번호 칸을 비워 두면 기존 비밀번호를 그대로 쓴다
    emit('saved', await window.erd.manual.save(plain(), password.value || undefined));
  } catch (e) { error.value = clean(e); }
}
</script>

<template>
  <div class="form">
    <label>DB 종류
      <select :value="form.driver" @change="changeDriver(($event.target as HTMLSelectElement).value as Dialect)">
        <option v-for="d in DIALECTS" :key="d" :value="d">{{ DIALECT_LABEL[d] }}</option>
      </select>
    </label>
    <label>이름<input v-model="form.name" placeholder="예: 로컬 dev" /></label>
    <div class="two">
      <label>호스트<input v-model="form.host" /></label>
      <label class="port">포트<input v-model.number="form.port" type="number" /></label>
    </div>
    <label>{{ DB_HINT[form.driver] }}<input v-model="form.database" /></label>
    <label>스키마<input v-model="form.schema" :placeholder="`비우면 ${SCHEMA_HINT[form.driver]}`" /></label>
    <label>사용자<input v-model="form.user" /></label>
    <label>비밀번호<input v-model="password" type="password" :placeholder="conn?.hasPassword ? '비워 두면 기존 비밀번호 사용' : ''" /></label>
    <label class="check"><input v-model="form.savePassword" type="checkbox" /> 비밀번호 저장 (Windows 계정으로 암호화)</label>
    <label v-if="form.driver === 'sqlserver'" class="check"><input v-model="form.trustCert" type="checkbox" /> 서버 인증서 믿기 (자체 서명 인증서)</label>
    <label class="check"><input v-model="form.readOnly" type="checkbox" /> 읽기 전용</label>
    <p v-if="byAccount && form.readOnly" class="warn">{{ DIALECT_LABEL[form.driver] }} 는 서버가 읽기 전용을 막지 못합니다. 읽기 권한만 있는 DB 계정으로 접속하세요</p>
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
label input:not([type=checkbox]), label select { display: block; width: 100%; box-sizing: border-box; }
.check { color: var(--fg); }
.two { display: flex; gap: 6px; } .two label { flex: 1; } .two .port { flex: 0 0 70px; }
.row { display: flex; gap: 6px; margin-top: 6px; }
.ok { color: var(--ok); } .warn { color: var(--warn); } .muted { color: var(--muted); }
</style>
