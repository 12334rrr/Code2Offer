import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * 阶段 0:确定性仓库画像(无 LLM)。
 * 这是"比直接丢给大模型更精准"的第一保障:先把事实算清楚,
 * LLM 读的是全覆盖预消化事实,而不是靠搜索碰运气的采样。
 *
 * 安全与正确性约束(审计修复):
 * - 敏感文件拒绝清单独立于 .gitignore 生效:.env/私钥/凭据类文件绝不进入画像与精读
 * - .gitignore 按层叠规则解析:根目录与子目录、前导 /、**、?、字符组、取反
 * - 每个文件只完整读一次,全部统计复用同一次读取(此前最多重复读 5 遍)
 */

export interface InterestingFile {
  file: string;
  score: number;
  reasons: string[];
}

export interface RepoFacts {
  root: string;
  generatedAt: string;
  files: string[];
  overview: {
    totalFiles: number;
    totalLOC: number;
    languages: Record<string, { files: number; loc: number }>;
    manifests: Array<Record<string, unknown>>;
    entryPoints: string[];
  };
  routes: Array<{ file: string; method: string; route: string }>;
  dbTables: Array<{ file: string; table: string }>;
  configFiles: string[];
  hotspots: Array<{ file: string; commits: number }>;
  interestingFiles: InterestingFile[];
  /** 测试证据(静态统计,不执行仓库代码):文件/用例/断言计数,供叙述材料引用 */
  testEvidence: { files: string[]; testCount: number; assertCount: number };
  tree: string;
  readingPlan: string[];
  notes: string[];
  /** 因敏感规则被跳过的文件(透明化,便于用户核对没有误伤) */
  skippedSensitive: string[];
}

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'nuxt', '.nuxt',
  '__pycache__', '.venv', 'venv', 'env', 'target', 'vendor', 'coverage',
  '.idea', '.vscode', '.gradle', 'bin', 'obj', '.cache', 'bower_components',
  'interview-output', '.interview-cache',
]);

const SOURCE_EXTS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.go', '.java', '.kt',
  '.kts', '.rs', '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php', '.swift',
  '.m', '.scala', '.vue', '.svelte', '.sql', '.sh',
]);

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.pdf', '.zip',
  '.gz', '.tar', '.rar', '.7z', '.jar', '.class', '.so', '.dylib', '.dll',
  '.exe', '.bin', '.woff', '.woff2', '.ttf', '.eot', '.otf', '.mp3', '.mp4',
  '.mov', '.avi', '.sqlite', '.db', '.pyc', '.o', '.a',
]);

const MAX_FILE_BYTES = 300_000;

/**
 * 敏感文件拒绝清单(独立于 .gitignore:.gitignore 只是"不进版本库",
 * 这里是"绝不进入模型输入",用户没写 .gitignore 也同样生效)。
 */
const SENSITIVE_FILE_RE = [
  /(^|\/)\.env(\.[\w.-]+)?$/i, // .env / .env.local / .env.production
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)id_(rsa|dsa|ed25519|ecdsa)(\.\w+)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)(credentials?|secrets?)(\.[\w.-]+)?$/i,
  /(^|\/)(service[-_]?account[\w.-]*|.*\.serviceaccount)\.json$/i,
  /(^|\/)\.aws\/|^\.ssh\//i,
  /(^|\/)(dump|backup)\.sql$/i,
];

/** 内容级密钥特征(命中即跳过该文件,防"改名的密钥文件") */
const SECRET_CONTENT_RE =
  /(BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|xox[bp]-[A-Za-z0-9-]{10,})/;

const SECRET_SCAN_MAX_BYTES = 100_000;

/* ---------------- .gitignore(层叠规则,修复 C-B/M12) ---------------- */

export interface IgnoreRule {
  re: RegExp;
  neg: boolean;
  /** 规则所在目录(相对 root,'' 为根);只对其子路径生效 */
  base: string;
}

/** 单段(不含 /)→ 正则;支持 * ? ** 与字符组 [a-z] [!a-z] */
function segToRegex(seg: string): string {
  let out = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') {
      if (seg[i + 1] === '*') {
        out += '.*'; // 段内 **(罕见)按任意处理
        i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '[') {
      const end = seg.indexOf(']', i + 1);
      if (end > i + 1) {
        let cls = seg.slice(i + 1, end);
        if (cls.startsWith('!')) cls = `^${cls.slice(1)}`; // gitignore 的 ! 在类内是取反
        out += `[${cls.replace(/\\/g, '\\\\')}]`;
        i = end;
      } else {
        out += '\\['; // 未闭合的字面 [
      }
    } else {
      out += c.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }
  return out;
}

