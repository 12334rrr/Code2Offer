import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { DeepSeekClient, parseJsonLoose } from '../core/deepseek';
import { RepoFacts, splitFileLines } from '../core/profiler';
import { CodeCite, Question, VerificationResult, normalizeCiteLines, parseCiteRanges, MAX_CITE_SPAN, riskWithoutFix, FIX_RE, hasPresentationIssue } from '../core/schemas';
import { STAGE3_VERIFY_SYSTEM, STAGE3_RISKFIX_SYSTEM, stage3VerifyUser } from '../core/prompts';
import { DiskCache, PROMPT_VERSION } from '../core/cache';
import { StageRunContext } from './stage1Read';
import { log, warn } from '../core/logger';

const MAX_VERIFY_BATCH = 10;
const VERIFY_BATCH_CHARS = 28_000;
const VERIFY_CONCURRENCY = 3;
const MAX_EXCERPT_LINES = 120;
const MAX_EXCERPT_CHARS = 12000;

/** 校验裁决白名单:模型返回 "Fix"/"ok"/中文等一律按未覆盖处理,不得混入 pass 统计 */
const VERDICTS = new Set(['pass', 'fix', 'flag']);

/** 确定性引用检查:文件存在 + 行号在文件范围内。返回每题的错误与摘录。(evaluate 复用)
 * 行数坐标系:splitFileLines(去掉末尾换行产生的空元素),1-based 闭区间,1 ≤ start ≤ end ≤ total。 */
export function deterministicCheck(facts: RepoFacts, questions: Question[]): {
  lineErrors: Map<string, string[]>;
  excerpts: Map<string, string>;
} {
  const lineErrors = new Map<string, string[]>();
  const excerpts = new Map<string, string>();
  const filesSet = new Set(facts.files);
  // 正确的行缓存:命中直接返回内容(此前"命中分支反而重新读盘",缓存 100% 无效,同一文件单轮读 5×N 次)
  const lineCache = new Map<string, string[] | null>();

  const readLines = (rel: string): string[] | null => {
    if (lineCache.has(rel)) return lineCache.get(rel) ?? null;
    let lines: string[] | null = null;
    try {
      lines = splitFileLines(fs.readFileSync(path.join(facts.root, rel), 'utf-8'));
    } catch {
      lines = null;
    }
    lineCache.set(rel, lines);
    return lines;
  };

  for (const q of questions) {
    const errs: string[] = [];
    for (const cite of q.代码依据) {
      if (!filesSet.has(cite.file)) {
        errs.push(`引用文件不存在:${cite.file}`);
        continue;
      }
      const lines = readLines(cite.file);
      if (!lines) {
        errs.push(`引用文件无法读取:${cite.file}`);
        continue;
      }
      const total = lines.length;
      const ranges = parseCiteRanges(cite.lines);
      if (!ranges) {
        errs.push(`行号格式非法:${cite.file}:${cite.lines}`);
        continue;
      }
      // 严格边界:start 也必须 ≤ total(此前只查 end 且放行 total+1,叠加 split 尾空行合计容忍越界 2 行)
      if (ranges.some(([start, end]) => start > total || end > total)) {
        errs.push(`行号越界:${cite.file} 共 ${total} 行,引用 ${cite.lines}`);
        continue;
      }
      // 生成摘录(供 LLM 校验用):多段引用按段拼接
      const slices = ranges.map(([start, end]) =>
        lines.slice(start - 1, Math.min(end, start - 1 + MAX_EXCERPT_LINES))
      );
      excerpts.set(
        `${q.id}|${cite.file}|${cite.lines}`,
        `--- ${cite.file} 第${cite.lines}行 ---\n${slices.join('\n---\n')}`
      );
    }
    if (errs.length) lineErrors.set(q.id, errs);
  }
  return { lineErrors, excerpts };
}

function buildVerifyItems(batch: Question[], excerpts: Map<string, string>): string {
  return batch
    .map((q) => {
      const cites = q.代码依据.map((c) => `- ${c.file}:${c.lines}`).join('\n');
      const ex = q.代码依据
        .map((c) => excerpts.get(`${q.id}|${c.file}|${c.lines}`) ?? `(未取得摘录:${c.file}:${c.lines})`)
        .join('\n\n');
      return `## 题目 ${q.id}(${q.category}|${q.difficulty})
问题:${q.question}
答案要点:
${q.答案要点.map((a, i) => `${i + 1}. ${a}`).join('\n')}
代码依据:
${cites}
${q.对比 ? `对比块:\n${JSON.stringify(q.对比, null, 1)}` : '(无对比块)'}

引用处代码原文:
${ex.slice(0, MAX_EXCERPT_CHARS)}`;
    })
    .join('\n\n================================\n\n');
}

