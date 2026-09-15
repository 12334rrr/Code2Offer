import * as fs from 'fs';
import * as path from 'path';
import { DeepSeekClient, parseJsonLoose } from '../core/deepseek';
import { RepoFacts } from '../core/profiler';
import { Chunk } from '../core/chunker';
import { DiskCache, PROMPT_VERSION } from '../core/cache';
import { ModuleCard, ProjectKnowledge, Question, coerceQuestion, validateQuestion } from '../core/schemas';
import { Slot, buildSlots, totalQuota, computeDeficitSlots } from '../core/coverage';
import { STAGE2_SYSTEM, STAGE2_REPAIR_SYSTEM, STAGE2_CMP_REPAIR_SYSTEM, STAGE2_POINTS_REPAIR_SYSTEM, STAGE2_FLAG_REWRITE_SYSTEM, Stage2BatchInput, stage2BatchUser, stage2RepairUser, stage2CmpRepairUser, stage2PointsRepairUser, stage2FlagRewriteUser, STAGE2_TOPUP_USER_HINT } from '../core/prompts';
import { requiresComparison } from '../core/coverage';
import { isValidComparison } from '../core/schemas';
import { deterministicCheck } from './stage3Verify';
import { StageRunContext } from './stage1Read';
import { log, warn } from '../core/logger';

// 推理模型输出上限有限:小批次富 JSON 更稳(截断修复 + 补题轮兜底)
const BATCH_SIZE = 5;
/** 补题轮上限:防止模型持续返回不可用题目时的无限循环 */
const MAX_TOPUP_ROUNDS = 4;

function knowledgeDigest(k: ProjectKnowledge): string {
  return JSON.stringify(
    {
      一句话定位: k.一句话定位,
      架构描述: k.架构描述,
      数据流: k.数据流,
      技术栈: k.技术栈,
      亮点: k.亮点,
      缺点: k.缺点,
    },
    null,
    1
  );
}

function cardsForTargets(cards: ModuleCard[], targets: string[]): string {
  // 先按名字精确命中;再按目标关键词匹配模块文件路径/职责(选型目标此前几乎必然落空,退化为最大 3 块)
  const wanted = new Set(targets);
  const keywords = targets.map((t) => t.split(/[:：]/).pop()!.toLowerCase()).filter((k) => k && k !== '项目整体');
  const chosen = cards.filter(
    (c) =>
      wanted.has(c.name) ||
      keywords.some((kw) => c.name.toLowerCase().includes(kw) || c.files.some((f) => f.toLowerCase().includes(kw)))
  );
  const list = chosen.length ? chosen.slice(0, 4) : cards.slice(0, 3);
  return list
    .map((c) =>
      JSON.stringify(
        {
          name: c.name,
          职责: c.职责,
          关键实现: c.关键实现.slice(0, 6),
          设计决策: c.设计决策,
          亮点: c.亮点.slice(0, 4),
          缺点: c.缺点.slice(0, 4),
          面试深挖点: c.面试深挖点.slice(0, 5),
        },
        null,
        1
      )
    )
    .join('\n\n')
    .slice(0, 16000);
}

function normalizeStem(q: string): string {
  return q.replace(/\s+/g, '').toLowerCase().slice(0, 80);
}

interface GenResult {
  questions: Question[];
  dropped: number;
}