/** 一条 .gitignore 模式 → 匹配 relPath 的正则(不含锚点);导出供测试直接验证规则语义 */
export function compileGitignorePattern(pattern: string): { re: RegExp; neg: boolean } | null {
  let pat = pattern;
  const neg = pat.startsWith('!');
  if (neg) pat = pat.slice(1);
  if (!pat || pat === '/' || pat.startsWith('#')) return null;
  const anchored = pat.startsWith('/');
  if (anchored) pat = pat.slice(1);
  const dirOnly = pat.endsWith('/');
  if (dirOnly) pat = pat.slice(0, -1);
  if (!pat) return null;
  const segSrc = pat.split('/').map(segToRegex).join('/');
  // 未锚定:任意深度子路径命中即生效;目录规则匹配其全部内容
  let src = anchored ? `^${segSrc}` : `^(?:.*/)?${segSrc}`;
  src += '(?:/.*)?$';
  try {
    return { re: new RegExp(src), neg };
  } catch {
    return null;
  }
}

/** 读取一个目录下的 .gitignore 规则(挂在指定 base 下) */
function readGitignore(dirAbs: string, base: string, notes: string[]): IgnoreRule[] {
  const p = path.join(dirAbs, '.gitignore');
  let text = '';
  try {
    text = fs.readFileSync(p, 'utf-8');
  } catch {
    return [];
  }
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const compiled = compileGitignorePattern(line);
    if (compiled) rules.push({ ...compiled, base });
    else notes.push(`无法解析 .gitignore 规则(${base || '.'}):${line}`);
  }
  return rules;
}

/** 层叠匹配:规则只作用于其 base 之下;内层规则(排序后在前)逐条覆盖,同 git 语义 */
export function isIgnoredPath(relPath: string, rules: IgnoreRule[]): boolean {
  let ignored = false;
  for (const r of rules) {
    if (r.base) {
      if (!relPath.startsWith(`${r.base}/`)) continue; // 规则不作用于其目录之外
      if (!r.re.test(relPath.slice(r.base.length + 1))) continue;
    } else {
      if (!r.re.test(relPath)) continue;
    }
    ignored = !r.neg;
  }
  return ignored;
}

/** 收集 root 下所有 .gitignore(只进入未被忽略的目录),内层规则排前面 */
function buildIgnoreRules(root: string, notes: string[]): { rules: IgnoreRule[] } {
  const all: IgnoreRule[] = [];
  const stack: Array<{ abs: string; base: string }> = [{ abs: root, base: '' }];
  while (stack.length) {
    const { abs, base } = stack.pop()!;
    const rules = readGitignore(abs, base, notes);
    all.push(...rules);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (IGNORE_DIRS.has(e.name)) continue;
      const rel = base ? `${base}/${e.name}` : e.name;
      // 被忽略的目录不再下钻(其内部 .gitignore 也不该生效)
      if (isIgnoredPath(rel, all)) continue;
      stack.push({ abs: path.join(abs, e.name), base: rel });
    }
  }
  // base 越深越优先:内层 .gitignore 覆盖外层
  const depth = (b: string) => (b ? b.split('/').length : 0);
  return { rules: [...all].sort((a, b) => depth(b.base) - depth(a.base)) };
}

/* ---------------- 行计数(与引用校验同一坐标系) ---------------- */

/** split 后去掉"文件以换行结尾"产生的末尾空元素:行数与编辑器一致;空文件为 0 行 */
export function splitFileLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function countLOC(content: string): number {
  return splitFileLines(content).length;
}

/* ---------------- 敏感文件判定 ---------------- */

function isSensitiveFile(relPath: string): boolean {
  return SENSITIVE_FILE_RE.some((re) => re.test(relPath));
}

/* ---------------- walk:单遍收集 + 顺带读内容 ---------------- */

interface WalkResult {
  files: string[];
  /** rel → 文件内容(供各检测器复用;超大/可疑文件不存) */
  contents: Map<string, string>;
  skippedSensitive: string[];
  notes: string[];
}

