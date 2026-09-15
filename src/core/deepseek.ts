import { AppConfig } from './config';
import { log, warn } from './logger';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  retries?: number;
  /** 外部取消信号(VSCode 进度框取消 / CLI Ctrl+C 等),与超时叠加生效 */
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 组合超时与外部取消:任一触发即中止 fetch(兼容无 AbortSignal.any 的 Node 18) */
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
      if (external) external.removeEventListener('abort', onExternal);
    },
  };
}

/**
 * DeepSeek API 客户端(OpenAI 兼容协议,零依赖 fetch)。
 * - 401/403/400 等永久错误立即失败不重试;429/5xx 指数退避并尊重 Retry-After
 * - 模型名不可用时自动回退降级链;推理模型空输出自动加倍预算
 * - 外部 AbortSignal 支持用户取消长任务
 * - 错误文本统一打码密钥(部分网关会回显 Authorization 片段)
 * - 统计 token 用量,结束时打印成本
 */
export class DeepSeekClient {
  /** 降级链:超时/模型不可用时依次尝试(部分网关把 deepseek-chat 别名到同一后端,真正异构的备选在前) */
  private static readonly FALLBACK_CHAIN = ['deepseek-v4-pro', 'deepseek-chat'];

  private cfg: AppConfig;
  private modelInUse: string;
  private tokenScale = 1; // 推理模型可能把预算耗在思考上:空响应时自动加倍
  private consecutiveTimeouts = 0;
  private timeoutFallbackUsed = false;
  fallbackUsed = false;
  totalPromptTokens = 0;
  totalCompletionTokens = 0;
  totalCalls = 0;

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
    this.modelInUse = cfg.model;
  }

  /** 沿降级链取下一个与当前不同的模型;走完返回 null */
  private advanceFallback(): string | null {
    const chain = DeepSeekClient.FALLBACK_CHAIN;
    const cur = chain.indexOf(this.modelInUse);
    const next = cur >= 0 ? cur + 1 : 0;
    if (next >= chain.length) return null;
    const m = chain[next];
    return m === this.modelInUse ? null : m;
  }

  /** 打码错误文本中可能出现的密钥片段(只保留前 6 位) */
  private mask(msg: string): string {
    if (!this.cfg.apiKey) return msg;
    return msg.split(this.cfg.apiKey).join(`${this.cfg.apiKey.slice(0, 6)}***`);
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const retries = opts.retries ?? 3;
    let attempt = 0;
    for (;;) {
      if (opts.signal?.aborted) throw new Error('已取消');
      attempt++;
      try {
        const out = await this.once(messages, opts);
        this.consecutiveTimeouts = 0;
        return out;
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        if (raw === '已取消') throw err; // 用户取消不重试
        const msg = this.mask(raw);

        // 主模型连续超时(服务拥堵/降速):降级到备用模型,保证任务能完成(只降一次,防乒乓)
        if (/aborted due to timeout/i.test(msg) && !this.timeoutFallbackUsed) {
          this.consecutiveTimeouts++;
          const fb = this.consecutiveTimeouts >= 2 ? this.advanceFallback() : null;
          if (fb) {
            const waited = this.consecutiveTimeouts;
            this.timeoutFallbackUsed = true;
            this.fallbackUsed = true;
            this.consecutiveTimeouts = 0;
            warn(`[deepseek] 模型 "${this.modelInUse}" 连续 ${waited} 次请求超时,降级 ${fb} 继续`);
            this.modelInUse = fb;
            continue;
          }
        }
        // 模型名不可用:沿降级链回退
        if (/not found|does not exist|invalid model|不存在|Not Exist/i.test(msg)) {
          const fb = this.advanceFallback();
          if (fb) {
            this.fallbackUsed = true;
            warn(`[deepseek] 模型 "${this.modelInUse}" 不可用,自动回退 ${fb} 重试`);
            this.modelInUse = fb;
            continue;
          }
        }
        // 推理模型把 max_tokens 全花在思考上导致空输出:加倍预算重试
        if (/EMPTY_OUTPUT_MAX_TOKENS/.test(msg) && this.tokenScale < 4) {
          this.tokenScale *= 2;
          warn(`[deepseek] 推理耗尽输出预算,扩大 max_tokens ×${this.tokenScale} 重试`);
          continue;
        }
        if (attempt > retries) {
          throw new Error(`DeepSeek 调用失败(已重试 ${retries} 次):${msg}`);
        }
        const retryAfter = (err as { retryAfterMs?: number }).retryAfterMs ?? 0;
        const delay = retryAfter || Math.min(8000, 1000 * 2 ** (attempt - 1));
        warn(`[deepseek] 第 ${attempt} 次失败:${msg} — ${delay}ms 后重试`);
        await sleep(delay);
      }
    }
  }

  private async once(
    messages: ChatMessage[],
    opts: ChatOptions
  ): Promise<string> {
    this.totalCalls++;
    const body: Record<string, unknown> = {
      model: this.modelInUse,
      messages,
      temperature: opts.temperature ?? 0.3,
      stream: false,
    };
    const effectiveMax = opts.maxTokens ? opts.maxTokens * this.tokenScale : undefined;
    if (effectiveMax) body.max_tokens = effectiveMax;
    if (opts.jsonMode) body.response_format = { type: 'json_object' };

    const { signal, cleanup } = composeSignals(this.cfg.timeoutMs ?? 300_000, opts.signal);
    let res: Response;
    try {
      res = await fetch(this.cfg.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      throw new Error(/timeout/i.test(m) ? 'aborted due to timeout' : `网络请求失败:${m}`);
    } finally {
      cleanup();
    }
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 500);
      let retryAfterMs = 0;
      try {
        const j = JSON.parse(text);
        detail = j?.error?.message || j?.message || detail;
      } catch {
        /* 保留原始文本 */
      }
      // 429/5xx 尊重 Retry-After 头(秒或 HTTP 日期,做最简解析)
      const ra = res.headers.get('retry-after');
      if (ra && (res.status === 429 || res.status >= 500)) {
        const sec = Number(ra);
        retryAfterMs = Number.isFinite(sec) ? sec * 1000 : Math.max(0, new Date(ra).getTime() - Date.now());
      }
      const e = new Error(`HTTP ${res.status}: ${detail}`) as Error & { retryAfterMs?: number; status?: number };
      e.status = res.status;
      e.retryAfterMs = Math.min(30_000, retryAfterMs);
      // 永久错误(鉴权/非法请求)立即失败,不进入重试循环空烧时间
      if (res.status === 401 || res.status === 403 || res.status === 400 || res.status === 404) {
        throw new Error(
          `HTTP ${res.status}: ${detail}` +
            (res.status === 401 ? '(鉴权失败:请检查 DEEPSEEK_API_KEY 是否有效)' : '')
        );
      }
      throw e;
    }
    const data = JSON.parse(text);
    const choice = data?.choices?.[0];
    const message = choice?.message ?? {};
    const finish = choice?.finish_reason ?? '';
    this.totalPromptTokens += data?.usage?.prompt_tokens ?? 0;
    this.totalCompletionTokens += data?.usage?.completion_tokens ?? 0;

    let content = typeof message.content === 'string' ? message.content : '';
    if (!content.trim()) {
      // 预算被推理耗尽(思考未完成,reasoning 只是半成品):走加倍预算重试,不用 reasoning_content
      if (finish === 'length') throw new Error('EMPTY_OUTPUT_MAX_TOKENS:输出预算被推理耗尽');
      // 正常结束但没写 content:推理模型偶尔把完整答案写在思考里,兜底取用
      if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) {
        warn('[deepseek] content 为空(finish=stop),使用 reasoning_content 作为输出');
        return message.reasoning_content;
      }
      throw new Error(`空响应(finish_reason=${finish || '未知'})`);
    }
    return content;
  }

  get model(): string {
    return this.modelInUse;
  }

  printUsage(): void {
    log(
      `[deepseek] 共调用 ${this.totalCalls} 次 | 输入 ${this.totalPromptTokens} tok | 输出 ${this.totalCompletionTokens} tok | 模型 ${this.model}${this.fallbackUsed ? '(已回退)' : ''}`
    );
  }
}

