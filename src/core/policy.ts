/**
 * 所有模型调用共用的请求策略。策略是不可变的、按逻辑请求创建，
 * 不把一次请求的重试/扩容状态写回客户端或其他阶段。
 */
export type RunMode = 'economy' | 'balanced' | 'deep';

export type RequestType =
  | 'stage1-module'
  | 'stage1-synthesis'
  | 'stage2-question'
  | 'stage2-repair'
  | 'stage2-comparison'
  | 'stage2-points'
  | 'stage3-verify'
  | 'stage3-rewrite'
  | 'stage4-jd'
  | 'stage5-narrative'
  | 'stage6-rehearse'
  | 'evaluate';

export interface RequestPolicy {
  requestType: RequestType;
  model: string;
  temperature: number;
  jsonMode: boolean;
  baseMaxTokens: number;
  hardMaxTokens: number;
  timeout: number;
  retries: number;
  concurrencyGroup: string;
  cachePolicy: 'read-write' | 'read-only' | 'disabled';
  reasoningPolicy: 'disabled' | 'allow' | 'prefer-fast';
}

const POLICY_DEFAULTS: Record<RequestType, Omit<RequestPolicy, 'requestType' | 'model'>> = {
  'stage1-module': { temperature: 0.15, jsonMode: true, baseMaxTokens: 6500, hardMaxTokens: 12000, timeout: 300000, retries: 2, concurrencyGroup: 'read', cachePolicy: 'read-write', reasoningPolicy: 'prefer-fast' },
  'stage1-synthesis': { temperature: 0.15, jsonMode: true, baseMaxTokens: 5500, hardMaxTokens: 10000, timeout: 300000, retries: 2, concurrencyGroup: 'read', cachePolicy: 'read-write', reasoningPolicy: 'prefer-fast' },
  'stage2-question': { temperature: 0.35, jsonMode: true, baseMaxTokens: 11000, hardMaxTokens: 16000, timeout: 300000, retries: 2, concurrencyGroup: 'questions', cachePolicy: 'read-write', reasoningPolicy: 'prefer-fast' },
  'stage2-repair': { temperature: 0.2, jsonMode: true, baseMaxTokens: 6000, hardMaxTokens: 10000, timeout: 300000, retries: 1, concurrencyGroup: 'questions', cachePolicy: 'read-write', reasoningPolicy: 'prefer-fast' },
  'stage2-comparison': { temperature: 0.2, jsonMode: true, baseMaxTokens: 2600, hardMaxTokens: 5000, timeout: 300000, retries: 1, concurrencyGroup: 'repair', cachePolicy: 'read-write', reasoningPolicy: 'prefer-fast' },
  'stage2-points': { temperature: 0.15, jsonMode: true, baseMaxTokens: 2200, hardMaxTokens: 4500, timeout: 300000, retries: 1, concurrencyGroup: 'repair', cachePolicy: 'read-write', reasoningPolicy: 'prefer-fast' },
  'stage3-verify': { temperature: 0.05, jsonMode: true, baseMaxTokens: 6500, hardMaxTokens: 10000, timeout: 300000, retries: 2, concurrencyGroup: 'verify', cachePolicy: 'read-write', reasoningPolicy: 'prefer-fast' },
  'stage3-rewrite': { temperature: 0.1, jsonMode: true, baseMaxTokens: 2200, hardMaxTokens: 4500, timeout: 300000, retries: 1, concurrencyGroup: 'repair', cachePolicy: 'read-write', reasoningPolicy: 'prefer-fast' },
  'stage4-jd': { temperature: 0.15, jsonMode: true, baseMaxTokens: 3500, hardMaxTokens: 7000, timeout: 300000, retries: 2, concurrencyGroup: 'jd', cachePolicy: 'read-write', reasoningPolicy: 'prefer-fast' },
  'stage5-narrative': { temperature: 0.45, jsonMode: false, baseMaxTokens: 6000, hardMaxTokens: 10000, timeout: 300000, retries: 2, concurrencyGroup: 'narrative', cachePolicy: 'read-write', reasoningPolicy: 'allow' },
  'stage6-rehearse': { temperature: 0.2, jsonMode: true, baseMaxTokens: 1800, hardMaxTokens: 3500, timeout: 300000, retries: 2, concurrencyGroup: 'rehearse', cachePolicy: 'disabled', reasoningPolicy: 'prefer-fast' },
  evaluate: { temperature: 0.1, jsonMode: true, baseMaxTokens: 3000, hardMaxTokens: 6000, timeout: 300000, retries: 2, concurrencyGroup: 'evaluate', cachePolicy: 'read-write', reasoningPolicy: 'prefer-fast' },
};

/**
 * 推理型模型在严格 JSON 任务上可能把 completion 预算消耗在 reasoning，
 * 最终 content 为空或被截断。prefer-fast 请求优先路由到稳定的 chat 模型；
 * 叙述类 allow 仍尊重用户选择的模型。
 */
export function isLikelyReasoningModel(model: string): boolean {
  return /(?:reasoner|reasoning|thinking|deepseek[-_]?r1|deepseek[-_]?flash|deepseek[-_]?v4[-_]?pro)/i.test(model);
}

export function modelForPolicy(model: string, reasoningPolicy: RequestPolicy['reasoningPolicy']): string {
  if (reasoningPolicy !== 'prefer-fast') return model;
  return isLikelyReasoningModel(model)
    ? 'deepseek-chat'
    : model;
}

export function policyFor(requestType: RequestType, model: string, timeout?: number, mode: RunMode = 'balanced'): RequestPolicy {
  const base = POLICY_DEFAULTS[requestType];
  const factor = mode === 'economy' ? 0.75 : mode === 'deep' ? 1.15 : 1;
  return Object.freeze({
    requestType,
    model: modelForPolicy(model, base.reasoningPolicy),
    ...base,
    baseMaxTokens: Math.max(512, Math.round(base.baseMaxTokens * factor)),
    hardMaxTokens: Math.max(1024, Math.round(base.hardMaxTokens * factor)),
    timeout: timeout ?? base.timeout,
  });
}

export function estimatedCalls(mode: RunMode): { min: number; max: number; note: string } {
  if (mode === 'economy') return { min: 5, max: 15, note: '约 40 题、轻量校验，适合预览' };
  if (mode === 'deep') return { min: 28, max: 40, note: '100 题、全部对抗校验和严格门禁' };
  return { min: 20, max: 34, note: '100 题、平衡批次与证据校验' };
}

export function modeLabel(mode: RunMode): string {
  return mode === 'economy' ? '经济' : mode === 'deep' ? '深度' : '平衡';
}
