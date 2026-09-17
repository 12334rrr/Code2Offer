import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { isSourceLikePath, languageStatsFor, LanguageStat } from './languages';

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
    /** 归一化后的语言分布;保留 languages(扩展名分布) 兼容旧缓存与调用方。 */
    languageNames?: Record<string, LanguageStat>;
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
  /** 所有未进入画像/精读的路径按原因计数,避免"跳过"不可解释。 */
  skippedByReason: Record<string, number>;
  /** 只由路径、大小、mtime 组成的便宜仓库快照,不含文件内容。 */
  snapshotHash?: string;
}

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'nuxt', '.nuxt',
  '__pycache__', '.venv', 'venv', 'env', 'target', 'vendor', 'coverage',
  '.idea', '.vscode', '.gradle', 'bin', 'obj', '.cache', 'bower_components',
  'interview-output', '.interview-cache', '_build_dist', 'build_dist', '_build_tmp',
  '_build', '.build', '.parcel-cache', 'npmcache', 'npm-cache', '.npm', '.pnpm-store',
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
  /(BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY|sk-[A-Za-z0-9][A-Za-z0-9_-]{19,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|xox[bp]-[A-Za-z0-9-]{10,})/;

const SECRET_SCAN_MAX_BYTES = 64 * 1024;

/** 内容级扫描对外暴露给 chunk 阶段复检；只返回布尔值，不泄露命中原文。 */
export function containsHighRiskSecret(content: string): boolean {
  return SECRET_CONTENT_RE.test(content);
}

function scanFileForSecrets(absPath: string, size: number): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(absPath, 'r');
    const buffer = Buffer.allocUnsafe(SECRET_SCAN_MAX_BYTES);
    let position = 0;
    let carry = '';
    while (position < size) {
      const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
      if (!read) break;
      const text = carry + buffer.subarray(0, read).toString('utf8');
      if (containsHighRiskSecret(text)) return true;
      // All current high-risk tokens are far shorter than this overlap; this also
      // catches a token split across two UTF-8 read boundaries.
      carry = text.slice(-512);
      position += read;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function incReason(reasons: Record<string, number>, reason: string): void {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

function isIgnoredDirName(name: string): boolean {
  const lower = name.toLowerCase();
  return [...IGNORE_DIRS].some((x) => x.toLowerCase() === lower) ||
    /^(?:edge|chrome|chromium|browser)_profile\d*$/i.test(name) ||
    /^(?:bak|backup)(?:[_-].*|\d+)?$/i.test(name);
}

function isBrowserProfilePath(rel: string): boolean {
  return rel.split('/').some((part) => /^(?:edge|chrome|chromium|browser)_profile\d*$/i.test(part));
}

function isBackupOrTempFile(rel: string): boolean {
  const name = path.basename(rel);
  return /(?:\.bak(?:[_-].*)?|\.old|\.orig|\.tmp|\.temp|~)$/i.test(name) || name === '.DS_Store';
}

function isCompressedBundle(rel: string, size: number): boolean {
  return size >= 32_000 && /(?:\.min|\.bundle|\.chunk)[.-]?(?:js|mjs|cjs|css)$/i.test(rel);
}

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
      if (isIgnoredDirName(e.name)) continue;
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
  skippedByReason: Record<string, number>;
  notes: string[];
}

export interface RepoSnapshot {
  hash: string;
  entries: number;
}

/**
 * 便宜的门控快照：只遍历目录并读取 stat，不读取文件内容。
 * 它覆盖新增、删除、重命名以及等长修改(大小/mtime)，并且不会把敏感内容写入状态文件。
 */
export function snapshotRepo(root: string): RepoSnapshot {
  const notes: string[] = [];
  const { rules } = buildIgnoreRules(root, notes);
  const entries: string[] = [];
  const stack: Array<{ abs: string; base: string }> = [{ abs: root, base: '' }];
  while (stack.length) {
    const { abs, base } = stack.pop()!;
    let dirents: fs.Dirent[];
    try { dirents = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const entry of dirents) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (isIgnoredDirName(entry.name) || isIgnoredPath(rel, rules)) continue;
        stack.push({ abs: path.join(abs, entry.name), base: rel });
        entries.push(`${rel}/`);
      } else if (entry.isFile()) {
        if (isIgnoredPath(rel, rules)) continue;
        try {
          const st = fs.statSync(path.join(abs, entry.name));
          entries.push(`${rel}|${st.size}|${Math.trunc(st.mtimeMs)}`);
        } catch {
          entries.push(`${rel}|ERR`);
        }
      }
    }
  }
  entries.sort();
  return { hash: crypto.createHash('sha1').update(entries.join('\n')).digest('hex'), entries: entries.length };
}

