# ERD Tool

데이터베이스 스키마를 ERD 로 그리고, 고치고, 실제 DB 와 비교해 반영하는 Windows 데스크톱 도구입니다. Electron, Vue 로 만들었습니다.

## 할 수 있는 일

| No. | 기능 | 설명 |
|---|---|---|
| 1 | DB 에서 불러오기 | 접속한 DB 의 테이블, 컬럼, PK, FK, UNIQUE, 인덱스, 시퀀스, 함수를 읽어 ERD 로 그립니다 |
| 2 | ERD 편집 | 테이블, 컬럼, FK 를 화면에서 고치고 되돌리기, 다시 하기, 그룹 탭, 도메인을 씁니다 |
| 3 | 모델 파일 | ERD 를 사람이 읽을 수 있는 텍스트 파일(`.erd`)로 저장해 git 으로 관리합니다 |
| 4 | SQL 탭 | 접속별 SQL 실행, 트랜잭션, 자동완성. 운영 접속은 읽기 전용으로 엽니다 |
| 5 | DB 비교 | 두 DB 또는 DB 와 ERD 의 차이를 보고 ALTER 를 만들며, 결과를 MD 로 저장합니다 |
| 6 | Flyway 파일 | 차이를 여러 번 실행해도 안전한 Flyway 마이그레이션 파일로 만듭니다 (PostgreSQL) |
| 7 | 문서 내보내기 | 그룹별 테이블 정의서 MD 를 만듭니다 |
| 8 | AI 연결 | 내장 터미널의 Claude Code, Codex 가 MCP 로 ERD 를 읽고 고칩니다. AI 의 DB 조회는 읽기만 합니다 |

- 지원 DB: PostgreSQL, SQL Server, MySQL(MariaDB), Oracle
- 접속 정보는 BE 레포의 `application-{프로필}.properties` 나 `.yml`(Spring `spring.datasource.*` 키 포함)에서 읽거나 직접 입력합니다. Jasypt `ENC(...)` 값은 마스터키 환경변수로 풉니다.

## 개발

```bash
npm ci
npm run dev        # 개발 모드로 실행
npm run typecheck
npm test           # DB 없이 도는 시험. DB 시험은 아래 설정이 있을 때만 돈다
npm run dist       # Windows 설치 파일 (dist/). 시험 모드 코드는 빠진다
npm run build:auto # 시험 모드(ERD_AUTO) 시나리오를 넣은 빌드. 시나리오는 src/main/auto, src/renderer/src/auto
```

### DB 시험

1. `docker/.env.example` 을 `docker/.env` 로 복사해 비밀번호를 정하고 `docker compose -f docker/docker-compose.yml up -d` 로 시험용 DB 를 띄웁니다.
2. `test/.env.example` 을 `test/.env.local` 로 복사해 접속 정보를 넣습니다.
3. `npm test` 를 돌립니다. PostgreSQL 시험은 빈 시험 DB 에 예시 스키마(`test/fixtures/seed-postgres.sql`)를 넣고 돕니다.

- `docker/.env`, `test/.env.local` 은 git 에 올리지 않습니다.
- 설치와 처음 실행은 [docs/install-guide.md](docs/install-guide.md) 를 봅니다.

## 라이선스

[MIT](LICENSE)
