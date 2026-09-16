import { AppConfig } from './config';
import { log, warn } from './logger';
import { isLikelyReasoningModel, policyFor, RequestPolicy, RequestType, RunMode } from './policy';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  hardMaxTokens?: number;
  jsonMode?: boolean;
  retries?: number;
  signal?: AbortSignal;
  requestType?: RequestType;
  policy?: Partial<RequestPolicy>;
  mode?: RunMode;
}

export type DeepSeekErrorCode = 'http' | 'timeout' | 'network' | 'cancelled' | 'truncated' | 'empty' | 'invalid-json';

export class DeepSeekError extends Error {
  constructor(
    message: string,
    public readonly code: DeepSeekErrorCode,
    public readonly status?: number,
    public readonly retryAfterMs = 0,
    public readonly partialContent?: string
  ) {
    super(message);
    this.name = 'DeepSeekError';
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DeepSeekError('已取消', 'cancelled'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DeepSeekError('已取消', 'cancelled'));
    };
    function done(): void {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function composeSignals(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('aborted due to timeout')), timeoutMs);
  const onExternal = () => ctrl.abort(new Error('已取消'));
  if (external) {
    if (external.aborted) onExternal();
    else external.addEventListener('abort', onExternal, { once: true });
  }
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternal);
    },
  };
}

function nestedErrorCode(value: unknown, seen = new Set<unknown>()): string | undefined {
  if (!value || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return undefined;
  seen.add(value);
  const obj = value as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof obj.code === 'string' && obj.code) return obj.code;
  const causeCode = nestedErrorCode(obj.cause, seen);
  if (causeCode) return causeCode;
  if (Array.isArray(obj.errors)) {
    for (const item of obj.errors) {
      const code = nestedErrorCode(item, seen);
      if (code) return code;
    }
  }
  return undefined;
}

function networkHint(code?: string): string {
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return '域名解析失败,请检查网络/DNS或代理设置';
    case 'ECONNREFUSED':
      return '目标端口拒绝连接,请检查端点地址或本地网关是否启动';
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
      return '连接或响应超时,请检查网络/代理并适当增大 DEEPSEEK_TIMEOUT_MS';
    case 'ECONNRESET':
    case 'UND_ERR_SOCKET':
      return '连接被对端或代理重置,请检查代理、TLS 和网络稳定性';
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return 'TLS 证书校验失败,请检查系统证书或 HTTPS 网关配置';
    case 'EPIPE':
      return '连接已关闭,请检查代理或网关是否中途断开';
    default:
      return '请检查网络、代理、防火墙和 DEEPSEEK_BASE_URL';
  }
}