function packVerifyBatches(questions: Question[], excerpts: Map<string, string>): Question[][] {
  const batches: Question[][] = [];
  let current: Question[] = [];
  let chars = 0;
  for (const q of questions) {
    const size = buildVerifyItems([q], excerpts).length;
    if (current.length && (chars + size > VERIFY_BATCH_CHARS || current.length >= MAX_VERIFY_BATCH)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(q);
    chars += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await fn(items[index], index);
    }
  }));
}

export interface VerifyStats {
  total: number;
  pass: number;
  fix: number;
  flag: number;
  /** 校验未覆盖(模型失败/漏答/非法裁决):不得计入 pass,阶段不得记完成 */
  unverified: number;
  deterministicIssues: number;
}

/** 每题校验输入指纹:题干+答案+引用+摘录。断点只复用指纹完全一致的结果(审计 R-2) */
function questionInputHash(q: Question, excerptText: string): string {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify([q.id, q.question, q.答案要点, q.代码依据, q.对比 ?? null, excerptText]))
    .digest('hex');
}

/**
 * 引用消毒(确定性,无 LLM):校验环写回的"修正代码依据"可能带坏行号
 * (越界如 1-20 > 文件实长、散文如 "未提供,需补充…")。
 * 规则:非法/完全越界的引用删除;部分越界把 start 与 end 一并夹到文件实长
 * (此前只截 end,越界 start 会产出 "120-100" 这类倒置区间);全部引用失效的题打 flag。
 */
export function sanitizeCitations(facts: RepoFacts, questions: Question[]): number {
  const filesSet = new Set(facts.files);
  let fixed = 0;
  for (const q of questions) {
    const kept: CodeCite[] = [];
    for (const c of q.代码依据) {
      if (!filesSet.has(c.file)) {
        warn(`  [引用消毒] ${q.id}:文件不存在,删除引用 ${c.file}`);
        fixed++;
        continue;
      }
      let total = 0;
      try {
        total = splitFileLines(fs.readFileSync(path.join(facts.root, c.file), 'utf-8')).length;
      } catch {
        warn(`  [引用消毒] ${q.id}:文件无法读取,删除引用 ${c.file}`);
        fixed++;
        continue;
      }
      const normalized = normalizeCiteLines(c.lines);
      if (normalized && normalized !== c.lines) {
        c.lines = normalized;
        fixed++;
      }
      const ranges = parseCiteRanges(c.lines);
      if (!ranges) {
        warn(`  [引用消毒] ${q.id}:行号无法解析,删除引用 ${c.file}:${c.lines.slice(0, 40)}`);
        fixed++;
        continue;
      }
      // start 已越过文件末尾 = 完全越界(整段删除;把 start"夹到末行"会凭空捏造引用);
      // 只有 end 越界才截到文件实长;跨度超过 MAX_CITE_SPAN 的段钳到该值
      // (S 级要求引用"当场能翻到":约一屏内;过宽区间按起点保留前 MAX_CITE_SPAN 行并告警)
      const clamped: Array<[number, number]> = [];
      let droppedSeg = 0;
      for (const [s, e] of ranges) {
        if (s > total) {
          droppedSeg++;
          continue;
        }
        const capped = Math.min(e, total, s + MAX_CITE_SPAN - 1);
        if (capped !== e) {
          warn(`  [引用消毒] ${q.id}:${c.file} ${s}-${e} → ${s}-${capped}(跨度超 ${MAX_CITE_SPAN} 行,按起点保留供复核)`);
          fixed++;
        }
        clamped.push([s, capped]);
      }
      if (droppedSeg) fixed++;
      if (!clamped.length) {
        warn(`  [引用消毒] ${q.id}:${c.file} ${c.lines} 完全越界(文件 ${total} 行),删除该引用`);
        continue;
      }
      const newLines = clamped.map(([s, e]) => (s === e ? String(s) : `${s}-${e}`)).join(',');
      if (newLines !== c.lines) {
        warn(`  [引用消毒] ${q.id}:${c.file} ${c.lines} → ${newLines}(截到文件实长 ${total} 行)`);
        c.lines = newLines;
        fixed++;
      }
      kept.push(c);
    }
    if (kept.length !== q.代码依据.length) {
      q.代码依据 = kept;
      if (!kept.length) {
        q.verified = 'flag';
        q.verifyNote = `${q.verifyNote ?? ''} 所有代码依据无法通过确定性检查,已删除,答案需人工核对`.trim();
      }
    }
  }
  return fixed;
}

