import * as fs from 'fs';
import * as path from 'path';
import { DeepSeekClient, parseJsonLoose } from '../core/deepseek';
import { RepoFacts } from '../core/profiler';
import { Question, parseCiteRanges, isValidComparison } from '../core/schemas';
import { CATEGORIES, totalQuota } from '../core/coverage';
import { deterministicCheck } from './stage3Verify';
import { DiskCache, PROMPT_VERSION } from '../core/cache';
import { StageRunContext } from './stage1Read';
import { log, warn } from '../core/logger';
import { sanitizeMdCell } from './stage5Assemble';
import { EVAL_FACT_SYSTEM, EVAL_CMP_SYSTEM, EVAL_NARRATIVE_SYSTEM, EVAL_USABILITY_SYSTEM } from '../core/prompts';

/**
 * 自评环:用 DeepSeek 当评委,对生成材料按维度打分(满分 10),
 * 输出优势/劣势/具体改进清单 → 人工(或 agent)据此改进管线后重跑,迭代逼近满分。
 *
 * 可复现性(审计 Q-R6):评委调用走 DiskCache——同一份材料重跑 evaluate 得到同一组分数,
 * 分数变化才意味着材料变化。主观噪声不再污染迭代决策(方差留给"换提示词/换材料")。
 * 聚合规则:缺失维度剔除而非记 0;评委整体失败 → 该维度记"未评估"并重新归一化权重,
 * 不再与确定性检查双重惩罚。
 */

export interface EvalResult {
  total: number; // 0-10
  dims: Array<{ name: string; score: number | null; weight: number; comment: string }>;
  strengths: string[];
  weaknesses: string[];
  detFailures: string[];
}

/** 评委判读材料的截断上限(评委 3 只看前段的问题已文档化:截断时在评语里注明覆盖率) */
const NARRATIVE_READ_CHARS = 12000;
const QA_READ_CHARS = 8000;
const DET_PENALTY_PER_FAILURE = 1;

function readMd(outDir: string, name: string, maxChars: number): string {
  const p = path.join(outDir, name);
  if (!fs.existsSync(p)) return '(缺失)';
  const t = fs.readFileSync(p, 'utf-8');
  return t.length > maxChars ? t.slice(0, maxChars) + `\n...(截断,已覆盖全文前 ${(maxChars / t.length * 100).toFixed(0)}%)` : t;
}

/** 抽样:覆盖各类别,必含 flag 与对比题 */
function sampleQuestions(questions: Question[]): Question[] {
  const cmp = questions.filter((q) => q.category === '技术选型对比');
  const flagged = questions.filter((q) => q.verified === 'flag' && q.category !== '技术选型对比');
  const others = questions.filter((q) => q.category !== '技术选型对比' && q.verified !== 'flag');
  const spread = (arr: Question[], n: number): Question[] => {
    if (arr.length <= n) return [...arr];
    const out: Question[] = [];
    const step = arr.length / n;
    for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
    return out;
  };
  return [...spread(cmp, 4), ...flagged.slice(0, 2), ...spread(others, 6)].slice(0, 12);
}

/** 安全 JSON 读取 */
function readJsonSafe<T>(p: string, what: string): T {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  } catch (err) {
    throw new Error(`无法读取 ${what}(${p}):${err instanceof Error ? err.message : err}`);
  }
}

/** 分数钳制:0-10 有限数;非法值返回 null(剔除,不记 0 也不放大) */
function clampScore(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(10, n));
}

/** items 字段防护:主解析路径可能返回对象而非数组 */
function asItems(v: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null);
}