async function generateBatch(
  client: DeepSeekClient,
  facts: RepoFacts,
  cards: ModuleCard[],
  knowledge: ProjectKnowledge,
  chunkIndex: Map<string, { lines: string }>,
  slots: Slot[],
  askedStems: string[],
  ctx: StageRunContext = {},
  mode: 'normal' | 'topup' = 'normal'
): Promise<GenResult> {
  const filesSet = new Set(facts.files);
  const targets = [...new Set(slots.map((s) => s.target).map((t) => t.split(':')[0]))];
  const input: Stage2BatchInput = {
    knowledgeDigest: knowledgeDigest(knowledge),
    cardsText: cardsForTargets(cards, targets),
    slots: slots.map((s, i) => ({
      index: i + 1,
      category: s.category,
      difficulty: s.difficulty,
      target: s.target,
      hint: s.hint,
      requireComparison: s.requireComparison,
    })),
    fileList: [...chunkIndex.entries()].map(([f, v]) => `${f}(${v.lines})`),
    askedStems,
  };

  const callAndParse = async (topup: boolean): Promise<unknown[]> => {
    const raw = await client.chat(
      [
        { role: 'system', content: STAGE2_SYSTEM },
        {
          role: 'user',
          content: stage2BatchUser(input) + (topup ? `\n\n${STAGE2_TOPUP_USER_HINT}\n请重点补齐这些缺口题位,不要与"已出题目"列表里的任何题语义重复。` : ''),
        },
      ],
      { temperature: topup ? 0.6 : 0.5, jsonMode: true, maxTokens: 8000, signal: ctx.signal }
    );
    const parsed = parseJsonLoose<{ questions?: unknown[] }>(raw);
    return Array.isArray(parsed.questions) ? parsed.questions : [];
  };

  let rawQuestions: unknown[] = [];
  try {
    rawQuestions = await callAndParse(mode === 'topup');
  } catch (err) {
    if (String(err instanceof Error ? err.message : err) === '已取消') throw err;
    warn(`  [警告] 批次解析失败将重试一次:${err instanceof Error ? err.message : err}`);
    try {
      rawQuestions = await callAndParse(mode === 'topup');
    } catch (err2) {
      if (String(err2 instanceof Error ? err2.message : err2) === '已取消') throw err2;
      // 优雅降级:本批 0 题,由补题轮填平
      warn(`  [警告] 批次两次解析失败,放弃本批(${err2 instanceof Error ? err2.message : err2})`);
      return { questions: [], dropped: slots.length };
    }
  }

  // 对位 + 校验(coerce 强制以 slot 为准,模型回显的类别/难度不采信)
  const questions: Question[] = [];
  const bad: Array<{ question: unknown; errors: string[]; slot: Slot }> = [];
  rawQuestions.forEach((rq, i) => {
    const slot = slots[i];
    if (!slot) return;
    const q = coerceQuestion(rq, '', slot.category, slot.difficulty as Question['difficulty'], slot.target);
    const errors = validateQuestion(q, filesSet);
    if (errors.length) bad.push({ question: rq, errors, slot });
    else questions.push(q);
  });

  // 修复轮:一次调用修全部坏题,按原题位回填
  if (bad.length) {
    log(`  校验未通过 ${bad.length} 题,进入修复轮 ...`);
    try {
      const raw = await client.chat(
        [
          { role: 'system', content: STAGE2_REPAIR_SYSTEM },
          { role: 'user', content: stage2RepairUser(bad) },
        ],
        { temperature: 0.3, jsonMode: true, maxTokens: 8000, signal: ctx.signal }
      );
      const fixed = parseJsonLoose<{ questions?: unknown[] }>(raw);
      const list = Array.isArray(fixed.questions) ? fixed.questions : [];
      list.slice(0, bad.length).forEach((rq, i) => {
        const targetSlot = bad[i]?.slot;
        if (!targetSlot) return;
        const q = coerceQuestion(rq, '', targetSlot.category, targetSlot.difficulty as Question['difficulty'], targetSlot.target);
        if (!validateQuestion(q, filesSet).length) questions.push(q);
      });
    } catch (err) {
      if (String(err instanceof Error ? err.message : err) === '已取消') throw err;
      warn(`  [警告] 修复轮失败:${err instanceof Error ? err.message : err}`);
    }
  }

  // 去重(与已出题 & 批内)
  const seen = new Set(askedStems.map(normalizeStem));
  const unique: Question[] = [];
  for (const q of questions) {
    const stem = normalizeStem(q.question);
    if (!q.question || seen.has(stem)) continue;
    seen.add(stem);
    unique.push(q);
  }
  return { questions: unique, dropped: slots.length - unique.length };
}

/** 题库重新生成时必须清掉的派生状态(校验断点按题号复用会把旧裁决套到新题上,审计 R-2) */
export function resetVerifyCheckpoint(outDir: string): void {
  const p = path.join(outDir, '.verify-progress.json');
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* 删不掉就算了,checkpoint 自身也有输入指纹兜底 */
  }
}