/** OpenAI-compatible client with request-local expansion and typed retry policy. */
export class DeepSeekClient {
  private static readonly FALLBACK_CHAIN = ['deepseek-v4-pro', 'deepseek-chat'];
  private readonly cfg: AppConfig;
  private modelInUse: string;
  private consecutiveTimeouts = 0;
  private timeoutFallbackUsed = false;
  private readonly routingNotices = new Set<string>();
  fallbackUsed = false;
  totalPromptTokens = 0;
  totalCompletionTokens = 0;
  totalCalls = 0;
  totalRetries = 0;
  totalTruncations = 0;
  private readonly byType = new Map<string, { calls: number; promptTokens: number; completionTokens: number; retries: number; truncations: number }>();

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
    this.modelInUse = cfg.model;
  }

  private advanceFallback(currentModel: string): string | null {
    const cur = DeepSeekClient.FALLBACK_CHAIN.indexOf(currentModel);
    const next = cur >= 0 ? cur + 1 : 0;
    if (next >= DeepSeekClient.FALLBACK_CHAIN.length) return null;
    const model = DeepSeekClient.FALLBACK_CHAIN[next];
    return model === currentModel ? null : model;
  }

  private mask(msg: string): string {
    let safe = msg;
    if (this.cfg.apiKey) safe = safe.split(this.cfg.apiKey).join(`${this.cfg.apiKey.slice(0, 6)}***`);
    return safe
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***')
      .replace(/\b(?:sk|ghp|xox[bp])-[A-Za-z0-9._-]{12,}\b/g, '***secret***')
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, '***aws-key***');
  }

  private networkDiagnostic(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    const code = nestedErrorCode(err);
    let endpoint = this.cfg.baseUrl;
    try {
      const url = new URL(this.cfg.baseUrl);
      endpoint = `${url.protocol}//${url.host}`;
    } catch {
      endpoint = '[无效端点]';
    }
    const detail = code || !/^fetch failed$/i.test(raw) ? `:${this.mask(raw).slice(0, 240)}` : '';
    return `[${endpoint}] ${networkHint(code)}${code ? ` (${code})` : ''}${detail}`;
  }

  private statsFor(type: string) {
    let value = this.byType.get(type);
    if (!value) {
      value = { calls: 0, promptTokens: 0, completionTokens: 0, retries: 0, truncations: 0 };
      this.byType.set(type, value);
    }
    return value;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const requestType = opts.requestType ?? 'stage5-narrative';
    const policy = Object.freeze({ ...policyFor(requestType, this.modelInUse, this.cfg.timeoutMs, opts.mode), ...opts.policy }) as RequestPolicy;
    let activeModel = policy.model;
    if (activeModel !== this.modelInUse) {
      const routeKey = `${this.modelInUse}->${activeModel}:${requestType}`;
      if (!this.routingNotices.has(routeKey)) {
        this.routingNotices.add(routeKey);
        warn(`[deepseek] ${requestType} 为严格结构化输出,使用 ${activeModel} 避免 ${this.modelInUse} 推理预算耗尽`);
      }
    }
    const retries = opts.retries ?? policy.retries;
    const baseMaxTokens = Math.max(1, Math.min(policy.hardMaxTokens, Math.round(opts.maxTokens ?? policy.baseMaxTokens)));
    const hardMaxTokens = Math.max(baseMaxTokens, Math.min(policy.hardMaxTokens, Math.round(opts.hardMaxTokens ?? policy.hardMaxTokens)));
    // Expansion belongs to this logical request only; the next chat starts at scale 1.
    let requestScale = 1;
    let attempt = 0;
    for (;;) {
      if (opts.signal?.aborted) throw new DeepSeekError('已取消', 'cancelled');
      attempt++;
      try {
        const out = await this.once(messages, { ...opts, requestType, policy, maxTokens: baseMaxTokens, hardMaxTokens }, requestScale, activeModel);
        this.consecutiveTimeouts = 0;
        return out;
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        if (err instanceof DeepSeekError && err.code === 'cancelled') throw err;
        if (opts.signal?.aborted || /已取消|aborted by user/i.test(raw)) throw new DeepSeekError('已取消', 'cancelled');
        const msg = this.mask(raw);
        const status = err instanceof DeepSeekError ? err.status : (err as { status?: number }).status;

        if (err instanceof DeepSeekError && err.code === 'truncated') {
          this.totalTruncations++;
          this.statsFor(requestType).truncations++;
          // 叙述类允许先尝试用户选择的推理模型；若第一次就耗尽输出预算，
          // 不再用更大预算重复烧 reasoning，当前请求直接改用 chat 完成。
          if (activeModel !== 'deepseek-chat' && isLikelyReasoningModel(activeModel)) {
            this.fallbackUsed = true;
            this.totalRetries++;
            this.statsFor(requestType).retries++;
            warn(`[deepseek] ${activeModel} 输出预算被推理耗尽,本次请求切换 deepseek-chat 重试`);
            activeModel = 'deepseek-chat';
            requestScale = 1;
            continue;
          }
        }

        // A model-not-found response is the only 400/404 that may use fallback.
        const modelMissing = (status === 400 || status === 404) && /not found|does not exist|invalid model|不存在|not exist/i.test(msg);
        if (modelMissing) {
          const fb = this.advanceFallback(activeModel);
          if (fb) {
            this.fallbackUsed = true;
            warn(`[deepseek] 模型 "${activeModel}" 不可用,自动回退 ${fb} 重试`);
            if (activeModel === this.modelInUse) this.modelInUse = fb;
            activeModel = fb;
            continue;
          }
        }
        // Permanent authentication/parameter/resource errors never enter backoff.
        if (status === 400 || status === 401 || status === 403 || status === 404) {
          throw new DeepSeekError(msg, 'http', status);
        }

        if (/aborted due to timeout|请求超时/i.test(msg) && !this.timeoutFallbackUsed) {
          this.consecutiveTimeouts++;
          const fb = this.consecutiveTimeouts >= 2 ? this.advanceFallback(activeModel) : null;
          if (fb) {
            this.timeoutFallbackUsed = true;
            this.fallbackUsed = true;
            this.consecutiveTimeouts = 0;
            warn(`[deepseek] 模型 "${activeModel}" 连续 2 次请求超时,降级 ${fb} 继续`);
            if (activeModel === this.modelInUse) this.modelInUse = fb;
            activeModel = fb;
            continue;
          }
        }

        // finish_reason=length/reasoning exhaustion is retried in this call only.
        if (/EMPTY_OUTPUT_MAX_TOKENS|TRUNCATED_OUTPUT_MAX_TOKENS/.test(msg)) {
          const currentMax = Math.min(hardMaxTokens, Math.round(baseMaxTokens * requestScale));
          const nextMax = Math.min(hardMaxTokens, Math.max(currentMax + 1, currentMax * 2));
          if (nextMax > currentMax) {
            requestScale = nextMax / baseMaxTokens;
            this.totalRetries++;
            this.statsFor(requestType).retries++;
            warn(`[deepseek] 本次请求输出预算不足, max_tokens=${nextMax}/${hardMaxTokens} 重试`);
            continue;
          }
          // 已到单请求硬上限:不要把同一截断响应再做网络重试,交给调用方决定降级。
          if (err instanceof DeepSeekError) throw err;
        }

        if (attempt > retries) {
          throw new DeepSeekError(`DeepSeek 调用失败(已重试 ${retries} 次):${msg}`, err instanceof DeepSeekError ? err.code : 'network', status);
        }
        const retryAfter = err instanceof DeepSeekError ? err.retryAfterMs : 0;
        const delay = retryAfter || Math.min(8000, 1000 * 2 ** (attempt - 1));
        this.totalRetries++;
        this.statsFor(requestType).retries++;
        warn(`[deepseek] 第 ${attempt} 次失败:${msg} — ${delay}ms 后重试`);
        await sleep(delay, opts.signal);
      }
    }
  }

  private async once(
    messages: ChatMessage[],
    opts: ChatOptions & { policy: RequestPolicy; hardMaxTokens: number },
    requestScale: number,
    activeModel: string
  ): Promise<string> {
    const type = opts.requestType ?? 'stage5-narrative';
    this.totalCalls++;
    this.statsFor(type).calls++;
    const body: Record<string, unknown> = {
      model: activeModel,
      messages,
      temperature: opts.temperature ?? opts.policy.temperature,
      stream: false,
      max_tokens: Math.min(opts.hardMaxTokens, Math.max(1, Math.round((opts.maxTokens ?? opts.policy.baseMaxTokens) * requestScale))),
    };
    if (opts.jsonMode ?? opts.policy.jsonMode) body.response_format = { type: 'json_object' };
    const { signal, cleanup } = composeSignals(opts.policy.timeout, opts.signal);
    let res: Response;
    try {
      res = await fetch(this.cfg.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (opts.signal?.aborted) throw new DeepSeekError('已取消', 'cancelled');
      const m = err instanceof Error ? err.message : String(err);
      const isTimeout = /timeout|aborted/i.test(m) || /TIMEOUT/i.test(nestedErrorCode(err) ?? '');
      throw new DeepSeekError(isTimeout ? `请求超时:${this.networkDiagnostic(err)}` : `网络请求失败:${this.networkDiagnostic(err)}`, isTimeout ? 'timeout' : 'network');
    } finally {
      cleanup();
    }
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 500);
      try {
        const j = JSON.parse(text);
        detail = j?.error?.message || j?.message || detail;
      } catch { /* use bounded text */ }
      let retryAfterMs = 0;
      const retryAfter = res.headers.get('retry-after');
      if (retryAfter && (res.status === 408 || res.status === 429 || res.status >= 500)) {
        const seconds = Number(retryAfter);
        retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, new Date(retryAfter).getTime() - Date.now());
      }
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      throw new DeepSeekError(
        `HTTP ${res.status}: ${this.mask(String(detail)).slice(0, 500)}${res.status === 401 ? '(鉴权失败:请检查 DEEPSEEK_API_KEY 是否有效)' : ''}`,
        retryable ? 'network' : 'http',
        res.status,
        Math.min(30_000, retryAfterMs)
      );
    }
    let data: any;
    try { data = JSON.parse(text); }
    catch (err) { throw new DeepSeekError(`响应 JSON 无法解析:${err instanceof Error ? err.message : String(err)}`, 'invalid-json'); }
    const choice = data?.choices?.[0];
    const message = choice?.message ?? {};
    const finish = choice?.finish_reason ?? '';
    const promptTokens = Number(data?.usage?.prompt_tokens ?? 0) || 0;
    const completionTokens = Number(data?.usage?.completion_tokens ?? 0) || 0;
    this.totalPromptTokens += promptTokens;
    this.totalCompletionTokens += completionTokens;
    this.statsFor(type).promptTokens += promptTokens;
    this.statsFor(type).completionTokens += completionTokens;
    const content = typeof message.content === 'string' ? message.content : '';
    if (!content.trim()) {
      if (finish === 'length') throw new DeepSeekError('EMPTY_OUTPUT_MAX_TOKENS:输出预算被推理耗尽', 'truncated');
      if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim() && finish === 'stop') {
        warn('[deepseek] content 为空(finish=stop),使用 reasoning_content 作为输出');
        return message.reasoning_content;
      }
      throw new DeepSeekError(`空响应(finish_reason=${finish || '未知'})`, 'empty');
    }
    // Non-empty content is not complete when finish_reason=length.
    if (finish === 'length') throw new DeepSeekError('TRUNCATED_OUTPUT_MAX_TOKENS:响应被 max_tokens 截断', 'truncated', undefined, 0, content);
    return content;
  }

  get model(): string { return this.modelInUse; }

  usage(): { totalCalls: number; promptTokens: number; completionTokens: number; retries: number; truncations: number; byType: Record<string, unknown> } {
    return {
      totalCalls: this.totalCalls,
      promptTokens: this.totalPromptTokens,
      completionTokens: this.totalCompletionTokens,
      retries: this.totalRetries,
      truncations: this.totalTruncations,
      byType: Object.fromEntries([...this.byType.entries()].map(([k, v]) => [k, { ...v }])),
    };
  }

  printUsage(): void {
    log(`[deepseek] 共调用 ${this.totalCalls} 次 | 输入 ${this.totalPromptTokens} tok | 输出 ${this.totalCompletionTokens} tok | 重试 ${this.totalRetries} | 截断 ${this.totalTruncations} | 模型 ${this.model}${this.fallbackUsed ? '(已回退)' : ''}`);
  }
}

