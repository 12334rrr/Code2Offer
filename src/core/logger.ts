/**
 * 统一日志出口:CLI 走 console;VSCode 扩展注入 LogOutputChannel。
 * 此前各阶段直接 console.log,扩展宿主里用户完全看不到进度,
 * 表现为"运行很久没有任何反馈"。所有阶段/客户端统一从这里打日志。
 *
 * 0.5.2:支持「每次运行独立日志通道」(用户要求:前一次与后一次的输出不堆在一起)。
 * withLogSink 在一次管线运行的整个异步调用树里挂一个上下文专属 sink——
 * AsyncLocalStorage 跨 await/setTimeout 传播,多任务并行互不串线;
 * 上下文内的行同时送到 全局 sink(完整时间线)与 上下文 sink(该次运行独享的通道)。
 * 未挂上下文(CLI / evaluate / rehearse)时行为与旧版完全一致。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogSink {
  log: (line: string) => void;
  warn: (line: string) => void;
}

let sink: (line: string) => void = (line) => console.log(line);
let warnSink: (line: string) => void = (line) => console.warn(line);

const als = new AsyncLocalStorage<LogSink>();

export function setLogger(fn: (line: string) => void, warnFn?: (line: string) => void): void {
  sink = fn;
  warnSink = warnFn ?? fn;
}

/** 在 fn 的整个异步调用树里把日志路由到专属 sink(并行任务各走各的) */
export function withLogSink<T>(s: LogSink, fn: () => Promise<T>): Promise<T> {
  return als.run(s, fn);
}

export function log(line: string): void {
  const s = als.getStore();
  if (s) s.log(line);
  sink(line);
}

export function warn(line: string): void {
  const s = als.getStore();
  if (s) s.warn(line);
  warnSink(line);
}
