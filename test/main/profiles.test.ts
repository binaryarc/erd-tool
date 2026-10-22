// BE properties 의 jdbc URL 읽기 (STEP 9: DB 종류별 모양)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listProfiles, parseJdbcUrl, setWritableProfiles } from '../../src/main/db/profiles';
import { defaultOption, type ConnOption } from '../../src/renderer/src/conn-options';

describe('jdbc URL', () => {
  it('DB 종류마다 호스트, 포트, DB 를 읽는다', () => {
    expect(parseJdbcUrl('jdbc:log4jdbc:postgresql://127.0.0.1:15432/shop-dev?x=1')).toEqual({ driver: 'postgresql', host: '127.0.0.1', port: 15432, database: 'shop-dev' });
    expect(parseJdbcUrl('jdbc:sqlserver://erp.local:1433;databaseName=ERP;encrypt=true')).toEqual({ driver: 'sqlserver', host: 'erp.local', port: 1433, database: 'ERP' });
    expect(parseJdbcUrl('jdbc:sqlserver://erp.local\\SQLEXPRESS;database=ERP')).toEqual({ driver: 'sqlserver', host: 'erp.local', port: undefined, database: 'ERP' });
    expect(parseJdbcUrl('jdbc:mysql://db:3306/erdtest?useSSL=false')).toEqual({ driver: 'mysql', host: 'db', port: 3306, database: 'erdtest' });
    expect(parseJdbcUrl('jdbc:oracle:thin:@//127.0.0.1:1521/FREEPDB1')).toEqual({ driver: 'oracle', host: '127.0.0.1', port: 1521, database: 'FREEPDB1' });
    expect(parseJdbcUrl('jdbc:oracle:thin:@ora:1521:ORCL')).toEqual({ driver: 'oracle', host: 'ora', port: 1521, database: 'ORCL' });
    expect(parseJdbcUrl('')).toBeNull();
  });
});

describe('운영 DB 판정 (쓰기 허용 프로필 이름 목록)', () => {
  const be = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-be-'));
  const prop = path.join(be, 'src/main/resources');
  fs.mkdirSync(prop, { recursive: true });
  for (const n of ['dev', 'local', 'test', 'prod', 'real', 'prd', 'live']) {
    fs.writeFileSync(path.join(prop, `application-${n}.properties`), 'spring.datasource.url=jdbc:postgresql://localhost:5432/x\nspring.datasource.username=u\nspring.datasource.password=p\n');
  }
  const ro = () => Object.fromEntries(listProfiles(be).map(p => [p.name, p.readOnly]));
  afterEach(() => setWritableProfiles(undefined));

  it('기본은 읽기 전용이고 dev, local 만 쓰기로 연다', () => {
    expect(ro()).toEqual({ dev: false, live: true, local: false, prd: true, prod: true, real: true, test: true });
  });
  it('설정의 목록으로 바꿀 수 있고, 대소문자는 가리지 않는다', () => {
    setWritableProfiles(['Test']);
    expect(ro()).toMatchObject({ dev: true, test: false, prod: true });
  });
  it('기본으로 고르는 접속도 같은 목록으로 정한다 (이름 dev 에 기대지 않음)', () => {
    const opts = (): ConnOption[] => [
      ...listProfiles(be).map(p => ({ key: 'be:' + p.name, label: p.name, readOnly: p.readOnly, profile: p.name, ref: { source: 'be' as const, beDir: be, name: p.name } })),
      { key: 'manual:1', label: 'm', readOnly: false, ref: { source: 'manual' as const, id: '1' } },
    ];
    expect(defaultOption(opts())?.key).toBe('be:dev');
    setWritableProfiles(['live']);
    expect(defaultOption(opts())?.key).toBe('be:live');
    setWritableProfiles(['nothing']);
    expect(defaultOption(opts())?.key).toBe('be:dev'); // 쓰기 허용 프로필이 없으면 목록 첫째 (이름순)
  });
});

