---
title: {{group}} 그룹 테이블 정의서
description: {{group}} 그룹 테이블의 컬럼, PK, FK, UNIQUE, 인덱스 정의를 확인할 때 읽는다 (ERD 도구가 스키마 모델에서 만든 문서)
status: draft
version: 0.1.0
agent_usage: instruction
domain: database
generated_at: {{generatedAt}}
tags:
  - database
  - table
  - schema
  - {{group}}
---

# {{group}} 그룹 테이블 정의서

> - ERD 도구가 스키마 모델에서 만든 문서다({{generatedAt}}). 업무 설명은 허브 `40-schema` 원본 문서에 있다.
> - 테이블 {{tableCount}}개, 컬럼 {{columnCount}}개, FK {{fkCount}}개
> - NULL 칸: `N` 은 NOT NULL, `Y` 는 NULL 허용

## 1. 테이블 목록

| No. | 테이블명 | 설명 |
|---|---|---|
{{#tables}}
| {{no}} | {{name}} | {{comment}} |
{{/tables}}

## 2. 테이블 정의

{{#tables}}
### 2-{{no}}. {{name}}

{{#comment}}
{{comment}}

{{/comment}}
| No. | 컬럼 | 타입 | NULL | 기본값 | PK | 설명 |
|---|---|---|---|---|---|---|
{{#columns}}
| {{no}} | {{name}} | {{type}} | {{nullable}} | {{default}} | {{pk}} | {{comment}} |
{{/columns}}

{{#fks}}
{{#first}}
FK

| No. | 이름 | 컬럼 | 참조 |
|---|---|---|---|
{{/first}}
| {{no}} | {{name}} | {{columns}} | {{ref}} |
{{#last}}

{{/last}}
{{/fks}}
{{#uniques}}
{{#first}}
UNIQUE 제약

| No. | 이름 | 컬럼 |
|---|---|---|
{{/first}}
| {{no}} | {{name}} | {{columns}} |
{{#last}}

{{/last}}
{{/uniques}}
{{#indexes}}
{{#first}}
인덱스

| No. | 이름 | 컬럼 | UNIQUE |
|---|---|---|---|
{{/first}}
| {{no}} | {{name}} | {{columns}} | {{unique}} |
{{#last}}

{{/last}}
{{/indexes}}
{{/tables}}