/** 阶段 2 主入口:产出恰好(至多)100 题并落盘;补题按配额缺口定向,不再按序号切片 */
export async function runStage2(
  client: DeepSeekClient,
  cache: DiskCache,
  facts: RepoFacts,
  cards: ModuleCard[],
  knowledge: ProjectKnowledge,
  chunks: Chunk[],
  outDir: string,
  ctx: StageRunContext = {}
): Promise<Question[]> {
  const slots = buildSlots(cards, knowledge);
  const quota = totalQuota();
  log(`  覆盖矩阵:${slots.length} 个题位(配额合计 ${quota})`);

  // 文件 → 可引用行数范围索引
  const chunkIndex = new Map<string, { lines: string }>();
  for (const c of chunks) {
    chunkIndex.set(c.file, { lines: `1-${c.endLine}` });
  }

  const all: Question[] = [];
  const askedStems: string[] = [];
  let idCounter = 1;
  const fillFromBatch = async (batchSlots: Slot[], mode: 'normal' | 'topup') => {
    const { questions } = await generateBatch(client, facts, cards, knowledge, chunkIndex, batchSlots, askedStems, ctx, mode);
    for (const q of questions) {
      if (all.length >= quota) break;
      q.id = `Q${String(idCounter++).padStart(2, '0')}`;
      all.push(q);
      askedStems.push(q.question);
    }
  };

  for (let i = 0; i < slots.length; i += BATCH_SIZE) {
    if (ctx.signal?.aborted) throw new Error('已取消');
    const batchSlots = slots.slice(i, i + BATCH_SIZE);
    log(
      `  出题批次 ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(slots.length / BATCH_SIZE)}(${batchSlots[0].category} 等 ${batchSlots.length} 题)...`
    );
    await fillFromBatch(batchSlots, 'normal');
  }

  // 补题轮:按"类别×难度缺口"定向补齐(此前 slots.slice(all.length) 的窗口在批间坍塌后漂移,
  // 丢失的类别永远不补,而补进来的题挤占别的配额——审计 R-5)
  let rounds = 0;
  let deficit = computeDeficitSlots(all, cards, knowledge);
  while (deficit.length > 0 && all.length < quota && rounds < MAX_TOPUP_ROUNDS) {
    rounds++;
    log(`  配额缺口 ${deficit.length} 题(${[...new Set(deficit.map((d) => `${d.category}|${d.difficulty}`))].join('、')}),补题第 ${rounds}/${MAX_TOPUP_ROUNDS} 轮 ...`);
    for (let i = 0; i < deficit.length && all.length < quota; i += BATCH_SIZE) {
      if (ctx.signal?.aborted) throw new Error('已取消');
      await fillFromBatch(deficit.slice(i, i + BATCH_SIZE), 'topup');
    }
    deficit = computeDeficitSlots(all, cards, knowledge);
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'questions.json'), JSON.stringify(all, null, 2), 'utf-8');
  // 题库已重新生成:校验断点作废
  resetVerifyCheckpoint(outDir);
  log(`  已产出 ${all.length}/${quota} 题 → questions.json`);
  if (deficit.length) {
    warn(`  [注意] 仍有配额缺口 ${deficit.length} 题(当前 ${all.length}),可运行 topup 子命令继续补齐`);
  }
  return all;
}

/** 安全读取题库:截断/坏 JSON 给出友好错误而不是裸异常(审计 Q-R3) */
function readQuestionsSafe(qPath: string): Question[] | null {
  try {
    return JSON.parse(fs.readFileSync(qPath, 'utf-8')) as Question[];
  } catch (err) {
    warn(`  [错误] ${qPath} 不是合法 JSON(${err instanceof Error ? err.message : err});如无备份可删除后重新 generate`);
    return null;
  }
}