export async function runEvaluation(client: DeepSeekClient, outDir: string, ctx: StageRunContext = {}): Promise<EvalResult> {
  const qPath = path.join(outDir, 'questions.json');
  if (!fs.existsSync(qPath)) throw new Error(`未找到 ${qPath},请先运行 generate`);
  const questions = readJsonSafe<Question[]>(qPath, '题库');
  const factsPath = path.join(outDir, 'repo_facts.json');
  if (!fs.existsSync(factsPath)) throw new Error(`未找到 ${factsPath},请先运行 generate`);
  const facts = readJsonSafe<RepoFacts>(factsPath, '仓库画像');
  const cache = new DiskCache(path.join(outDir, '.cache'));

  /* ---------- 确定性检查 ---------- */
  const detFailures: string[] = [];
  const quota = totalQuota();
  if (questions.length !== quota) detFailures.push(`题数 ${questions.length} ≠ 配额 ${quota}`);
  for (const cat of CATEGORIES) {
    const n = questions.filter((q) => q.category === cat.name).length;
    if (n !== cat.quota) detFailures.push(`类别「${cat.name}」${n} 题 ≠ 配额 ${cat.quota}`);
  }
  const badCmp = questions.filter(
    (q) =>
      q.category === '技术选型对比' && !isValidComparison(q.对比)
  );
  if (badCmp.length) detFailures.push(`${badCmp.length} 道选型对比题缺少结构合格对比块`);
  const { lineErrors } = deterministicCheck(facts, questions);
  if (lineErrors.size) detFailures.push(`${lineErrors.size} 题引用无法通过确定性检查:${[...lineErrors.values()].flat().slice(0, 3).join(';')}`);
  for (const f of ['01_项目讲解.md', '02_百问百答.md', '03_亮点与防守.md', '04_缺点与改进.md', '05_设计决策与选型对比.md', 'index.html']) {
    if (!fs.existsSync(path.join(outDir, f))) detFailures.push(`缺少产物文件 ${f}`);
  }

  /* ---------- 评委 1:事实抽查(带代码原文) ---------- */
  log('  评委 1/4:事实真实性抽查 ...');
  const samples = sampleQuestions(questions);
  const filesSet = new Set(facts.files);
  const linesCache = new Map<string, string[]>();
  const excerptOf = (q: Question): string =>
    q.代码依据
      .slice(0, 4)
      .map((c) => {
        // 防御纵深:evaluate 直读 questions.json,引用可能被手改为绝对路径/../ 越界
        if (!filesSet.has(c.file)) return '(引用文件不在画像清单,已跳过)';
        if (!linesCache.has(c.file)) {
          try {
            const text = fs.readFileSync(path.join(facts.root, c.file), 'utf-8');
            const lines = text.split(/\r?\n/);
            if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
            linesCache.set(c.file, lines);
          } catch {
            linesCache.set(c.file, []);
          }
        }
        const lines = linesCache.get(c.file)!;
        const ranges = parseCiteRanges(c.lines);
        if (!ranges) return `(行号非法 ${c.lines})`;
        return ranges
          .map(([s0, e0]) => {
            const s = Math.max(0, s0 - 1);
            const e = Math.min(lines.length, e0);
            return `--- ${c.file}:${s0}-${e0} ---\n${lines.slice(s, e).join('\n')}`;
          })
          .join('\n');
      })
      .join('\n\n');

  const factPayload = samples
    .map(
      (q) => `## ${q.id}〔${q.category}|${q.difficulty}〕
问题:${q.question}
答案要点:${q.答案要点.join(' | ')}
代码依据:${q.代码依据.map((c) => `${c.file}:${c.lines}`).join('、')}

引用处代码原文:
${excerptOf(q).slice(0, 5000)}`
    )
    .join('\n\n========\n\n');

  const judge = async (name: string, system: string, user: string, maxTokens = 2000): Promise<Record<string, unknown>> => {
    // 评委结果缓存:同一材料同一提示词 → 同一结果,evaluate 可复现
    const key = cache.key('eval', PROMPT_VERSION, name, system, user);
    const cached = cache.get<Record<string, unknown>>(key);
    if (cached && typeof cached === 'object') {
      log(`  [缓存] 评委 ${name}`);
      return cached;
    }
    const raw = await client.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { temperature: 0.1, jsonMode: true, maxTokens, signal: ctx.signal }
    );
    let parsed: Record<string, unknown>;
    try {
      parsed = parseJsonLoose<Record<string, unknown>>(raw);
    } catch {
      // 宽容兜底:评委输出常因预算截断,直接正则抽取数值字段与字符串数组,避免整轮 0 分
      const out: Record<string, unknown> = {};
      const kv = raw.matchAll(/"([^"]{1,20})"\s*:\s*([0-9]+(?:\.[0-9])?)/g);
      for (const m of kv) out[m[1]] = Number(m[2]);
      const problems = [...raw.matchAll(/"(?:problems|weaknesses)"\s*:\s*\[([^\]]*)/g)].flatMap((m) =>
        [...m[1].matchAll(/"([^"]{8,300})"/g)].map((s) => s[1])
      );
      const strengths = [...raw.matchAll(/"strengths"\s*:\s*\[([^\]]*)/g)].flatMap((m) =>
        [...m[1].matchAll(/"([^"]{8,300})"/g)].map((s) => s[1])
      );
      if (problems.length) out.problems = problems;
      if (strengths.length) out.strengths = strengths;
      const summary = raw.match(/"summary"\s*:\s*"([^"]{8,500})/);
      if (summary) out.summary = summary[1];
      const items = [...raw.matchAll(/\{\s*"id"\s*:\s*"([^"]+)"((?:[^{}]|\{(?!$))*?)\}/g)];
      if (items.length) {
        out.items = items.map((it) => {
          const o: Record<string, unknown> = { id: it[1] };
          for (const m of it[2].matchAll(/"([a-zA-Z_一-龥]+)"\s*:\s*([0-9]+(?:\.[0-9])?)/g)) o[m[1]] = Number(m[2]);
          const p = it[2].match(/"problem"\s*:\s*"([^"]{5,300})/);
          if (p) o.problem = p[1];
          return o;
        });
      }
      if (Object.keys(out).length === 0) throw new Error(`无法从模型输出解析 JSON:${raw.slice(0, 200)}`);
      warn('  [评委] JSON 截断,已用宽容解析救回部分字段');
      parsed = out;
    }
    cache.set(key, parsed);
    return parsed;
  };

  let factJudge: Record<string, unknown> = {};
  try {
    factJudge = await judge(
      'fact',
      EVAL_FACT_SYSTEM,
      factPayload,
      3000
    );
  } catch (err) {
    detFailures.push(`评委1(事实抽查)失败:${err instanceof Error ? err.message : err}`);
  }

  /* ---------- 评委 2:横向对比质量 ---------- */
  log('  评委 2/4:横向对比质量 ...');
  const cmpQs = questions.filter((q) => q.对比).slice(0, 5);
  let cmpJudge: Record<string, unknown> = {};
  try {
    cmpJudge = await judge(
      'cmp',
      EVAL_CMP_SYSTEM,
      `题目与对比块:\n${cmpQs.map((q) => `${q.id}:${q.question}\n${JSON.stringify(q.对比)}`).join('\n\n')}`,
      2500
    );
  } catch (err) {
    detFailures.push(`评委2(对比质量)失败:${err instanceof Error ? err.message : err}`);
  }

  /* ---------- 评委 3:叙述类材料质量 ---------- */
  log('  评委 3/4:项目讲解/亮点/缺点材料 ...');
  let narrJudge: Record<string, unknown> = {};
  try {
    narrJudge = await judge(
      'narrative',
      EVAL_NARRATIVE_SYSTEM,
      `# 01 项目讲解\n${readMd(outDir, '01_项目讲解.md', NARRATIVE_READ_CHARS)}\n\n# 03 亮点与防守\n${readMd(outDir, '03_亮点与防守.md', 8000)}\n\n# 04 缺点与改进\n${readMd(outDir, '04_缺点与改进.md', 8000)}\n\n# 05 设计决策与选型对比\n${readMd(outDir, '05_设计决策与选型对比.md', 8000)}`,
      4000
    );
  } catch (err) {
    detFailures.push(`评委3(叙述材料)失败:${err instanceof Error ? err.message : err}`);
  }

  /* ---------- 评委 4:题库易用性 ---------- */
  log('  评委 4/4:题库结构与易用性 ...');
  let useJudge: Record<string, unknown> = {};
  try {
    useJudge = await judge(
      'usability',
      EVAL_USABILITY_SYSTEM,
      `统计:共 ${questions.length} 题;类别分布:${[...new Set(questions.map((q) => q.category))]
        .map((c) => `${c}:${questions.filter((q) => q.category === c).length}`)
        .join(',')}。\n\n# 百问百答样本\n${readMd(outDir, '02_百问百答.md', QA_READ_CHARS)}`,
      1500
    );
  } catch (err) {
    detFailures.push(`评委4(易用性)失败:${err instanceof Error ? err.message : err}`);
  }

  /* ---------- 汇总(缺失剔除;失败维度记 null 并归一化权重) ---------- */
  const collect = (items: Array<Record<string, unknown>>, keys: string[]): Array<number | null> =>
    items.flatMap((i) => keys.map((k) => clampScore(i[k])));
  const factItems = asItems(factJudge.items);
  const cmpItems = asItems(cmpJudge.items);
  const clampOrNull = (v: unknown): number | null => clampScore(v);

  const dims: EvalResult['dims'] = [
    {
      name: '事实真实性(引用与要点与代码一致)',
      score: avgOrNull([...collect(factItems, ['cite']), ...collect(factItems, ['consistency'])]),
      weight: 0.3,
      comment: String(factJudge.summary ?? (factItems.length ? '' : '(评委未返回)')),
    },
    {
      name: '横向对比质量(维度/客观性/边界)',
      score: avgOrNull([...collect(cmpItems, ['dims']), ...collect(cmpItems, ['objectivity']), ...collect(cmpItems, ['boundary'])]),
      weight: 0.2,
      comment: String(cmpJudge.summary ?? (cmpItems.length ? '' : '(无对比题可评)')),
    },
    {
      name: '叙述材料(STAR/亮点防守/缺点话术/对比章节)',
      score: avgOrNull(
        ['STAR可信度', '亮点防守', '缺点话术', '对比章节'].map((k) => clampOrNull(narrJudge[k]))
      ),
      weight: 0.25,
      comment: [...((narrJudge.problems as string[]) ?? []), ...((narrJudge.strengths as string[]) ?? [])].join(';'),
    },
    {
      name: '题库结构与易用性',
      score: clampOrNull(useJudge['易用性']),
      weight: 0.1,
      comment: [...((useJudge.problems as string[]) ?? []), ...((useJudge.strengths as string[]) ?? [])].join(';'),
    },
    {
      name: '确定性合规(题数/配额/引用可解析/产物齐全)',
      score: detFailures.length === 0 ? 10 : Math.max(0, 10 - detFailures.length * DET_PENALTY_PER_FAILURE),
      weight: 0.15,
      comment: detFailures.length ? detFailures.join(';') : '全部通过',
    },
  ];
  const scored = dims.filter((d): d is EvalResult['dims'][number] & { score: number } => d.score !== null);
  const weightSum = scored.reduce((s, d) => s + d.weight, 0);
  const total = weightSum
    ? Number((scored.reduce((s, d) => s + d.score * d.weight, 0) / weightSum).toFixed(1))
    : 0;
  if (scored.length < dims.length) {
    warn(`  [评委] ${dims.length - scored.length} 个维度未评估(评委失败/字段缺失),总分按其余维度归一化`);
  }

  const strengths = dims
    .filter((d) => d.score !== null && d.score >= 8.5)
    .map((d) => `${d.name}:${d.score!.toFixed(1)}/10 — ${d.comment || '表现稳定'}`);
  const weaknesses = dims
    .filter((d) => d.score === null || d.score < 8.5)
    .map((d) =>
      d.score === null
        ? `${d.name}:未评估(评委失败/字段缺失)— ${d.comment || '重跑 evaluate 可补'}`
        : `${d.name}:${d.score.toFixed(1)}/10 — 需改进:${d.comment || '见问题清单'}`
    );
  for (const p of (narrJudge.problems as string[]) ?? []) weaknesses.push(`叙述材料:${p}`);
  for (const i of factItems) {
    const c = clampScore(i.cite);
    const cons = clampScore(i.consistency);
    if ((c !== null && c < 7) || (cons !== null && cons < 7)) weaknesses.push(`事实抽查 ${i.id}:${i.problem}`);
  }

  /* ---------- 报告落盘 ---------- */
  const md: string[] = [
    `# 自评报告(DeepSeek 评委)`,
    ``,
    `**总分:${total} / 10**${scored.length < dims.length ? `(按已评估的 ${scored.length}/${dims.length} 个维度归一化)` : ''}`,
    ``,
    `| 维度 | 得分 | 权重 | 说明 |`,
    `|---|---|---|---|`,
    ...dims.map(
      (d) =>
        `| ${sanitizeMdCell(d.name)} | ${d.score === null ? '未评估' : d.score.toFixed(1)} | ${Math.round(d.weight * 100)}% | ${sanitizeMdCell(d.comment.slice(0, 120))} |`
    ),
    ``,
    `## 优势(≥8.5)`,
    ...(strengths.length ? strengths.map((s) => `- ${s}`) : ['- (暂无 ≥8.5 的维度)']),
    ``,
    `## 劣势与改进清单(<8.5)`,
    ...(weaknesses.length ? weaknesses.map((w) => `- ${w}`) : ['- (无 <8.5 的维度)']),
    ``,
    `## 确定性检查`,
    ...(detFailures.length ? detFailures.map((d) => `- ✗ ${sanitizeMdCell(d)}`) : ['- 全部通过']),
    ``,
    `> 评委结果已按材料内容缓存:同一份产物重跑 evaluate 分数不变;修改材料或删除 .cache 后重新评分。`,
    ``,
  ];
  fs.writeFileSync(path.join(outDir, '自评报告.md'), md.join('\n'), 'utf-8');

  log(`\n  自评总分:${total}/10(详情 → 自评报告.md)`);
  for (const d of dims) {
    const s = d.score === null ? '未评估' : d.score.toFixed(1);
    log(`    ${d.score !== null && d.score >= 8 ? '✓' : '✗'} ${d.name}:${s}/10 × ${Math.round(d.weight * 100)}%`);
  }

  return { total, dims, strengths, weaknesses, detFailures };
}

function avgOrNull(arr: Array<number | null>): number | null {
  const vals = arr.filter((x): x is number => x !== null);
  if (!vals.length) return null;
  return vals.reduce((s, x) => s + x, 0) / vals.length;
}
