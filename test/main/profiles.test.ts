// BE properties 의 jdbc URL 읽기 (STEP 9: DB 종류별 모양)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listProfiles, parseJdbcUrl, setWritableProfiles } from '../../src/main/db/profiles';

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
    fs.writeFileSync(path.join(prop, `application-${n}.properties`), 'db.url=jdbc:postgresql://localhost:5432/x\ndb.username=u\ndb.password=p\n');
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

  it('db.* 키(Spring 표준이 아닌 BE 규칙)는 지금처럼 읽는다', () => {
    const be = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-be-'));
    fs.mkdirSync(path.join(be, 'src/main/resources'), { recursive: true });
    fs.writeFileSync(path.join(be, 'src/main/resources/application-dev.properties'), 'db.url=jdbc:log4jdbc:postgresql://localhost:15432/shop-dev\ndb.username=app_user\ndb.password=ENC(x)\n');
    expect(pick(be)).toEqual([{ name: 'dev', driver: 'postgresql', host: 'localhost', port: 15432, database: 'shop-dev', user: 'app_user', passwordRaw: 'ENC(x)', readOnly: false }]);
  });
});
