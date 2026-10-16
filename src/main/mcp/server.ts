// MCP 서버 (STEP 8, 설계 10장): AI(Claude Code, Codex)가 지금 열린 ERD 를 읽고 고친다.
// - 127.0.0.1 에서만 받고, 앱을 켤 때마다 새로 만든 토큰(Authorization: Bearer)이 없으면 401 이다
// - 요청마다 McpServer 와 상태 없는 전송을 새로 만든다 (@modelcontextprotocol/server 2.x 문서 방식)
// - ERD 도구는 모델과 확정 대기 상태가 있는 화면에 묻고(ask), db_query 는 메인이 읽기 전용으로 직접 실행한다

import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import * as z from 'zod';
import { MAX_COMMANDS } from '../../shared/ai/commands';

/** 화면에 ERD 도구 처리를 맡긴다. 답은 AI 에게 줄 글이다 */
export type AskRenderer = (tool: string, args: Record<string, unknown>) => Promise<string>;

export interface McpDeps {
  ask: AskRenderer;
  query: (conn: string, sql: string) => Promise<string>;
  /** db_query 에 쓸 수 있는 접속 이름 */
  connNames: () => string[];
}

export interface McpHandle { url: string; token: string; close(): Promise<void> }

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: `실패: ${(e as Error).message}` }], isError: true });

