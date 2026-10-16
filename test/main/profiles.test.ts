// BE properties 의 jdbc URL 읽기 (STEP 9: DB 종류별 모양)
import { describe, expect, it } from 'vitest';
import { parseJdbcUrl } from '../../src/main/db/profiles';

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
