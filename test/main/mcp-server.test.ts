import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMcp, type McpHandle } from '../../src/main/mcp/server';

let mcp: McpHandle;
const asked: { tool: string; args: unknown }[] = [];
beforeAll(async () => {
  mcp = await startMcp({
    ask: async (tool, args) => {
      structuredClone(args); // 화면으로 보낼 수 있는 값이어야 한다 (IPC)
      asked.push({ tool, args });
      if (tool === 'erd_apply') throw new Error('1줄 「x」: 모르는 명령: x');
      return `${tool} 응답`;
    },
    query: async (conn, sql) => `${conn}: ${sql}`,
    connNames: () => ['dev', 'test'],
  });
});
afterAll(() => mcp.close());

let id = 0;
async function rpc(method: string, params: unknown = {}, auth = `Bearer ${mcp.token}`) {
  const r = await fetch(mcp.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: auth, 'MCP-Protocol-Version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  return { status: r.status, body: r.status === 200 ? await r.json() : await r.text() };
}
const callTool = async (name: string, args: unknown = {}) => (await rpc('tools/call', { name, arguments: args })).body.result;

describe('MCP 서버', () => {
  it('127.0.0.1 주소, 토큰이 없거나 틀리면 401', async () => {
    expect(mcp.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect((await rpc('tools/list', {}, '')).status).toBe(401);
    expect((await rpc('tools/list', {}, 'Bearer nope')).status).toBe(401);
  });

  it('initialize 와 도구 8개', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(init.body.result.serverInfo.name).toBe('erd-tool');
    const tools = (await rpc('tools/list')).body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(tools).toEqual(['db_compare', 'db_query', 'erd_apply', 'erd_export', 'erd_overview', 'erd_tables', 'erd_undo', 'erd_view_state']);
  });

  it('ERD 도구는 화면에 묻고, 실패는 isError 로 돌려준다', async () => {
    expect((await callTool('erd_overview')).content[0].text).toBe('erd_overview 응답');
    expect(asked.at(-1)).toEqual({ tool: 'erd_overview', args: {} });
    expect((await callTool('erd_tables', { names: ['mst_biz'] })).content[0].text).toBe('erd_tables 응답');
    expect(asked.at(-1)).toEqual({ tool: 'erd_tables', args: { names: ['mst_biz'] } });
    await callTool('db_compare', { from: 'dev', to: 'erd', kind: 'index' });
    expect(asked.at(-1)).toEqual({ tool: 'db_compare', args: { from: 'dev', to: 'erd', kind: 'index' } });
    const bad = await callTool('erd_apply', { commands: ['x'] });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('모르는 명령');
  });

  it('db_query 는 아는 접속만', async () => {
    expect((await callTool('db_query', { conn: 'dev', sql: 'select 1' })).content[0].text).toBe('dev: select 1');
    const r = await callTool('db_query', { conn: 'prod', sql: 'select 1' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('쓸 수 있는 접속: dev, test');
  });
});