function build(deps: McpDeps): McpServer {
  const s = new McpServer({ name: 'erd-tool', version: '0.1.0' });
  // 입력이 없는 도구는 SDK 가 첫 인자로 요청 정보(함수가 든 객체)를 넘긴다. 화면에 보낼 수 없으므로 입력이 있는 도구만 인자를 넘긴다
  const ask = async (tool: string, args: Record<string, unknown>) => {
    try { return text(await deps.ask(tool, args)); } catch (e) { return fail(e); }
  };
  const call = (tool: string) => async () => ask(tool, {});
  const callWith = (tool: string) => async (args: Record<string, unknown>) => ask(tool, structuredClone(args));

  s.registerTool('erd_overview', {
    description: '지금 ERD 도구에 열린 모델의 개요. 그룹마다 한 줄(그룹, 접두어, 테이블 수, 테이블 이름)과 공통 컬럼(+common) 정의. 먼저 이것을 보고, 구조가 필요한 테이블만 erd_tables 로 묻는다',
  }, call('erd_overview'));

  s.registerTool('erd_tables', {
    description: '요청한 테이블만 한 줄 표기로. 테이블 줄 「이름 [그룹] 코멘트 [+common]」, 컬럼 줄 「이름 타입 [PK] [NN] [=기본값] [FK>테이블.컬럼] [#코멘트]」. +common 은 공통 컬럼이 끝에 있다는 뜻',
    inputSchema: z.object({ names: z.array(z.string()).min(1).max(50).describe('테이블 이름 목록') }),
  }, callWith('erd_tables'));

  s.registerTool('erd_view_state', {
    description: '화면 배치를 말로: 배치 방식, 그룹별 격자 열 수와 행마다 테이블 이름, 고정(끌어 옮긴) 테이블이 어느 테이블 옆인지, 확대 배율, 겹친 테이블 쌍 수. 좌표는 주지 않는다',
  }, call('erd_view_state'));

  s.registerTool('erd_apply', {
    description: [
      `ERD 모델을 고친다. 한 줄에 명령 하나, 한 번에 ${MAX_COMMANDS}줄까지. 하나라도 실패하면 아무것도 바꾸지 않는다.`,
      '바꾼 내용은 화면에 강조되고 사람이 확정하기 전까지 「확정 대기」다(파일 저장은 사람이 한다). DB 는 바꾸지 않는다.',
      '명령:',
      'add_table 이름 [+common] [#코멘트]  (+common 이면 공통 컬럼을 넣는다)',
      'add_column 테이블.컬럼 타입 [PK] [NN] [=기본값] [#코멘트]',
      'alter_column 테이블.컬럼 타입 [PK] [NN] [=기본값] [#코멘트]  (정의 전체를 다시 쓴다. 코멘트를 빼면 원래 코멘트 유지)',
      'drop_column 테이블.컬럼 | drop_table 테이블',
      'rename 테이블 -> 새이름 | rename 테이블.컬럼 -> 새이름',
      'comment 테이블[.컬럼] #코멘트',
      'add_fk 테이블.컬럼[,컬럼] -> 참조테이블.컬럼[,컬럼] [name=FK이름]  (참조 컬럼은 PK 나 UNIQUE)',
      'drop_fk 테이블 FK이름',
      'place 테이블 after=기준테이블 [group=그룹]  (기준 테이블 옆 빈 자리에 둔다. 좌표는 프로그램이 정하고 다른 테이블은 움직이지 않는다)',
      '타입 예: integer, bigint, varchar(50), char(1), numeric(10,2), timestamp, text',
    ].join('\n'),
    inputSchema: z.object({ commands: z.array(z.string()).min(1).max(MAX_COMMANDS).describe('명령 줄 목록') }),
  }, callWith('erd_apply'));

  s.registerTool('erd_undo', {
    description: '마지막 erd_apply 하나를 되돌린다 (사람이 확정한 뒤에는 되돌리지 않는다)',
  }, call('erd_undo'));

  s.registerTool('erd_export', {
    description: '파일 내보내기. md: 그룹별 테이블 정의서와 색인을 마지막 MD 폴더에(같은 이름은 덮어쓴다). flyway: conn 접속의 지금 구조를 지금 ERD 로 바꾸는 Flyway 파일을 마지막 Flyway 폴더에(파일만 만들고 DB 에 실행하지 않는다). 확정 대기 중이면 거부한다',
    inputSchema: z.object({
      kind: z.enum(['md', 'flyway']),
      conn: z.string().optional().describe('flyway 일 때 비교할 접속 이름 (예: dev)'),
      description: z.string().optional().describe('flyway 파일 설명, 영문 소문자 snake_case (예: add_mst_biz_wh_sort_no)'),
    }),
  }, callWith('erd_export'));

  s.registerTool('db_query', {
    description: '접속 하나에서 SQL 한 문장을 읽기 전용으로 실행한다(쓰기는 DB 가 막는다). 결과는 앞 50행과 전체 행 수. 접속 이름은 오류 메시지나 erd_overview 로 알 수 있다',
    inputSchema: z.object({ conn: z.string().describe('접속 이름 (예: dev, test)'), sql: z.string().describe('SQL 한 문장') }),
  }, async ({ conn, sql }) => {
    try {
      if (!deps.connNames().includes(conn)) throw new Error(`접속 ${conn} 이 없다. 쓸 수 있는 접속: ${deps.connNames().join(', ') || '없음'}`);
      return text(await deps.query(conn, sql));
    } catch (e) { return fail(e); }
  });
  return s;
}

const sameToken = (got: string | undefined, want: string) => {
  const a = Buffer.from(got ?? ''), b = Buffer.from(`Bearer ${want}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

export async function startMcp(deps: McpDeps, port = 0): Promise<McpHandle> {
  const token = crypto.randomBytes(32).toString('hex');
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const server = http.createServer(async (req, res) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/mcp') { res.writeHead(404).end(); return; }
    if (!sameToken(req.headers.authorization, token)) { res.writeHead(401, { 'Content-Type': 'text/plain' }).end('unauthorized'); return; }
    try {
      const mcp = build(deps);
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' }).end((e as Error).message);
    }
  });
  await new Promise<void>((ok, bad) => { server.once('error', bad); server.listen(port, '127.0.0.1', () => ok()); });
  const { port: p } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${p}/mcp`,
    token,
    close: () => new Promise<void>(ok => server.close(() => ok())),
  };
}
