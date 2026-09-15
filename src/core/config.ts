import * as fs from 'fs';
import * as path from 'path';

export interface AppConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 单请求超时毫秒数(推理模型较慢,默认 300 秒) */
  timeoutMs?: number;
  /** 各字段实际来源(排查配置问题用;密钥只显示来源文件,不显示值) */
  sources: { apiKey: string; baseUrl: string; model: string };
}

export interface LoadConfigOptions {
  /** 受信目录(宿主自己的 .env:CLI 的 cwd/工具根;扩展的工作区根/全局存储) */
  trustedDirs?: string[];
  /** 被分析的仓库根(不可信:不得凭它把请求重定向到别处,见 S-2) */
  repoDir?: string;
  /** 显式覆盖(优先级最高;扩展把用户设置里的模型名传进来) */
  overrides?: { model?: string };
  /** 环境变量注入(默认 process.env;测试与宿主隔离用) */
  env?: Record<string, string | undefined>;
}

/** 极简 .env 解析:KEY=VALUE,支持整行 # 注释、行内注释与成对引号,零依赖 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    } else {
      // 未加引号的值:行内 " #..." 视为注释剥掉(否则注释会被并进密钥导致 401)
      const hash = val.indexOf(' #');
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    if (key) out[key] = val;
  }
  return out;
}

function readEnvFile(p: string): Record<string, string> {
  try {
    if (fs.existsSync(p)) return parseEnvFile(fs.readFileSync(p, 'utf-8'));
  } catch {
    /* 不可读的 .env 忽略 */
  }
  return {};
}

/**
 * 配置解析(修复安全审计 S-2/S-3):
 *
 * 优先级(逐字段取第一个有值的来源):
 *   1. overrides(扩展设置等显式入参)
 *   2. 系统环境变量 process.env(用户主动 setx,受信)
 *   3. trustedDirs 中的 .env(宿主自己的配置,受信)
 *   4. 被分析仓库根的 .env(不可信度最低)
 *
 * 安全规则「端点与凭据同源绑定」:
 *   DEEPSEEK_BASE_URL 只允许来自 ≤ 密钥来源层级的来源。
 *   典型攻击:用户环境变量里有密钥,克隆的恶意仓库 .env 写 BASE_URL=攻击者域名——
 *   此时密钥来自第 2 层,仓库的 BASE_URL(第 4 层)被忽略,密钥不会被发往仓库指定的端点。
 *   仓库 .env 只有在它自己提供密钥(完整凭据对)时,其 BASE_URL 才生效。
 *   BASE_URL 必须 HTTPS(localhost 例外,便于本地网关调试)。
 */
export function loadConfig(opts: LoadConfigOptions = {}): AppConfig {
  const env = opts.env ?? process.env;
  interface Source {
    name: string;
    rank: number; // 越小越受信
    vars: Record<string, string>;
  }
  const sources: Source[] = [
    { name: '系统环境变量', rank: 1, vars: {
      DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY ?? '',
      DEEPSEEK_BASE_URL: env.DEEPSEEK_BASE_URL ?? '',
      DEEPSEEK_MODEL: env.DEEPSEEK_MODEL ?? '',
      DEEPSEEK_TIMEOUT_MS: env.DEEPSEEK_TIMEOUT_MS ?? '',
    } },
  ];
  for (const dir of opts.trustedDirs ?? []) {
    const vars = readEnvFile(path.join(dir, '.env'));
    if (Object.keys(vars).length) sources.push({ name: `${path.join(dir, '.env')}`, rank: 2, vars });
  }
  if (opts.repoDir) {
    const vars = readEnvFile(path.join(opts.repoDir, '.env'));
    if (Object.keys(vars).length) sources.push({ name: `${path.join(opts.repoDir, '.env')}(被分析仓库)`, rank: 3, vars });
  }
  const overrides = opts.overrides ?? {};

  const first = (key: string): { val: string; src: Source | null } => {
    if (overrides.model && key === 'DEEPSEEK_MODEL') {
      return { val: overrides.model, src: { name: '扩展设置', rank: 0, vars: {} } };
    }
    for (const s of sources) {
      const v = s.vars[key];
      if (v) return { val: v, src: s };
    }
    return { val: '', src: null };
  };

  const keyHit = first('DEEPSEEK_API_KEY');
  const apiKey = keyHit.val;
  if (!apiKey) {
    throw new Error(
      '未找到 DEEPSEEK_API_KEY。配置方式(任选其一):\n' +
        '  1) 当前工作区根目录建 .env:DEEPSEEK_API_KEY=sk-...\n' +
        '  2) 系统环境变量 setx DEEPSEEK_API_KEY sk-...\n' +
        '注意:出于安全,被分析仓库 .env 里的 BASE_URL 不会在密钥来自其他来源时生效。'
    );
  }

  // 端点与凭据同源绑定:只接受 rank ≤ 密钥来源 的 BASE_URL
  let baseUrl = 'https://api.deepseek.com';
  let baseUrlSrc = '默认(https://api.deepseek.com)';
  for (const s of sources) {
    if (s.rank > (keyHit.src?.rank ?? 0)) break; // 来源层级低于密钥 → 不信任其端点
    const v = s.vars.DEEPSEEK_BASE_URL;
    if (v) {
      baseUrl = v.replace(/\/+$/, '');
      baseUrlSrc = s.name;
      break;
    }
  }
  if (/^http:\/\//i.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(baseUrl)) {
    throw new Error(
      `DEEPSEEK_BASE_URL 必须使用 HTTPS(当前 ${baseUrl})。密钥与源码会发往该地址,明文 HTTP 已被拒绝;本地调试网关请用 http://localhost`
    );
  }

  const modelHit = first('DEEPSEEK_MODEL');
  const timeoutRaw = first('DEEPSEEK_TIMEOUT_MS').val;
  let timeoutMs: number | undefined;
  if (timeoutRaw) {
    const n = Number(timeoutRaw);
    // 必须为有限整数并限制在 [10s, 10min],防 Infinity/0 等配置打穿 AbortSignal
    timeoutMs = Number.isFinite(n) ? Math.min(600_000, Math.max(10_000, Math.round(n))) : undefined;
  }

  return Object.freeze({
    apiKey,
    baseUrl,
    model: modelHit.val || 'deepseek-chat',
    timeoutMs,
    sources: {
      apiKey: keyHit.src?.name ?? '(未知)',
      baseUrl: baseUrlSrc,
      model: modelHit.src?.name ?? '默认(deepseek-chat)',
    },
  });
}

/** 工具根(本库被编译后 dist/core → 上溯两级到项目根,兼容 CLI 在任意目录运行) */
export function toolRootDir(): string {
  return path.resolve(__dirname, '..', '..');
}
