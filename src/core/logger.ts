/**
 * 统一日志出口:CLI 走 console;VSCode 扩展注入 LogOutputChannel。
 * 此前各阶段直接 console.log,扩展宿主里用户完全看不到进度,
 * 表现为"运行很久没有任何反馈"。所有阶段/客户端统一从这里打日志。
 */
let sink: (line: string) => void = (line) => console.log(line);
let warnSink: (line: string) => void = (line) => console.warn(line);

export function setLogger(fn: (line: string) => void, warnFn?: (line: string) => void): void {
  sink = fn;
  warnSink = warnFn ?? fn;
}

export function log(line: string): void {
  sink(line);
}

export function warn(line: string): void {
  warnSink(line);
}