function walkAndRead(root: string, notes: string[]): WalkResult {
  const files: string[] = [];
  const contents = new Map<string, string>();
  const skippedSensitive: string[] = [];
  const { rules } = buildIgnoreRules(root, notes);
  const stack: Array<{ abs: string; base: string }> = [{ abs: root, base: '' }];

  while (stack.length) {
    const { abs, base } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const absChild = path.join(abs, e.name);
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        if (isIgnoredPath(rel, rules)) continue;
        stack.push({ abs: absChild, base: rel });
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (BINARY_EXTS.has(ext)) continue;
        if (isIgnoredPath(rel, rules)) continue;
        // 敏感拒绝清单:独立生效,不吃 gitignore 的亏
        if (isSensitiveFile(rel)) {
          skippedSensitive.push(rel);
          continue;
        }
        let size = 0;
        try {
          size = fs.statSync(absChild).size;
        } catch {
          continue;
        }
        if (size > MAX_FILE_BYTES) {
          notes.push(`${rel} 超过 ${MAX_FILE_BYTES} 字节,跳过内容分析`);
          continue;
        }
        files.push(rel);
        try {
          const content = fs.readFileSync(absChild, 'utf-8');
          if (content.length <= SECRET_SCAN_MAX_BYTES && SECRET_CONTENT_RE.test(content)) {
            skippedSensitive.push(rel);
            files.pop();
            continue;
          }
          contents.set(rel, content);
        } catch {
          contents.set(rel, '');
        }
      }
    }
  }
  return { files: files.sort(), contents, skippedSensitive, notes };
}

/* ---------------- 各语言 manifest 解析(best-effort) ---------------- */

function parseManifests(root: string, files: string[], contents: Map<string, string>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const read = (rel: string): string => contents.get(rel) ?? '';
  for (const f of files) {
    const base = path.basename(f).toLowerCase();
    if (base === 'package.json') {
      try {
        const j = JSON.parse(read(f)) as Record<string, any>;
        out.push({
          file: f,
          kind: 'node',
          name: j.name,
          version: j.version,
          scripts: j.scripts,
          dependencies: Object.keys(j.dependencies ?? {}),
          devDependencies: Object.keys(j.devDependencies ?? {}),
        });
      } catch {
        /* 坏 JSON 跳过 */
      }
    } else if (base === 'requirements.txt') {
      const deps = read(f).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      if (deps.length) out.push({ file: f, kind: 'python', dependencies: deps });
    } else if (base === 'pyproject.toml') {
      const deps = [...read(f).matchAll(/^\s*([a-zA-Z0-9_-]+)\s*=/gm)].map((m) => m[1]).slice(0, 60);
      out.push({ file: f, kind: 'python', dependencies: deps });
    } else if (base === 'go.mod') {
      const deps = [...read(f).matchAll(/^\s+([^\s]+)\s+v/gm)].map((m) => m[1]);
      out.push({ file: f, kind: 'go', dependencies: deps });
    } else if (base === 'pom.xml') {
      const arts = [...read(f).matchAll(/<artifactId>([^<]+)<\/artifactId>/g)].map((m) => m[1]);
      out.push({ file: f, kind: 'java-maven', dependencies: [...new Set(arts)].slice(0, 60) });
    } else if (base === 'cargo.toml') {
      const sec = read(f).split('[dependencies]')[1]?.split('[')[0] ?? '';
      const deps = [...sec.matchAll(/^\s*([a-zA-Z0-9_-]+)\s*=/gm)].map((m) => m[1]);
      out.push({ file: f, kind: 'rust', dependencies: deps });
    }
  }
  return out;
}

/* ---------------- 入口 / 路由 / DB / 配置 ---------------- */