/**
 * 引用覆盖补齐(0.8.1,确定性):答案要点/追问参考要点里写明的 file:lines 是模型自己的引用主张,
 * 但可能没进"代码依据"列表——背诵的内容明明指向某文件,依据列表却查无此事(S 级审计抓到的缺口)。
 * 规则:解析要点文本中的 文件:行号 模式(文件必须真实存在于画像清单、行号可解析、跨度 ≤MAX_CITE_SPAN),
 * 未被该题代码依据覆盖的真实引用自动补入;随后统一过 sanitizeCitations 消毒。返回补齐数。
 */
export function ensureCitationCoverage(facts: RepoFacts, questions: Question[]): number {
  const filesSet = new Set(facts.files);
  // 模型可能写全路径(src/store.js:30-60)或裸文件名(store.js:30-60):先精确,再按路径后缀归一
  const CITE_IN_TEXT =
    /\b([A-Za-z0-9_\-./\\]+\.(?:js|ts|jsx|tsx|mjs|cjs|py|go|java|kt|rb|php|cs|sql|json|yml|yaml|toml|html|css|md|vue|svelte|sh)):(\d+(?:\s*-\s*\d+)?(?:\s*,\s*\d+(?:\s*-\s*\d+)?)*)/g;
  const resolveFile = (raw: string): string | null => {
    const file = raw.replace(/^\.\//, '').replace(/\\/g, '/');
    if (filesSet.has(file)) return file;
    const suffixed = [...filesSet].find((f) => f === `src/${file}` || f.endsWith(`/${file}`));
    return suffixed ?? null;
  };
  let added = 0;
  for (const q of questions) {
    const texts = [...q.答案要点, ...q.追问链.map((f) => `${f.问题} ${f.参考要点}`)];
    const found = new Map<string, string>();
    for (const t of texts) {
      for (const m of t.matchAll(CITE_IN_TEXT)) {
        const file = resolveFile(m[1]);
        const lines = normalizeCiteLines(m[2]);
        if (!file || !lines) continue;
        if (!found.has(file)) found.set(file, lines);
      }
    }
    for (const [file, lines] of found) {
      if (q.代码依据.some((c) => c.file === file)) continue;
      q.代码依据.push({ file, lines });
      added++;
    }
  }
  if (added) log(`  [引用覆盖补齐] 按要点中的 file:lines 主张补入 ${added} 条代码依据(随后统一消毒)`);
  return added;
}

/**
 * 阶段 3.6:风险给药定向修复(0.8.1,确定性触发 + LLM 定向修补)。
 * 触发:答案要点指出风险/缺陷,却没有任何改进表述(riskWithoutFix,与 S 级审计同一把尺子)。
 * 修补:LLM 按 STAGE3_RISKFIX_SYSTEM 重写该题要点;形状校验拒绝"仍无给药/含占位语/条数越界"的结果,
 * 重试 ≤2 次,失败保留原样供人工复核。缓存键含提示词全文,改提示词自动失效。
 */
export async function repairRiskWithoutFix(
  client: DeepSeekClient,
  cache: DiskCache,
  facts: RepoFacts,
  questions: Question[],
  outDir: string,
  ctx: StageRunContext = {}
): Promise<number> {
  void outDir;
  const need = questions.filter(riskWithoutFix);
  if (!need.length) return 0;
  log(`  [风险给药] ${need.length} 题指出风险但无改进方案,定向修补:${need.map((q) => q.id).join('、')}`);
  const { excerpts } = deterministicCheck(facts, questions);
  let repaired = 0;
  for (const q of need) {
    if (ctx.signal?.aborted) throw new Error('已取消');
    const ex = (q.代码依据 || [])
      .map((c) => excerpts.get(`${q.id}|${c.file}|${c.lines}`) ?? '')
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 5000);
    const material = [
      `# 题目\n${q.question}`,
      `# 当前答案要点\n${q.答案要点.map((a, i) => `${i + 1}. ${a}`).join('\n')}`,
      `# 引用处代码原文\n${ex || '(无摘录)'}`,
    ].join('\n\n');
    const key = cache.key('risk-fix', PROMPT_VERSION, STAGE3_RISKFIX_SYSTEM, q.id, material);
    const tryApply = (text: string): boolean => {
      try {
        const parsed = parseJsonLoose<{ questions?: Array<{ id?: string; 答案要点?: unknown }> }>(text);
        const items = (parsed?.questions ?? []).filter((x) => x && Array.isArray(x.答案要点));
        // id 精确匹配优先;单题材料下模型偶把占位符抄进 id,此时唯一条目即目标题
        const item = items.find((x) => String(x.id ?? '').trim() === q.id) ?? (items.length === 1 ? items[0] : undefined);
        if (!item) return false;
        const pts = Array.isArray(item.答案要点) ? item.答案要点.map(String).map((s) => s.trim()).filter(Boolean) : [];
        if (pts.length < 3 || pts.length > 7) return false;
        if (pts.some((p) => hasPresentationIssue(p))) return false;
        if (!pts.some((p) => FIX_RE.test(p))) return false; // 修了但仍没给药 = 没修
        q.答案要点 = pts;
        return true;
      } catch {
        return false;
      }
    };
    const cached = cache.get<string>(key);
    if (typeof cached === 'string' && tryApply(cached)) {
      repaired++;
      continue;
    }
    let applied = false;
    try {
      for (let a = 0; a < 2 && !applied; a++) {
        const raw = await client.chat(
          [
            { role: 'system', content: STAGE3_RISKFIX_SYSTEM },
            { role: 'user', content: material },
          ],
          // 严格 JSON 输出路由到 chat 模型:flash 的推理预算会耗尽在结构化任务上(0.5.1 教训)
          { requestType: 'stage3-riskfix', temperature: 0.1, jsonMode: true, maxTokens: 2200, hardMaxTokens: 4500, signal: ctx.signal, mode: ctx.mode }
        );
        if (tryApply(raw)) {
          cache.set(key, raw);
          applied = true;
        }
      }
    } catch (err) {
      if (String(err instanceof Error ? err.message : err) === '已取消') throw err;
      warn(`  [风险给药] ${q.id} 修补请求失败:${err instanceof Error ? err.message : err}`);
    }
    if (applied) repaired++;
    else warn(`  [风险给药] ${q.id} 未通过形状校验(保留原样,供人工复核)`);
  }
  if (repaired) log(`  [风险给药] 修补完成 ${repaired}/${need.length} 题`);
  return repaired;
}