/** 现有题目的最大数字编号(补题 ID 从其后继续,不再依赖 existing.length) */
function maxQuestionId(questions: Question[]): number {
  let max = 0;
  for (const q of questions) {
    const m = /^Q(\d+)$/.exec(q.id ?? '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * 定向补题:对已有题库按覆盖矩阵配额计算缺口,分小块补齐并追加写回。
 * 用于历史批次坍塌后的恢复,不必整库重出。补齐总数受配额上限约束。
 */
export async function topUpToQuota(
  client: DeepSeekClient,
  facts: RepoFacts,
  cards: ModuleCard[],
  knowledge: ProjectKnowledge,
  chunks: Chunk[],
  outDir: string,
  ctx: StageRunContext = {}
): Promise<Question[]> {
  const qPath = path.join(outDir, 'questions.json');
  const existing = fs.existsSync(qPath) ? readQuestionsSafe(qPath) : [];
  if (existing === null) throw new Error('questions.json 损坏,无法补题');
  const quota = totalQuota();

  const missingSlots = computeDeficitSlots(existing, cards, knowledge).slice(0, Math.max(0, quota - existing.length));
  log(`  现有 ${existing.length} 题,按配额缺口 ${missingSlots.length} 题补齐`);

  const chunkIndex = new Map<string, { lines: string }>();
  for (const c of chunks) chunkIndex.set(c.file, { lines: `1-${c.endLine}` });
  const askedStems = existing.map((q) => q.question);
  let idCounter = maxQuestionId(existing) + 1;

  for (let i = 0; i < missingSlots.length; i += BATCH_SIZE) {
    if (ctx.signal?.aborted) throw new Error('已取消');
    const chunkSlots = missingSlots.slice(i, i + BATCH_SIZE);
    log(`  补题批次 ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(missingSlots.length / BATCH_SIZE)} ...`);
    const { questions } = await generateBatch(client, facts, cards, knowledge, chunkIndex, chunkSlots, askedStems, ctx, 'topup');
    for (const q of questions) {
      if (existing.length >= quota) break;
      q.id = `Q${String(idCounter++).padStart(2, '0')}`;
      existing.push(q);
      askedStems.push(q.question);
    }
  }

  fs.writeFileSync(qPath, JSON.stringify(existing, null, 2), 'utf-8');
  resetVerifyCheckpoint(outDir);
  log(`  补齐后共 ${existing.length} 题 → questions.json`);
  const remain = computeDeficitSlots(existing, cards, knowledge);
  if (remain.length) warn(`  [注意] 仍差 ${remain.length} 题,可再运行一次 topup`);
  return existing;
}

/**
 * 对比块补齐环:凡 requireComparison 类别的题缺合格对比块,逐题定向补生成。
 * 用户硬要求"凡选型必对比";补齐环让该约束不依赖出题批次的自觉。
 */
export async function repairComparisons(
  client: DeepSeekClient,
  cache: DiskCache,
  facts: RepoFacts,
  questions: Question[],
  outDir: string,
  ctx: StageRunContext = {}
): Promise<number> {
  const { excerpts } = deterministicCheck(facts, questions);
  const need = questions.filter((q) => requiresComparison(q.category) && !isValidComparison(q.对比));
  if (!need.length) return 0;
  log(`  对比块补齐:${need.length} 题缺合格对比块(${need.map((q) => q.id).join('、')})`);
  let repaired = 0;
  for (const q of need) {
    if (ctx.signal?.aborted) throw new Error('已取消');
    const ex = q.代码依据
      .map((c) => excerpts.get(`${q.id}|${c.file}|${c.lines}`) ?? '')
      .filter(Boolean)
      .join('\n\n');
    const material = stage2CmpRepairUser(q.question, q.答案要点, ex);
    const key = cache.key('cmp-repair', PROMPT_VERSION, STAGE2_CMP_REPAIR_SYSTEM, q.id, material);
    // 命中缓存也要复验形状,防坏缓存长期占位
    let raw = cache.get<string>(key);
    let ok = false;
    if (typeof raw === 'string') {
      try {
        const parsed = parseJsonLoose<{ 对比?: unknown }>(raw);
        ok = isValidComparison(parsed?.对比);
        if (ok) {
          q.对比 = parsed.对比 as Question['对比'];
          repaired++;
          continue;
        }
      } catch {
        /* 坏缓存按未命中处理 */
      }
    }
    try {
      // 最多两次新生成:推理模型偶发输出截断/跑题,第二次通常能过形状校验
      for (let a = 0; a < 2 && !ok; a++) {
        raw = await client.chat(
          [
            { role: 'system', content: STAGE2_CMP_REPAIR_SYSTEM },
            { role: 'user', content: material },
          ],
          { temperature: a === 0 ? 0.3 : 0.5, jsonMode: true, maxTokens: 4000, signal: ctx.signal }
        );
        const parsed = parseJsonLoose<{ 对比?: unknown }>(raw);
        if (isValidComparison(parsed?.对比)) {
          q.对比 = parsed.对比 as Question['对比'];
          cache.set(key, raw);
          repaired++;
          ok = true;
        }
      }
      if (!ok) warn(`  [警告] ${q.id} 补出的对比块形状不合格(已重试),放弃`);
    } catch (err) {
      if (String(err instanceof Error ? err.message : err) === '已取消') throw err;
      warn(`  [警告] ${q.id} 对比块补生成失败:${err instanceof Error ? err.message : err}`);
    }
  }
  if (repaired) {
    fs.writeFileSync(path.join(outDir, 'questions.json'), JSON.stringify(questions, null, 2), 'utf-8');
    log(`  对比块补齐完成:${repaired} 题 → questions.json`);
  }
  return repaired;
}

/** 检测"引用校订批注"式要点(讨论材料本身而非回答题目) */
const META_POINT_RE =
  /不要合并引用|行号(应为|不准|有误)|对比块需|要点需|引用(需|应为|校订)|实际(从|是).{0,12}(开始|行)|与代码(不符|不一致)|需补充|需核对|待核|请候选人/;

export function hasAnnotationStylePoints(q: Question): boolean {
  return q.答案要点.some((a) => META_POINT_RE.test(a));
}

/** 要点不足 3 条(常见于校验修复轮被截断),与批注式要点一样需要重写 */
export function hasThinPoints(q: Question): boolean {
  return q.答案要点.length < 3;
}

/**
 * 答案要点实质化:校验环的"修正答案要点"偶尔会写成引用校订批注(只谈行号对错不答题)。
 * 检测到即用题目+代码原文+对比块重写为可背诵的实质要点。
 */
export async function repairAnnotationAnswers(
  client: DeepSeekClient,
  cache: DiskCache,
  facts: RepoFacts,
  questions: Question[],
  outDir: string,
  ctx: StageRunContext = {}
): Promise<number> {
  const need = questions.filter((q) => hasAnnotationStylePoints(q) || hasThinPoints(q));
  if (!need.length) return 0;
  const { excerpts } = deterministicCheck(facts, questions);
  log(
    `  答案要点实质化:${need.length} 题需要重写(批注式或要点过少:${need.map((q) => q.id).join('、')})`
  );
  let repaired = 0;
  for (const q of need) {
    if (ctx.signal?.aborted) throw new Error('已取消');
    const ex = q.代码依据
      .map((c) => excerpts.get(`${q.id}|${c.file}|${c.lines}`) ?? '')
      .filter(Boolean)
      .join('\n\n');
    const material = stage2PointsRepairUser(q.question, q.答案要点, ex, q.对比 ? JSON.stringify(q.对比) : '');
    const key = cache.key('points-repair', PROMPT_VERSION, STAGE2_POINTS_REPAIR_SYSTEM, q.id, material);
    const tryApply = (text: string): boolean => {
      try {
        const parsed = parseJsonLoose<{ 答案要点?: unknown }>(text);
        const pts = Array.isArray(parsed?.答案要点) ? parsed.答案要点.map(String).filter((s) => s.trim()) : [];
        if (pts.length < 3 || pts.some((p) => META_POINT_RE.test(p))) return false;
        q.答案要点 = pts;
        return true;
      } catch {
        return false;
      }
    };
    let raw = cache.get<string>(key);
    if (typeof raw === 'string' && tryApply(raw)) {
      repaired++;
      continue;
    }
    try {
      let applied = false;
      for (let a = 0; a < 2 && !applied; a++) {
        raw = await client.chat(
          [
            { role: 'system', content: STAGE2_POINTS_REPAIR_SYSTEM },
            { role: 'user', content: material },
          ],
          { temperature: a === 0 ? 0.3 : 0.5, jsonMode: true, maxTokens: 3000, signal: ctx.signal }
        );
        if (tryApply(raw)) {
          cache.set(key, raw);
          repaired++;
          applied = true;
        }
      }
      if (!applied) warn(`  [警告] ${q.id} 重写后的要点仍含元话语或过短(已重试),放弃`);
    } catch (err) {
      if (String(err instanceof Error ? err.message : err) === '已取消') throw err;
      warn(`  [警告] ${q.id} 答案要点重写失败:${err instanceof Error ? err.message : err}`);
    }
  }
  if (repaired) {
    fs.writeFileSync(path.join(outDir, 'questions.json'), JSON.stringify(questions, null, 2), 'utf-8');
    log(`  答案要点实质化完成:${repaired} 题 → questions.json`);
  }
  return repaired;
}

/**
 * 阶段 3.5:标红题答案重写。阶段 3 判定"答案与代码事实矛盾"的题带 verified='flag'
 * 和写明矛盾所在的 verifyNote,但原错误主答案仍留在题库里——只标红不闭环。
 * 此环以 verifyNote 为权威结论 + 代码原文,重写主答案。
 * 闭环约束(审计 R-4):
 * - 无代码依据的题不重写(没有可核对的事实锚点,保留 flag 供人工复核)
 * - 原始裁决保留在 verifyNote 里(不被"已改正"覆盖到无迹可寻)
 * - 重写只把状态升到 fix;校验报告由 runner 在本环之后统一重算
 */
export async function rewriteFlaggedAnswers(
  client: DeepSeekClient,
  cache: DiskCache,
  facts: RepoFacts,
  questions: Question[],
  outDir: string,
  ctx: StageRunContext = {}
): Promise<number> {
  const need = questions.filter((q) => q.verified === 'flag' && q.verifyNote && q.代码依据.length > 0);
  const skippedNoCite = questions.filter((q) => q.verified === 'flag' && q.代码依据.length === 0).length;
  if (skippedNoCite) {
    warn(`  [注意] ${skippedNoCite} 道标红题无代码依据,无法自动重写(保留 ⚠️ 供人工复核)`);
  }
  if (!need.length) return 0;
  const { excerpts } = deterministicCheck(facts, questions);
  log(`  标红题重写:${need.length} 题(以校验结论改正主答案:${need.map((q) => q.id).join('、')})`);
  let repaired = 0;
  for (const q of need) {
    if (ctx.signal?.aborted) throw new Error('已取消');
    const ex = q.代码依据
      .map((c) => excerpts.get(`${q.id}|${c.file}|${c.lines}`) ?? '')
      .filter(Boolean)
      .join('\n\n');
    // 模板与 docs/prompts/03b 存档同源(prompts.ts),缓存键基于最终字符串,逐字节不变
    const material = stage2FlagRewriteUser(q.question, q.答案要点, q.verifyNote ?? '', ex.slice(0, 8000));
    const key = cache.key('flag-rewrite', PROMPT_VERSION, STAGE2_FLAG_REWRITE_SYSTEM, q.id, material);
    const origNote = q.verifyNote ?? '';
    const tryApply = (text: string): boolean => {
      try {
        const parsed = parseJsonLoose<{ 答案要点?: unknown }>(text);
        const pts = Array.isArray(parsed?.答案要点) ? parsed.答案要点.map(String).filter((s) => s.trim()) : [];
        if (pts.length < 3 || pts.length > 6 || pts.some((p) => META_POINT_RE.test(p))) return false;
        q.答案要点 = pts;
        return true;
      } catch {
        return false;
      }
    };
    const applyResult = (): void => {
      q.verified = 'fix';
      q.verifyNote = `原标红:${origNote} → 已按校验结论重写主答案(如仍存疑请人工复核)`;
      repaired++;
    };
    let raw = cache.get<string>(key);
    if (typeof raw === 'string' && tryApply(raw)) {
      applyResult();
      continue;
    }
    try {
      let applied = false;
      for (let a = 0; a < 2 && !applied; a++) {
        raw = await client.chat(
          [
            { role: 'system', content: STAGE2_FLAG_REWRITE_SYSTEM },
            { role: 'user', content: material },
          ],
          { temperature: 0.2, jsonMode: true, maxTokens: 3000, signal: ctx.signal }
        );
        if (tryApply(raw)) {
          cache.set(key, raw);
          applyResult();
          applied = true;
        }
      }
      if (!applied) warn(`  [警告] ${q.id} 标红重写未通过形状校验(保留 ⚠️ 标记供人工复核)`);
    } catch (err) {
      if (String(err instanceof Error ? err.message : err) === '已取消') throw err;
      warn(`  [警告] ${q.id} 标红重写失败:${err instanceof Error ? err.message : err}`);
    }
  }
  if (repaired) {
    fs.writeFileSync(path.join(outDir, 'questions.json'), JSON.stringify(questions, null, 2), 'utf-8');
    log(`  标红题重写完成:${repaired} 题 → questions.json`);
  }
  return repaired;
}