/**
 * 从模型输出中尽力解析 JSON:剥代码围栏 → 直接 parse → 截取第一个平衡的 {} → 截断修复。
 * 截断修复对"输出预算被推理模型耗尽"的场景尤其有效:能救回已完整的前缀对象。
 */
export function parseJsonLoose<T = unknown>(text: string): T {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1].trim().startsWith('{')) t = fence[1].trim();
  try {
    return JSON.parse(t) as T;
  } catch {
    /* 继续尝试 */
  }
  // 消毒:字符串内部的裸换行/制表符会破坏 JSON.parse,统一转义后再试
  const sanitized = sanitizeRawControlChars(t);
  if (sanitized !== t) {
    try {
      return JSON.parse(sanitized) as T;
    } catch {
      /* 继续尝试 */
    }
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
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === '\\') {
        if (inStr) esc = true;
        continue;
      }
      if (ch === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (ch === '{' || ch === '[') stack.push(ch);
      else if (ch === '}' || ch === ']') {
        stack.pop();
        if (stack.length === 0 && ch === '}') {
          const candidate = seg.slice(0, i + 1);
          try {
            return JSON.parse(candidate) as T;
          } catch {
            /* 继续尝试截断修复 */
          }
        }
      }
    }
    // 截断修复:闭合未完成的字符串与括号(先去掉尾部悬空的逗号/冒号/半截 token)
    let repaired = inStr ? seg + '"' : seg;
    repaired = repaired.replace(/,\s*$/, '').replace(/:\s*$/, '');
    // 去掉最后一个不完整的元素(如 "key": "val 截断 → 连 key 一起去掉)
    if (inStr) {
      const lastQuote = repaired.lastIndexOf('"');
      const lastComma = Math.max(repaired.lastIndexOf(','), repaired.lastIndexOf('{'), repaired.lastIndexOf('['));
      if (lastQuote > lastComma) repaired = repaired.slice(0, Math.max(lastComma + 1, 1));
      repaired = repaired.replace(/,\s*$/, '');
    }
    while (stack.length) {
      const open = stack.pop();
      repaired += open === '{' ? '}' : ']';
    }
    try {
      return JSON.parse(repaired) as T;
    } catch {
      /* 放弃 */
    }
  }
  throw new Error(`无法从模型输出解析 JSON:${text.slice(0, 200)}`);
}

/** 把字符串字面量内部的裸控制字符(\n \r \t)转义为 \\n 等合法形式 */
function sanitizeRawControlChars(s: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (esc) {
      out += ch;
      esc = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      if (inStr) esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      out += ch;
      continue;
    }
    if (inStr && ch === '\n') {
      out += '\\n';
      continue;
    }
    if (inStr && ch === '\r') {
      continue; // \r\n 折叠为 \n
    }
    if (inStr && ch === '\t') {
      out += '\\t';
      continue;
    }
    out += ch;
  }
  return out;
}
