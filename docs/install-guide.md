---
title: ERD Tool 설치 안내
description: 사용자가 ERD Tool 설치 파일로 설치하고 처음 실행할 때, 그리고 관리자가 설치 파일을 다시 만들 때 읽는다
status: draft
version: 0.1.0
tags:
  - erd
  - install
---

# ERD Tool 설치 안내

> 숨은 전제: Windows 10, 11 x64 PC 이고, DB 접속 정보는 BE 레포의 `application-{프로필}.properties` (또는 `.yml`) 에서 읽거나 「직접 입력」 으로 넣는다. 설치 파일만으로 실행되며 Node.js, Java 같은 개발 도구는 필요 없다.

## 1. 준비물

| No. | 항목 | 꼭 필요한가 | 설명 |
|---|---|---|---|
| 1 | 설치 파일 `ERD-Tool-Setup-{버전}.exe` | 필요 | 관리자에게 받는다 |
| 2 | 마스터키 환경변수 `JASYPT_ENCRYPTOR_PASSWORD` | BE 폴더로 접속할 때 필요 | properties 의 `ENC(...)` 비밀번호를 푸는 키. 없으면 접속할 때마다 비밀번호를 묻는다 |
| 3 | BE 레포 폴더 | BE 폴더로 접속할 때 필요 | `src/main/resources`, `src/main/resources/prop`, `src/main/resources` 중 한 곳에 `application-*.properties` 나 `.yml` 이 든 폴더 |
| 4 | PowerShell 7 | 없어도 됨 | 내장 터미널 기본 셸. 없으면 Windows 에 들어 있는 PowerShell 5.1 을 쓴다 |
| 5 | Git for Windows (Git Bash) | 없어도 됨 | 내장 터미널에서 Git Bash 를 고를 때만 |
| 6 | Claude Code 또는 Codex | 없어도 됨 | 내장 터미널의 「AI 연결」 을 쓸 때만 |

- 마스터키 값은 문서, 메신저, 메일에 적지 않는다. 관리자에게 직접 받아 아래 2장대로 내 PC 에만 넣는다.

## 2. 마스터키 넣기 (처음 한 번)

1. 시작 메뉴에서 「계정의 환경 변수 편집」 을 연다.
2. 「사용자 변수」 에서 「새로 만들기」 → 이름 `JASYPT_ENCRYPTOR_PASSWORD`, 값은 받은 마스터키.
3. ERD Tool 이 켜져 있었다면 끄고 다시 켠다.

- 도구는 실행할 때 환경변수에서 읽고, 없으면 Windows 사용자 환경변수(레지스트리)를 한 번 더 본다. 키는 화면이나 파일에 남기지 않는다.
- 마스터키 없이도 쓸 수 있다. 접속할 때 비밀번호 창이 뜨고, 「이 PC 에 저장」 을 고르면 Windows 계정 암호화로 저장해 다음부터 묻지 않는다.

## 3. 설치

1. `ERD-Tool-Setup-{버전}.exe` 를 실행한다.
2. 「Windows의 PC 보호」 파란 창이 뜨면 「추가 정보」 → 「실행」 을 누른다. 설치 파일에 코드 서명이 없어서 뜨는 창이다.
3. 설치 범위(나만 또는 모든 사용자)와 설치 폴더를 고른다. 기본은 나만, `%LOCALAPPDATA%\Programs\ERD Tool` 이다.
4. 설치가 끝나면 바탕화면과 시작 메뉴에 「ERD Tool」 이 생긴다.

## 4. 처음 실행

| No. | 할 일 | 화면 |
|---|---|---|
| 1 | BE 폴더 고르기 | 왼쪽 「BE 폴더에서」 → 「찾기」 로 BE 레포 폴더 |
| 2 | 접속 시험 | 목록에서 dev, test 등을 골라 「접속 시험」. 운영(prod)은 읽기 전용으로 표시된다 |
| 3 | ERD 열기 | 「ERD 폴더 열기」 로 저장해 둔 모델 폴더(기본값 BE 레포의 `docs/erd/model`), 또는 「DB 에서 불러오기」 |
| 4 | 직접 입력 접속 (BE 폴더가 없을 때) | 왼쪽 「직접 입력」 에 DB 종류, 호스트, 포트, DB, 계정을 넣는다 |

- test, 운영 DB 에는 도구에서 바로 적용하지 않는다. 「DB 비교」 에서 Flyway 파일을 만들어 그 파일로 반영한다.
- 껐다 켜면 마지막 화면(ERD 탭, 저장 안 한 변경, SQL 탭 글자와 접속)이 그대로 열린다.

## 5. 설정이 저장되는 곳

| No. | 내용 | 위치 |
|---|---|---|
| 1 | 화면 설정, 접속 목록, 쿼리 이력, 마지막 화면(`session.json`) | `%APPDATA%\erd-tool` |
| 2 | 저장한 DB 비밀번호 | 같은 폴더, Windows 계정 암호화(다른 PC, 다른 계정에서는 풀리지 않는다) |
| 3 | ERD 모델 | 「ERD 저장」 때 고른 폴더 (보통 BE 레포 `docs/erd/model`) |

- 프로그램을 지워도 이 폴더는 남는다. 깨끗이 지우려면 제거한 뒤 `%APPDATA%\erd-tool` 을 지운다.

## 6. 제거

「설정 → 앱 → 설치된 앱」 에서 「ERD Tool」 → 제거. 또는 설치 폴더의 `Uninstall ERD Tool.exe`.

## 7. 문제 해결

| No. | 증상 | 확인할 것 |
|---|---|---|
| 1 | 접속할 때마다 비밀번호를 묻는다 | 마스터키 환경변수 이름이 정확한지, 넣은 뒤 도구를 다시 켰는지 |
| 2 | 「다른 DB 종류의 모델 폴더」 오류 | PostgreSQL 모델 폴더에 SQL Server 등 다른 DB 를 불러오려 한 것. 다른 폴더를 고른다 |
| 3 | 내장 터미널이 PowerShell 5.1 로 뜬다 | PowerShell 7 이 설치되어 있지 않은 것. 그대로 써도 된다 |
| 4 | 「AI 연결」 이 동작하지 않는다 | 내장 터미널에서 `claude --version` 또는 `codex --version` 이 나오는지 |

## 8. 관리자: 설치 파일 다시 만들기

| No. | 할 일 | 명령 |
|---|---|---|
| 1 | 의존성 설치 | `npm ci` |
| 2 | 시험 | `npm test`. DB 시험은 `test/.env.example` 을 `test/.env.local` 로 복사해 BE 폴더를 넣어야 돌고, 없으면 건너뛴다 |
| 3 | 설치 파일 빌드 | `npm run dist` → `dist/ERD-Tool-Setup-{버전}.exe` |

- 버전은 `package.json` 의 `version` 이다. 올린 뒤 빌드한다.
- 빌드 설정은 `electron-builder.yml` 이다. 디버거 연결과 Node 로 실행하기를 막는 Electron 퓨즈, 한국어, 영어 화면 글자 묶음만 넣기, 내장 터미널 파일을 압축 밖에 두기가 여기 있다.
- 코드 서명 인증서가 생기면 `win.signtoolOptions` 에 넣는다. 지금은 서명이 없어 설치할 때 3장 2번 창이 뜬다.