function detectEntryPoints(files: string[], contents: Map<string, string>): string[] {
  const found = new Set<string>();
  for (const m of files) {
    if (path.basename(m).toLowerCase() !== 'package.json') continue;
    try {
      const j = JSON.parse(contents.get(m) ?? '');
      // 入口按 manifest 所在目录解析(子包 main:lib/entry.js 不再丢)
      const dir = path.posix.dirname(m);
      const resolveEntry = (p: unknown) => {
        if (typeof p !== 'string' || !p) return;
        const full = dir === '.' ? p.replace(/^\.\//, '') : `${dir}/${p.replace(/^\.\//, '')}`;
        found.add(full);
      };
      resolveEntry(j.main);
      if (typeof j.bin === 'string') resolveEntry(j.bin);
      const start = j.scripts?.start;
      if (typeof start === 'string') {
        const m2 = start.match(/([\w./-]+\.(?:js|ts|mjs))/);
        if (m2) resolveEntry(m2[1]);
      }
    } catch {
      /* 忽略 */
    }
  }
  const entryName = /^(main|index|app|server|cli|wsgi|asgi|manage|application)\.[a-zA-Z]+$/i;
  for (const f of files) {
    const base = path.basename(f);
    if (entryName.test(base) || /(^|\/)(src|app|cmd)\/main\.[a-zA-Z]+$/i.test(f)) found.add(f);
  }
  const known = new Set(files);
  return [...found].filter((f) => known.has(f.replace(/\\/g, '/'))).slice(0, 15);
}

const ROUTE_PATTERNS: Array<{ re: RegExp; methodIdx: number; pathIdx: number }> = [
  // Express / Koa:限定常见路由接收者,避免 cache.get('key') 这类误报
  { re: /\b(?:app|router|server|api|route|r|v\d+)\s*\.\s*(get|post|put|delete|patch)\(\s*['"`]([^'"`\s]+)['"`]/g, methodIdx: 1, pathIdx: 2 },
  // FastAPI / Flask(APIRouter):@app.get('/x'
  { re: /@(app|router|bp|blueprint)\.(get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]/g, methodIdx: 2, pathIdx: 3 },
  // Flask:@app.route('/x', methods=['GET']
  { re: /@(app|bp)\.route\(\s*['"]([^'"]+)['"](?:\s*,\s*methods\s*=\s*\[([^\]]*)\])?/g, methodIdx: 3, pathIdx: 2 },
  // Spring:@GetMapping("/x")
  { re: /@(Get|Post|Put|Delete|Request)Mapping\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g, methodIdx: 1, pathIdx: 2 },
  // Gin / Echo:r.GET("/x"
  { re: /\.\s*(GET|POST|PUT|DELETE|PATCH)\(\s*"([^"\s]+)"/g, methodIdx: 1, pathIdx: 2 },
];

function detectRoutes(files: string[], contents: Map<string, string>): Array<{ file: string; method: string; route: string }> {
  const out: Array<{ file: string; method: string; route: string }> = [];
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (!['.js', '.ts', '.py', '.java', '.go', '.kt'].includes(ext)) continue;
    const content = contents.get(f);
    if (!content) continue;
    for (const p of ROUTE_PATTERNS) {
      p.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = p.re.exec(content)) !== null) {
        let method = String(m[p.methodIdx] ?? '').toUpperCase();
        method = method.replace(/MAPPING|ROUTE/g, '');
        if (method === 'REQUEST' || method === '' || !method) method = m[p.methodIdx] ? 'ANY' : String(m[2] ?? 'ANY');
        if (!/^(GET|POST|PUT|DELETE|PATCH|ANY)$/.test(method)) continue;
        const line = content.slice(0, m.index).split(/\r?\n/).length;
        out.push({ file: `${f}:${line}`, method, route: m[p.pathIdx] });
        if (out.length > 200) return out;
      }
    }
  }
  return out;
}

function detectDbTables(files: string[], contents: Map<string, string>): Array<{ file: string; table: string }> {
  const out: Array<{ file: string; table: string }> = [];
  const push = (file: string, table: string) => {
    if (table && !out.some((o) => o.table === table && o.file === file)) out.push({ file, table });
  };
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (!['.sql', '.js', '.ts', '.py', '.java', '.go', '.rb', '.php'].includes(ext)) continue;
    const content = contents.get(f);
    if (!content) continue;
    for (const m of content.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([A-Za-z_]\w*)[`"']?/gi)) {
      push(f, m[1]);
    }
    for (const m of content.matchAll(/__tablename__\s*=\s*['"](\w+)['"]/g)) push(f, m[1]);
    for (const m of content.matchAll(/@(?:Entity|Table)\s*(?:\([\s\S]{0,120}?name\s*=\s*["'](\w+)["'])?/g)) {
      if (m[1]) push(f, m[1]);
    }
    if (out.length > 80) break;
  }
  return out;
}

function detectConfigFiles(files: string[], skippedSensitive: string[]): string[] {
  const pats = [
    /^dockerfile$/i, /^docker-compose[\w.-]*\.ya?ml$/i, /^makefile$/i,
    /\.ya?ml$/i, /\.toml$/i, /\.ini$/i, /\.conf$/i, /nginx/i, /^tsconfig/i,
    /^\w+\.config\.(js|ts|json|mjs|cjs)$/i,
  ];
  // .env 类已进敏感拒绝清单,绝不再当"配置文件"上报
  const sensitive = new Set(skippedSensitive);
  return files
    .filter((f) => !sensitive.has(f))
    .filter((f) => pats.some((p) => p.test(path.basename(f))))
    .slice(0, 30);
}

/* ---------------- git 热点 ---------------- */

function gitHotspots(root: string, files: string[], notes: string[]): Array<{ file: string; commits: number }> {
  try {
    // 近 800 次提交足够刻画热点;全量历史在大仓库上会同步阻塞数分钟
    const log = execFileSync(
      'git',
      ['-C', root, 'log', '-n', '800', '--name-only', '--pretty=format:'],
      {
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 20_000,
      }
    ).toString();
    const counts = new Map<string, number>();
    for (const line of log.split(/\r?\n/)) {
      const f = line.trim().split(path.sep).join('/');
      if (!f) continue;
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
    return files
      .map((f) => ({ file: f, commits: counts.get(f) ?? 0 }))
      .filter((x) => x.commits > 0)
      .sort((a, b) => b.commits - a.commits)
      .slice(0, 20);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notes.push(
      /timed? ?out/i.test(msg)
        ? 'git 历史分析超时(大仓库),已按无热点继续'
        : '非 git 仓库或 git 不可用,跳过热点分析(热点 = 改动最频繁的文件,通常是核心故事线)'
    );
    return [];
  }
}

/* ---------------- 有趣代码启发式 ---------------- */

const INTEREST_PATTERNS: Array<{ re: RegExp; reason: string; weight: number }> = [
  { re: /Promise\.all|asyncio\.gather|CompletableFuture|WaitGroup|go func|threading|Thread\(|worker_threads|new\s+Thread|线程池/i, reason: '并发处理', weight: 3 },
  { re: /mutex|Mutex|\.lock\(|synchronized|RLock|Semaphore|acquire\(|release\(/i, reason: '锁与同步', weight: 3 },
  { re: /\bcache|Cache|LRU|lru|memoize|redis|Redis/i, reason: '缓存设计', weight: 3 },
  { re: /retry|重试|backoff|circuit|熔断|降级|fallback|超时|timeout/i, reason: '容错设计', weight: 2 },
  { re: /Factory|Singleton|Observer|Strategy|Adapter|Decorator|Proxy|Middleware|Repository|中间件|工厂|单例|观察者|策略模式/i, reason: '设计模式痕迹', weight: 2 },
  { re: /validate|校验|sanitize|escape|鉴权|auth|jwt|JWT|token|permission|RBAC/i, reason: '校验与安全', weight: 2 },
  { re: /queue|Queue|队列|kafka|rabbit|mq\b|pubsub|publish|subscribe/i, reason: '消息与队列', weight: 3 },
  { re: /batch|批量|分页|pagination|offset|limit|索引|optimize|优化/i, reason: '性能相关', weight: 2 },
  { re: /new RegExp|re\.compile|pattern/i, reason: '正则逻辑', weight: 1 },
  { re: /transaction|事务|rollback|原子|atomic|一致性/i, reason: '事务与一致性', weight: 3 },
];

function findInteresting(files: string[], contents: Map<string, string>, notes: string[]): InterestingFile[] {
  const out: InterestingFile[] = [];
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (!SOURCE_EXTS.has(ext) || ext === '.sql') continue;
    const content = contents.get(f);
    if (!content) continue;
    const reasons: string[] = [];
    let score = 0;
    for (const p of INTEREST_PATTERNS) {
      if (p.re.test(content)) {
        reasons.push(p.reason);
        score += p.weight;
      }
    }
    const loc = countLOC(content);
    if (loc > 250) {
      reasons.push(`大文件(${loc} 行,职责可能过重)`);
      score += 2;
    }
    // 高频复用:函数声明在本文件且被多处调用(此前误标为"递归",名实不符)
    const decls = content.match(/\b(?:function|def|func|fn)\s+([a-zA-Z_]\w{2,})/g);
    if (decls) {
      for (const d of new Set(decls)) {
        const name = d.split(/\s+/)[1];
        const calls = content.split(`${name}(`).length - 1;
        if (calls >= 3) {
          reasons.push(`高频复用函数(${name} 被调用 ${calls} 次)`);
          score += 2;
          break;
        }
      }
    }
    if (score > 0) out.push({ file: f, score, reasons });
  }
  if (!out.length) notes.push('未发现明显"有趣代码"特征,将按热点与大小出题');
  return out.sort((a, b) => b.score - a.score).slice(0, 25);
}

/* ---------------- 测试证据 ---------------- */

function extractTestEvidence(files: string[], contents: Map<string, string>): RepoFacts['testEvidence'] {
  const testFiles = files.filter((f) => /(test|spec)\.[jt]sx?$|(^|\/)(tests?|__tests__)\//i.test(f));
  const evidence: RepoFacts['testEvidence'] = { files: testFiles, testCount: 0, assertCount: 0 };
  for (const f of testFiles) {
    const text = contents.get(f);
    if (!text) continue;
    evidence.testCount += (text.match(/\b(test|it)\s*\(/g) ?? []).length;
    evidence.assertCount += (text.match(/\bassert(ion)?\.(?!js)\w+/g) ?? []).length;
  }
  return evidence;
}

/* ---------------- 目录树 ---------------- */

function buildTree(files: string[], maxEntries = 300): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (lines.length >= maxEntries) {
      lines.push(`...(共 ${files.length} 个文件,树已截断)`);
      break;
    }
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!seen.has(dir)) {
        seen.add(dir);
        lines.push(`${'  '.repeat(i - 1)}${parts[i - 1]}/`);
      }
    }
    lines.push(`${'  '.repeat(parts.length - 1)}${parts[parts.length - 1]}`);
  }
  return lines.join('\n');
}

/* ---------------- 精读清单:决定 LLM 看什么(精准度的关键) ---------------- */

export function selectReadingFiles(facts: RepoFacts, cap = 40): string[] {
  const score = new Map<string, number>();
  const add = (f: string, s: number) => {
    const clean = f.split(':')[0];
    score.set(clean, (score.get(clean) ?? 0) + s);
  };
  facts.hotspots.forEach((h, i) => add(h.file, Math.max(1, 30 - i)));
  facts.interestingFiles.forEach((i) => add(i.file, i.score * 4));
  facts.overview.entryPoints.forEach((f) => add(f, 25));
  facts.routes.forEach((r) => add(r.file, 8));
  facts.dbTables.forEach((t) => add(t.file, 8));
  facts.configFiles.slice(0, 5).forEach((f) => add(f, 5));
  // 大文件补位(可能藏着主逻辑)
  for (const f of facts.files) {
    if (!SOURCE_EXTS.has(path.extname(f).toLowerCase())) continue;
    add(f, 1);
  }
  const known = new Set(facts.files);
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([f]) => f)
    .filter((f) => known.has(f))
    .slice(0, cap);
}

/* ---------------- 主入口 ---------------- */

export function profileRepo(root: string, maxFiles = 40): RepoFacts {
  const notes: string[] = [];
  const { files, contents, skippedSensitive } = walkAndRead(root, notes);
  if (!files.length) throw new Error(`在 ${root} 未找到任何可分析文件`);
  if (skippedSensitive.length) {
    notes.push(`已按敏感文件规则跳过 ${skippedSensitive.length} 个文件(不会发给模型):${skippedSensitive.slice(0, 8).join('、')}${skippedSensitive.length > 8 ? ' …' : ''}`);
  }

  const languages: Record<string, { files: number; loc: number }> = {};
  let totalLOC = 0;
  for (const f of files) {
    const ext = path.extname(f).toLowerCase() || '(无扩展名)';
    const loc = countLOC(contents.get(f) ?? '');
    const slot = (languages[ext] ??= { files: 0, loc: 0 });
    slot.files++;
    slot.loc += loc;
    totalLOC += loc;
  }

  const facts: RepoFacts = {
    root,
    generatedAt: new Date().toISOString(),
    files,
    overview: {
      totalFiles: files.length,
      totalLOC,
      languages,
      manifests: parseManifests(root, files, contents),
      entryPoints: detectEntryPoints(files, contents),
    },
    routes: detectRoutes(files, contents),
    dbTables: detectDbTables(files, contents),
    configFiles: detectConfigFiles(files, skippedSensitive),
    hotspots: gitHotspots(root, files, notes),
    interestingFiles: findInteresting(files, contents, notes),
    testEvidence: extractTestEvidence(files, contents),
    tree: buildTree(files),
    readingPlan: [],
    notes,
    skippedSensitive,
  };
  facts.readingPlan = selectReadingFiles(facts, maxFiles);
  return facts;
}
