// 메인이 보내는 터미널 출력을 터미널 탭별로 나눠 준다 (preload 리스너는 한 번만 등록)
type Handlers = { data: (d: string) => void; exit: (code: number) => void };
const handlers = new Map<string, Handlers>();
let started = false;

export function subscribe(id: string, h: Handlers) {
  if (!started) {
    started = true;
    window.erd.term.onData((tid, d) => handlers.get(tid)?.data(d));
    window.erd.term.onExit((tid, c) => handlers.get(tid)?.exit(c));
  }
  handlers.set(id, h);
  return () => handlers.delete(id);
}
