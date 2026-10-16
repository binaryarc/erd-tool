---
title: 테이블 목록 색인
description: 스키마 모델의 그룹별 테이블 수, 그룹 문서 위치, 전체 테이블 목록을 확인할 때 읽는다 (ERD 도구가 스키마 모델에서 만든 색인)
status: draft
version: 0.1.0
agent_usage: instruction
domain: database
generated_at: {{generatedAt}}
tags:
  - database
  - table
  - schema
---

# 테이블 목록 색인

> ERD 도구가 스키마 모델에서 만든 색인이다({{generatedAt}}). 테이블 {{tableCount}}개, FK {{fkCount}}개, 시퀀스 {{seqCount}}개, 함수 {{fnCount}}개.

## 1. 그룹별 테이블 수

| No. | 그룹 | 접두어 | 테이블 수 | 그룹 문서 |
|---|---|---|---|---|
{{#groups}}
| {{no}} | {{name}} | {{prefix}} | {{count}} | [{{file}}](./{{file}}) |
{{/groups}}

## 2. 그룹별 테이블 목록

{{#groups}}
### 2-{{no}}. {{name}}

| No. | 테이블명 | 설명 |
|---|---|---|
{{#tables}}
| {{no}} | {{name}} | {{comment}} |
{{/tables}}

{{/groups}}