/** Parse JSON first, then tolerate surrounding prose/control characters. */
export function parseJsonLoose<T = unknown>(text: string): T {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1].trim().startsWith('{')) t = fence[1].trim();
  try { return JSON.parse(t) as T; } catch { /* continue */ }
  const sanitized = sanitizeRawControlChars(t);
  if (sanitized !== t) {
    try { return JSON.parse(sanitized) as T; } catch { /* continue */ }
  }
  const source = sanitized !== t ? sanitized : t;
  const start = source.indexOf('{');
  if (start >= 0) {
    const seg = source.slice(start);
    let depth = 0;
    let inStr = false;
    let esc = false;
    const stack: string[] = [];
    for (let i = 0; i < seg.length; i++) {
      const ch = seg[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { if (inStr) esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{' || ch === '[') { stack.push(ch); depth++; }
      else if (ch === '}' || ch === ']') {
        stack.pop(); depth--;
        if (depth === 0 && ch === '}') {
          try { return JSON.parse(seg.slice(0, i + 1)) as T; } catch { /* continue */ }
        }
      }
    }
    let repaired = inStr ? seg + '"' : seg;
    repaired = repaired.replace(/,\s*$/, '').replace(/:\s*$/, '');
    if (inStr) {
      const lastQuote = repaired.lastIndexOf('"');
      const lastComma = Math.max(repaired.lastIndexOf(','), repaired.lastIndexOf('{'), repaired.lastIndexOf('['));
      if (lastQuote > lastComma) repaired = repaired.slice(0, Math.max(lastComma + 1, 1));
      repaired = repaired.replace(/,\s*$/, '');
    }
    while (stack.length) repaired += stack.pop() === '{' ? '}' : ']';
    try { return JSON.parse(repaired) as T; } catch { /* give caller a parse failure */ }
  }
  throw new Error(`无法从模型输出解析 JSON:${text.slice(0, 200)}`);
}

function sanitizeRawControlChars(s: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; if (inStr) esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr && ch === '\n') { out += '\\n'; continue; }
    if (inStr && ch === '\r') continue;
    if (inStr && ch === '\t') { out += '\\t'; continue; }
    out += ch;
  }
  return out;
}