describe('Spring 표준 키와 yml (spring.datasource.*, application-{프로필}.yml)', () => {
  const mk = (files: Record<string, string>) => {
    const be = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-be-'));
    const res = path.join(be, 'src/main/resources');
    fs.mkdirSync(res, { recursive: true });
    for (const [f, s] of Object.entries(files)) fs.writeFileSync(path.join(res, f), s);
    return be;
  };
  const pick = (be: string) => listProfiles(be).map(({ name, driver, host, port, database, user, passwordRaw, readOnly }) => ({ name, driver, host, port, database, user, passwordRaw, readOnly }));

  it('properties 의 spring.datasource.* 를 읽는다', () => {
    const be = mk({ 'application-local.properties': 'spring.datasource.url=jdbc:mysql://db:3306/shop\nspring.datasource.username=app\nspring.datasource.password=pw1\n' });
    expect(pick(be)).toEqual([{ name: 'local', driver: 'mysql', host: 'db', port: 3306, database: 'shop', user: 'app', passwordRaw: 'pw1', readOnly: false }]);
  });

  it('application-{프로필}.yml, .yaml 도 같은 결과', () => {
    const be = mk({
      'application-dev.yml': 'spring:\n  datasource:\n    url: jdbc:postgresql://127.0.0.1:5432/app\n    username: "dev_user"\n    password: 0123\nserver:\n  port: 8080\n',
      'application-real.yaml': '# 운영\nspring.datasource.url: jdbc:sqlserver://erp:1433;databaseName=ERP\nspring.datasource.username: sa\nspring.datasource.password: ENC(abc)\n',
      'application.yml': 'spring:\n  profiles:\n    active: dev\n',
    });
    expect(pick(be)).toEqual([
      { name: 'dev', driver: 'postgresql', host: '127.0.0.1', port: 5432, database: 'app', user: 'dev_user', passwordRaw: '0123', readOnly: false },
      { name: 'real', driver: 'sqlserver', host: 'erp', port: 1433, database: 'ERP', user: 'sa', passwordRaw: 'ENC(abc)', readOnly: true },
    ]);
  });

  it('표준이 아닌 폴더(src/main 아래), 표준이 아닌 키(jdbc 주소를 가진 {앞}.url)도 찾는다', () => {
    const be = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-be-'));
    const dir = path.join(be, 'src/main/config/app');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'application-dev.properties'), 'app.mode=batch\nshop.db.url=jdbc:log4jdbc:postgresql://localhost:15432/shop-dev\nshop.db.username=app_user\nshop.db.password=ENC(x)\n');
    expect(pick(be)).toEqual([{ name: 'dev', driver: 'postgresql', host: 'localhost', port: 15432, database: 'shop-dev', user: 'app_user', passwordRaw: 'ENC(x)', readOnly: false }]);
  });

  it('공통 application.properties 의 값을 프로필 값이 덮고, jasypt.encryptor.* 를 함께 읽는다', () => {
    const be = mk({
      'application.properties': 'spring.datasource.username=base_user\njasypt.encryptor.algorithm=PBEWithMD5AndDES\n',
      'application-dev.properties': 'spring.datasource.url=jdbc:postgresql://h:5432/app\nspring.datasource.password=p\n',
    });
    const [p] = listProfiles(be);
    expect([p.user, p.jasypt.algorithm]).toEqual(['base_user', 'PBEWithMD5AndDES']);
  });

  it('src/main/resources 가 있으면 다른 폴더보다 먼저 본다', () => {
    const be = mk({ 'application-dev.properties': 'spring.datasource.url=jdbc:postgresql://std:5432/a\n' });
    fs.mkdirSync(path.join(be, 'src/main/aaa'), { recursive: true });
    fs.writeFileSync(path.join(be, 'src/main/aaa/application-dev.properties'), 'spring.datasource.url=jdbc:postgresql://other:5432/a\n');
    expect(listProfiles(be)[0].host).toBe('std');
  });
});
