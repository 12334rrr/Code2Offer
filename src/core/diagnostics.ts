import { AppConfig } from './config';
import { DeepSeekClient, DeepSeekError } from './deepseek';

export interface DiagnosticStep {
  id: 'config' | 'request';
  ok: boolean;
  elapsedMs: number;
  detail: string;
}

export interface DeepSeekDiagnostic {
  ok: boolean;
  startedAt: string;
  model: string;
  endpoint: string;
  configSources: AppConfig['sources'];
  steps: DiagnosticStep[];
}

/** A production-path, source-free connection check. Never include keys/prompts in output. */
export async function diagnoseDeepSeek(cfg: AppConfig, signal?: AbortSignal): Promise<DeepSeekDiagnostic> {
  const startedAt = new Date().toISOString();
  const endpoint = safeOrigin(cfg.baseUrl);
  const steps: DiagnosticStep[] = [{ id: 'config', ok: true, elapsedMs: 0, detail: `端点 ${endpoint}；模型 ${cfg.model}；密钥来源 ${cfg.sources.apiKey}` }];
  const client = new DeepSeekClient(cfg);
  const started = Date.now();
  try {
    await client.chat([
      { role: 'system', content: 'Return only a JSON object.' },
      { role: 'user', content: 'Set the ok field to true.' },
    ], { jsonMode: true, maxTokens: 64, hardMaxTokens: 128, retries: 0, signal, requestType: 'stage3-verify', policy: { timeout: Math.min(cfg.timeoutMs ?? 30_000, 30_000) } });
    steps.push({ id: 'request', ok: true, elapsedMs: Date.now() - started, detail: `最小 JSON 请求成功；实际模型 ${client.model}` });
  } catch (err) {
    const detail = err instanceof DeepSeekError ? `${err.code}${err.status ? ` / HTTP ${err.status}` : ''}：${err.message}` : err instanceof Error ? err.message : String(err);
    steps.push({ id: 'request', ok: false, elapsedMs: Date.now() - started, detail: detail.slice(0, 600) });
  }
  return { ok: steps.every((s) => s.ok), startedAt, model: client.model, endpoint, configSources: cfg.sources, steps };
}

function safeOrigin(value: string): string {
  try { const u = new URL(value); return `${u.protocol}//${u.host}`; }
  catch { return '[无效端点]'; }
}