interface CheckpointEntry extends VerificationResult {
  /** 该结果对应的题目输入指纹:指纹不符的结果不复用 */
  inputHash?: string;
}

/** 写校验报告(独立出来:3.5 重写后 runner 会再调一次,保证报告与最终题库一致) */
export function writeVerifyReport(questions: Question[], outDir: string, stats: VerifyStats): void {
  const flagged = questions.filter((q) => q.verified === 'flag');
  const report: string[] = [
    `# 校验报告`,
    ``,
    `- 总题数:${stats.total}`,
    `- 通过(pass):${stats.pass}`,
    `- 修订(fix):${stats.fix}`,
    `- 标红(flag,存在代码无法支撑的主张):${stats.flag}`,
    `- 未覆盖(unverified,模型失败/漏答,建议重跑):${stats.unverified}`,
    `- 确定性引用问题:${stats.deterministicIssues} 题`,
    ``,
    `> flag 题目建议人工复核后再用于背诵;答案中的引用可在仓库中直接检索验证。`,
    `> unverified 题目尚未经过对抗校验,重跑 generate 会自动补验。`,
    ``,
  ];
  if (flagged.length) {
    report.push(`## 标红题目明细`, ``);
    for (const q of flagged) {
      report.push(`### ${q.id}(${q.category}|${q.difficulty})`);
      report.push(`- 问题:${q.question}`);
      report.push(`- 原因:${q.verifyNote}`);
      report.push('');
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, '校验报告.md'), report.join('\n'), 'utf-8');
}