function walkAndRead(root: string, notes: string[]): WalkResult {
  const files: string[] = [];
  const contents = new Map<string, string>();
  const skippedSensitive: string[] = [];
  const skippedByReason: Record<string, number> = {};
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
        if (isIgnoredDirName(e.name)) {
          incReason(skippedByReason, isBrowserProfilePath(rel) || /profile/i.test(e.name) ? '浏览器用户目录/缓存' : '构建产物或工具缓存');
          continue;
        }
        if (isIgnoredPath(rel, rules)) continue;
        stack.push({ abs: absChild, base: rel });
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (BINARY_EXTS.has(ext)) { incReason(skippedByReason, '二进制文件'); continue; }
        if (isIgnoredPath(rel, rules)) { incReason(skippedByReason, 'gitignore'); continue; }
        if (isBrowserProfilePath(rel)) { incReason(skippedByReason, '浏览器用户目录/缓存'); continue; }
        if (isBackupOrTempFile(rel)) { incReason(skippedByReason, '备份/临时产物'); continue; }
        // 敏感拒绝清单:独立生效,不吃 gitignore 的亏
        if (isSensitiveFile(rel)) {
          skippedSensitive.push(rel);
          incReason(skippedByReason, '敏感路径');
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
          incReason(skippedByReason, '超过大小上限');
          continue;
        }
        if (isCompressedBundle(rel, size)) { incReason(skippedByReason, '压缩/第三方 bundle'); continue; }
        try {
          // 100–300KB 文件也要完整扫描；分段检测后才允许把内容放入模型候选集合。
          if (scanFileForSecrets(absChild, size)) {
            skippedSensitive.push(rel);
            incReason(skippedByReason, '内容命中密钥特征');
            continue;
          }
          files.push(rel);
          const content = fs.readFileSync(absChild, 'utf-8');
          contents.set(rel, content);
        } catch {
          contents.set(rel, '');
        }
      }
    }
  }
  return { files: files.sort(), contents, skippedSensitive, skippedByReason, notes };
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
    } else if (base === 'composer.json') {
      try {
        const j = JSON.parse(read(f)) as Record<string, any>;
        out.push({
          file: f,
          kind: 'php-composer',
          name: j.name,
          dependencies: Object.keys(j.require ?? {}),
          devDependencies: Object.keys(j['require-dev'] ?? {}),
        });
      } catch {
        /* 坏 JSON 跳过 */
      }
    } else if (base === 'pubspec.yaml') {
      const deps = [...read(f).matchAll(/^\s{2}([a-zA-Z0-9_-]+):/gm)].map((m) => m[1]);
      out.push({ file: f, kind: 'dart', dependencies: [...new Set(deps)].slice(0, 80) });
    } else if (base === 'gemfile') {
      const deps = [...read(f).matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
      out.push({ file: f, kind: 'ruby-bundler', dependencies: deps });
    } else if (base === 'mix.exs') {
      const deps = [...read(f).matchAll(/\{\s*:([a-zA-Z0-9_]+)\s*,/g)].map((m) => m[1]);
      out.push({ file: f, kind: 'elixir-mix', dependencies: [...new Set(deps)] });
    } else if (base === 'build.gradle' || base === 'build.gradle.kts') {
      const deps = [...read(f).matchAll(/\b(?:implementation|api|compileOnly|testImplementation)\s*[( ]\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
      out.push({ file: f, kind: 'gradle', dependencies: [...new Set(deps)].slice(0, 80) });
    } else if (base === 'package.swift') {
      const deps = [...read(f).matchAll(/\.package\s*\(\s*url:\s*["']([^"']+)["']/g)].map((m) => m[1]);
      out.push({ file: f, kind: 'swift-spm', dependencies: deps });
    } else if (/\.(?:csproj|fsproj|vbproj)$/i.test(base)) {
      const deps = [...read(f).matchAll(/<PackageReference\s+Include="([^"]+)"/gi)].map((m) => m[1]);
      out.push({ file: f, kind: 'dotnet', dependencies: deps });
    } else if (base === 'project.clj' || base === 'deps.edn') {
      out.push({ file: f, kind: 'clojure', dependencies: [...read(f).matchAll(/([a-zA-Z0-9_.-]+)\s*\{/g)].map((m) => m[1]).slice(0, 80) });
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
        const m2 = start.match(/([\w./-]+\.(?:js|ts|mjs|cjs|jsx|tsx|py|go|rs|java|kt|dart|rb|php|swift|cs|fs|ex|exs))/i);
        if (m2) resolveEntry(m2[1]);
      }
    } catch {
      /* 忽略 */
    }
  }
  const entryName = /^(main|index|app|server|cli|wsgi|asgi|manage|application|program|lib|router)\.[a-zA-Z]+$/i;
  for (const f of files) {
    const base = path.basename(f);
    if (
      entryName.test(base) ||
      /(^|\/)(src|app|cmd)(?:\/[^/]+)?\/main\.[a-zA-Z]+$/i.test(f) ||
      /(^|\/)(bin|scripts)\/(?:[\w.-]+)\.[a-zA-Z]+$/i.test(f)
    ) found.add(f);
  }
  const known = new Set(files);
  return [...found].filter((f) => known.has(f.replace(/\\/g, '/'))).slice(0, 15);
}

const ROUTE_PATTERNS: Array<{ re: RegExp; methodIdx?: number; pathIdx: number; extensions?: readonly string[] }> = [
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
  // NestJS:@Get('/x') / Fastify decorators
  { re: /@(Get|Post|Put|Delete|Patch)\(\s*['"]([^'"]+)['"]/g, methodIdx: 1, pathIdx: 2, extensions: ['.js', '.jsx', '.ts', '.tsx'] },
  // Laravel:Route::get('/x', ...)
  { re: /\bRoute::(get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]/gi, methodIdx: 1, pathIdx: 2, extensions: ['.php'] },
  // Rails / Phoenix: get "/x", ...
  { re: /\b(get|post|put|delete|patch)\s+['"]([^'"]+)['"]/gi, methodIdx: 1, pathIdx: 2, extensions: ['.rb', '.ex', '.exs'] },
  // Django:path('/x', view) / re_path(r'/x', view)
  { re: /\b(?:path|re_path)\(\s*[rR]?['"]([^'"]+)['"]/g, pathIdx: 1, extensions: ['.py'] },
  // ASP.NET:[HttpGet("/x")]
  { re: /\[(HttpGet|HttpPost|HttpPut|HttpDelete|HttpPatch)(?:\(\s*["']([^"']+)["']\s*\))?\]/gi, methodIdx: 1, pathIdx: 2, extensions: ['.cs'] },
  // Actix / Rocket:#[get("/x")]
  { re: /#\[(get|post|put|delete|patch)\(\s*["']([^"']+)["']/gi, methodIdx: 1, pathIdx: 2, extensions: ['.rs'] },
  // Phoenix router:get "/x" without a controller call is covered above; this
  // pattern also captures framework-neutral router.route('/x') declarations.
  { re: /\b(?:app|router|route)\.route\(\s*['"]([^'"]+)['"]/g, pathIdx: 1 },
];

function detectRoutes(files: string[], contents: Map<string, string>): Array<{ file: string; method: string; route: string }> {
  const out: Array<{ file: string; method: string; route: string }> = [];
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (!['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.java', '.go', '.kt', '.kts', '.cs', '.rs', '.rb', '.php', '.ex', '.exs'].includes(ext)) continue;
    const content = contents.get(f);
    if (!content) continue;
    for (const p of ROUTE_PATTERNS) {
      if (p.extensions && !p.extensions.includes(ext)) continue;
      p.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = p.re.exec(content)) !== null) {
        let method = p.methodIdx === undefined ? 'ANY' : String(m[p.methodIdx] ?? '').toUpperCase();
        const explicitMethod = method.match(/\b(GET|POST|PUT|DELETE|PATCH|ANY)\b/)?.[1];
        method = explicitMethod ?? method.replace(/MAPPING|ROUTE/g, '');
        if (method === 'REQUEST' || method === '' || !method) method = 'ANY';
        if (!/^(GET|POST|PUT|DELETE|PATCH|ANY)$/.test(method)) continue;
        const line = content.slice(0, m.index).split(/\r?\n/).length;
        out.push({ file: `${f}:${line}`, method, route: String(m[p.pathIdx] ?? '/') });
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
    if (!['.sql', '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.go', '.rb', '.php', '.kt', '.kts', '.cs', '.rs', '.swift', '.dart', '.scala', '.ex', '.exs', '.prisma', '.sol'].includes(ext)) continue;
    const content = contents.get(f);
    if (!content) continue;
    for (const m of content.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([A-Za-z_]\w*)[`"']?/gi)) {
      push(f, m[1]);
    }
    for (const m of content.matchAll(/__tablename__\s*=\s*['"](\w+)['"]/g)) push(f, m[1]);
    for (const m of content.matchAll(/@(?:Entity|Table)\s*(?:\(\s*(?:name\s*=\s*)?["']?([A-Za-z_]\w*)["']?)/g)) {
      if (m[1]) push(f, m[1]);
    }
    for (const m of content.matchAll(/\bdb_table\s*=\s*["']([A-Za-z_]\w*)["']/g)) push(f, m[1]);
    for (const m of content.matchAll(/\b(?:schema|from)\s*["']([A-Za-z_]\w*)["']/g)) {
      if (ext === '.ex' || ext === '.exs') push(f, m[1]);
    }
    for (const m of content.matchAll(/\b(?:protected\s+)?\$table\s*=\s*["']([A-Za-z_]\w*)["']/g)) push(f, m[1]);
    for (const m of content.matchAll(/^\s*model\s+([A-Za-z_]\w*)\s*\{/gm)) {
      if (ext === '.prisma') push(f, m[1]);
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
    if (!isSourceLikePath(f) || ext === '.sql') continue;
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

/** 依赖锁文件:提交次数再多也不值得精读/出题(0.8.2:自跑日志中 package-lock 曾靠 git 热点混进精读清单) */
const LOCKFILE_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-lock\.lock|bun\.lockb|composer\.lock|Gemfile\.lock|poetry\.lock|Cargo\.lock|package-lock\.jsonc)$/;

export function selectReadingFiles(facts: RepoFacts, cap = 40): string[] {
  const score = new Map<string, number>();
  const add = (f: string, s: number) => {
    const clean = f.split(':')[0];
    if (LOCKFILE_RE.test(clean)) return; // 锁文件不参与评分
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
    if (!isSourceLikePath(f)) continue;
    add(f, 1);
  }
  const known = new Set(facts.files);
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([f]) => f)
    .filter((f) => known.has(f) && !LOCKFILE_RE.test(f))
    .slice(0, cap);
}

/* ---------------- 主入口 ---------------- */

export function profileRepo(root: string, maxFiles = 40): RepoFacts {
  const notes: string[] = [];
  const walked = walkAndRead(root, notes);
  if (!walked.files.length) throw new Error(`在 ${root} 未找到任何可分析文件`);
  if (walked.skippedSensitive.length) {
    notes.push(`已按敏感文件规则跳过 ${walked.skippedSensitive.length} 个文件(不会发给模型):${walked.skippedSensitive.slice(0, 8).join('、')}${walked.skippedSensitive.length > 8 ? ' …' : ''}`);
  }

  const languages: Record<string, { files: number; loc: number }> = {};
  const languageNames = languageStatsFor(walked.files, walked.contents, countLOC);
  let totalLOC = 0;
  for (const f of walked.files) {
    const ext = path.extname(f).toLowerCase() || '(无扩展名)';
    const loc = countLOC(walked.contents.get(f) ?? '');
    const slot = (languages[ext] ??= { files: 0, loc: 0 });
    slot.files++;
    slot.loc += loc;
    totalLOC += loc;
  }

  const facts: RepoFacts = {
    root,
    generatedAt: new Date().toISOString(),
    files: walked.files,
    overview: {
      totalFiles: walked.files.length,
      totalLOC,
      languages,
      languageNames,
      manifests: parseManifests(root, walked.files, walked.contents),
      entryPoints: detectEntryPoints(walked.files, walked.contents),
    },
    routes: detectRoutes(walked.files, walked.contents),
    dbTables: detectDbTables(walked.files, walked.contents),
    configFiles: detectConfigFiles(walked.files, walked.skippedSensitive),
    hotspots: gitHotspots(root, walked.files, notes),
    interestingFiles: findInteresting(walked.files, walked.contents, notes),
    testEvidence: extractTestEvidence(walked.files, walked.contents),
    tree: buildTree(walked.files),
    readingPlan: [],
    notes,
    skippedSensitive: walked.skippedSensitive,
    skippedByReason: walked.skippedByReason,
    snapshotHash: snapshotRepo(root).hash,
  };
  facts.readingPlan = selectReadingFiles(facts, maxFiles);
  return facts;
}