/** 阶段 3 主入口:确定性检查 + LLM 对抗校验,原地修订题目并写校验报告 */
export async function runStage3(
  client: DeepSeekClient,
  facts: RepoFacts,
  questions: Question[],
  outDir: string,
  ctx: StageRunContext = {}
): Promise<VerifyStats> {
  log('  确定性引用检查(文件存在性/行号范围)...');
  const { lineErrors, excerpts } = deterministicCheck(facts, questions);
  for (const q of questions) {
    const errs = lineErrors.get(q.id);
    if (errs) {
      q.verifyNote = errs.join(';');
    }
  }

  // 每题输入指纹(断点只复用指纹一致且 ID 属于当前题库的结果)
  const hashOf = new Map<string, string>();
  for (const q of questions) {
    const ex = q.代码依据.map((c) => excerpts.get(`${q.id}|${c.file}|${c.lines}`) ?? '').join('\n');
    hashOf.set(q.id, questionInputHash(q, ex));
  }

  // LLM 对抗校验(逐批 checkpoint:中断后只补未验批次)
  const checkpointPath = path.join(outDir, '.verify-progress.json');
  const results = new Map<string, VerificationResult>();
  try {
    if (fs.existsSync(checkpointPath)) {
      const saved = JSON.parse(fs.readFileSync(checkpointPath, 'utf-8')) as CheckpointEntry[];
      for (const r of Array.isArray(saved) ? saved : []) {
        if (!r || typeof r.id !== 'string') continue;
        if (!VERDICTS.has(r.verdict)) continue; // 非法裁决的旧记录直接丢弃
        if (!hashOf.has(r.id)) continue; // 不属于当前题库的 ID(幻觉/旧题库)丢弃
        // Old checkpoints without an input fingerprint are not safe to reuse:
        // question IDs are stable across runs while their evidence can change.
        if ((r as CheckpointEntry).inputHash !== hashOf.get(r.id)) continue; // 题目或摘录已变化
        results.set(r.id, r);
      }
      if (results.size) log(`  [断点续验] 已有 ${results.size} 题校验结果(输入指纹一致)`);
    }
  } catch {
    /* 坏 checkpoint 视为无 */
  }
  const saveCheckpoint = () => {
    const entries: CheckpointEntry[] = [...results.entries()].map(([id, r]) => ({
      ...r,
      inputHash: hashOf.get(id),
    }));
    const tmp = `${checkpointPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(entries, null, 1), 'utf-8');
      // Windows cannot replace an existing file with renameSync. The serialized
      // writer below prevents lost updates; the temp file prevents partial JSON.
      if (fs.existsSync(checkpointPath)) fs.unlinkSync(checkpointPath);
      fs.renameSync(tmp, checkpointPath);
    } catch {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  };

  const idSet = new Set(questions.map((q) => q.id));
  const batches = packVerifyBatches(questions, excerpts);
  let checkpointWrite = Promise.resolve();
  const queueCheckpoint = async (): Promise<void> => {
    checkpointWrite = checkpointWrite.then(() => saveCheckpoint());
    await checkpointWrite;
  };
  // 批次解析失败(常见于输出被预算截断)→ 对半拆批重试(深度 ≤2),把 unverified 压到接近 0:
  // 整批放弃意味着这批题下次运行还要整批重花钱(自跑日志:批 7 失败 → 12 题 unverified)
  const runVerifyBatch = async (batch: Question[], label: string, depth: number): Promise<void> => {
    if (ctx.signal?.aborted) throw new Error('已取消');
    if (batch.every((q) => results.has(q.id))) return;
    log(`  对抗校验批次 ${label}(${batch.length} 题)...`);
    try {
      const raw = await client.chat(
        [
          { role: 'system', content: STAGE3_VERIFY_SYSTEM },
          { role: 'user', content: stage3VerifyUser(buildVerifyItems(batch, excerpts)) },
        ],
        { requestType: 'stage3-verify', temperature: 0.05, jsonMode: true, maxTokens: 6500, hardMaxTokens: 10000, signal: ctx.signal, mode: ctx.mode }
      );
      const parsed = parseJsonLoose<{ results?: VerificationResult[] }>(raw);
      const list = Array.isArray(parsed?.results) ? parsed.results : [];
      if (!list.length) throw new Error('模型输出无 results(可能被预算截断)');
      let applied = 0;
      for (const r of list) {
        if (!r || typeof r.id !== 'string' || !idSet.has(r.id) || !VERDICTS.has(r.verdict)) continue;
        results.set(r.id, r);
        applied++;
      }
      if (!applied) throw new Error('results 中无有效裁决');
      await queueCheckpoint();
    } catch (err) {
      if (String(err instanceof Error ? err.message : err) === '已取消') throw err;
      if (batch.length > 1 && depth < 2) {
        warn(`  [警告] 批次 ${label} 解析失败(${String(err instanceof Error ? err.message : err).slice(0, 80)}),对半拆批重试`);
        const mid = Math.ceil(batch.length / 2);
        await runVerifyBatch(batch.slice(0, mid), `${label}a`, depth + 1);
        await runVerifyBatch(batch.slice(mid), `${label}b`, depth + 1);
        return;
      }
      warn(`  [警告] 校验批次 ${label} 失败,对应题目将标记为未覆盖(unverified):${err instanceof Error ? err.message : err}`);
    }
  };
  await mapLimit(batches, VERIFY_CONCURRENCY, (batch, index) => runVerifyBatch(batch, String(index + 1), 0));
  await checkpointWrite;

  // 应用裁决:LLM 未覆盖 → unverified(不再默认 pass);确定性错误的题不得被模型 pass 覆盖
  let pass = 0;
  let fix = 0;
  let flag = 0;
  let unverified = 0;
  const citesBeforeFix = new Map<string, CodeCite[]>();
  for (const q of questions) {
    const r = results.get(q.id);
    if (!r) {
      unverified++;
      q.verified = 'unverified';
      q.verifyNote = 'LLM 校验未覆盖(模型失败/漏答),重跑 generate 将自动补验';
      continue;
    }
    q.verified = r.verdict;
    const notes = [r.note ?? '', lineErrors.get(q.id)?.join(';') ?? ''].filter(Boolean);
    q.verifyNote = notes.join(' | ');
    if (r.verdict === 'fix') {
      fix++;
      citesBeforeFix.set(q.id, q.代码依据);
      if (Array.isArray(r.修正答案要点) && r.修正答案要点.length) q.答案要点 = r.修正答案要点.map(String);
      if (Array.isArray(r.修正代码依据) && r.修正代码依据.length) {
        q.代码依据 = r.修正代码依据.map(
          (c): CodeCite => ({ file: String(c?.file ?? ''), lines: String(c?.lines ?? '') })
        );
      }
      // 形状合格才写回,避免渲染层拿到残缺对比块
      const c2 = r.修正对比 as Record<string, unknown> | undefined;
      if (c2 && Array.isArray(c2.候选方案) && Array.isArray(c2.维度) && Array.isArray(c2.对比表) && typeof c2.结论 === 'string') {
        q.对比 = {
          候选方案: c2.候选方案.map(String),
          维度: c2.维度.map(String),
          对比表: c2.对比表.map((row) => (Array.isArray(row) ? row.map(String) : [])),
          结论: c2.结论,
        };
      }
    } else if (r.verdict === 'flag') {
      flag++;
    } else {
      // 确定性错误优先于模型 pass:引用文件不存在/行号越界的题不允许"通过"
      if (lineErrors.has(q.id)) {
        q.verified = 'flag';
        flag++;
      } else {
        pass++;
      }
    }
  }

  // 修订后复检:若"修正代码依据"自身违反确定性检查(越界/坏格式),回退该题引用,防止越修越坏
  const recheck = deterministicCheck(facts, questions);
  for (const [qid, errs] of recheck.lineErrors) {
    const orig = citesBeforeFix.get(qid);
    if (!orig) continue;
    const q = questions.find((x) => x.id === qid);
    if (!q) continue;
    q.代码依据 = orig;
    q.verifyNote = `${q.verifyNote ?? ''} | 修正引用未通过复检(${errs[0]}),已回退原始引用`.trim();
    warn(`  [复检] ${qid} 修正引用非法,已回退:${errs[0]}`);
  }

  // Final deterministic gate is authoritative. Recompute counters after any
  // citation repair/rollback so the report cannot claim pass for an invalid cite.
  const finalCheck = deterministicCheck(facts, questions);
  for (const q of questions) {
    const errs = finalCheck.lineErrors.get(q.id);
    if (errs) {
      q.verified = 'flag';
      q.verifyNote = `${q.verifyNote ?? ''} | 最终确定性检查失败:${errs.join(';')}`.trim();
    }
  }
  pass = questions.filter((q) => q.verified === 'pass').length;
  fix = questions.filter((q) => q.verified === 'fix').length;
  flag = questions.filter((q) => q.verified === 'flag').length;
  unverified = questions.filter((q) => q.verified === 'unverified').length;

  // 写修订后的题库与校验报告
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'questions.json'), JSON.stringify(questions, null, 2), 'utf-8');
  const stats: VerifyStats = {
    total: questions.length,
    pass,
    fix,
    flag,
    unverified,
    deterministicIssues: finalCheck.lineErrors.size,
  };
  writeVerifyReport(questions, outDir, stats);
  log(`  校验完成:pass=${pass} fix=${fix} flag=${flag} unverified=${unverified} → 校验报告.md`);
  return stats;
}
