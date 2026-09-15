import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AppConfig, loadConfig, toolRootDir } from './config';
import { DeepSeekClient } from './deepseek';
import { profileRepo } from './profiler';
import { loadChunks } from './chunker';
import { DiskCache } from './cache';
import { totalQuota, trimToQuotaDetailed } from './coverage';
import { Question, isValidComparison } from './schemas';
import { log, warn } from './logger';
import { runStage1, StageRunContext } from '../stages/stage1Read';
import { runStage2, repairComparisons, repairAnnotationAnswers, rewriteFlaggedAnswers, resetVerifyCheckpoint } from '../stages/stage2Questions';
import { runStage3, sanitizeCitations, writeVerifyReport } from '../stages/stage3Verify';
import { runStage4, JdAnalysis } from '../stages/stage4JD';
import { runStage5 } from '../stages/stage5Assemble';
import { runEvaluation } from '../stages/evaluate';

/** 阶段事件(0.4.0):供宿主渲染"时间轴 + 节点用时"进度 UI */
export interface StageEvent {
  id: 'profile' | 'read' | 'questions' | 'verify' | 'rewrite' | 'jd' | 'assemble' | 'done';
  label: string;
  status: 'start' | 'done' | 'cached' | 'skip';
  /** done/cached/skip 时携带该阶段用时 */
  elapsedMs?: number;
  note?: string;
}

export interface RunOptions {
  repoPath: string;
  jdPath?: string;
  outDir?: string;
  force?: boolean;
  maxFiles?: number;
  /** VSCode 扩展等宿主可通过它接收阶段进度 */
  onProgress?: (msg: string) => void;
  /** 结构化阶段事件:start/done/cached/skip + 用时(扩展侧栏时间轴用) */
  onStage?: (e: StageEvent) => void;
  /** 用户取消信号:贯穿所有阶段的请求与阶段边界 */
  abort?: AbortSignal;
  /** 宿主类型:影响完成后的下一步提示(vscode 用户没有 dist/cli) */
  host?: 'cli' | 'vscode';
  /** 宿主显式传入的配置(扩展场景:不经过 process.env,一次运行一套配置) */
  config?: AppConfig;
}

interface StageRecord {
  hash: string;
  at: string;
}
interface PipelineState {
  stages: Record<string, StageRecord>;
}

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

const sha1 = (s: string): string => crypto.createHash('sha1').update(s).digest('hex');
const hashFile = (p: string): string => {
  try {
    return sha1(fs.readFileSync(p, 'utf-8'));
  } catch {
    return 'ERR';
  }
};

/* ---------------- 运行锁:同目录同时只允许一条管线(审计 R-7/R-8) ---------------- */

const inFlight = new Map<string, Promise<unknown>>();
/** 锁文件最长存活时间:超时视为上次运行已死(进程被杀没机会清理) */
const LOCK_STALE_MS = 45 * 60 * 1000;

async function withRunLock<T>(outDir: string, fn: () => Promise<T>): Promise<T> {
  const prev = inFlight.get(outDir);
  if (prev) throw new Error('该目录已有生成任务正在进行中(本会话),请等待完成或使用其他输出目录');
  const lockPath = path.join(outDir, '.run-lock');
  try {
    if (fs.existsSync(lockPath)) {
      const info = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as { pid: number; at: number };
      const stale = Date.now() - info.at > LOCK_STALE_MS;
      const sameProcess = info.pid === process.pid;
      if (!stale && !sameProcess) {
        throw new Error(
          `该目录已有生成任务在运行(开始于 ${new Date(info.at).toLocaleString()},PID ${info.pid})。` +
            `若确认没有任务在跑,可删除 ${lockPath} 后重试`
        );
      }
    }
  } catch (err) {
    if (err instanceof Error && !/该目录已有生成任务/.test(err.message)) {
      /* 坏锁文件按无锁处理 */
    } else {
      throw err;
    }
  }
  const p = (async () => {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf-8');
    try {
      return await fn();
    } finally {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* 清理失败不影响结果 */
      }
    }
  })();
  inFlight.set(outDir, p);
  try {
    return await p;
  } finally {
    inFlight.delete(outDir);
  }
}

function readStateSafe(statePath: string): PipelineState {
  try {
    const s = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    if (s && typeof s === 'object' && s.stages && typeof s.stages === 'object') return s as PipelineState;
  } catch {
    /* 坏 state.json 按全新状态处理 */
  }
  return { stages: {} };
}

function fmtElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

/**
 * 完整管线编排:画像 → 精读 → 出题 → 校验 → (JD) → 总装。
 * 阶段门控:state.json 记录每阶段输入哈希,未变化的阶段直接跳过(省钱省时)。
 * 哈希基于内容(审计 R-1):等长改码、重出题、改答案都会正确失效;
 * 画像哈希含文件清单 + 精读文件内容哈希(增删文件、改精读文件都会刷新)。
 */
export async function runPipeline(opts: RunOptions): Promise<{ outDir: string }> {
  const root = path.resolve(opts.repoPath);
  if (!fs.existsSync(root)) throw new Error(`仓库路径不存在:${root}`);
  const outDir = path.resolve(opts.outDir ?? path.join(root, 'interview-output'));
  const cacheDir = path.join(outDir, '.cache');
  fs.mkdirSync(outDir, { recursive: true });

  const startedAt = Date.now();
  const stageStart = { at: Date.now(), name: '' };
  const banner = (t: string) => {
    if (stageStart.name) log(`  (${stageStart.name} 用时 ${fmtElapsed(Date.now() - stageStart.at)})`);
    stageStart.at = Date.now();
    stageStart.name = t;
    log(`\n========== ${t} ==========`);
    opts.onProgress?.(t);
  };

  // 结构化阶段事件(宿主时间轴):start 记锚点,done/cached 携带锚点以来的用时
  let curStage: { id: StageEvent['id']; at: number } | null = null;
  const stageBegin = (id: StageEvent['id'], label: string) => {
    curStage = { id, at: Date.now() };
    opts.onStage?.({ id, label, status: 'start' });
  };
  const stageEnd = (id: StageEvent['id'], label: string, status: 'done' | 'cached' | 'skip', note?: string) => {
    const elapsedMs = curStage?.id === id ? Date.now() - curStage.at : undefined;
    if (curStage?.id === id) curStage = null;
    opts.onStage?.({ id, label, status, elapsedMs, note });
  };

  const cfg =
    opts.config ??
    loadConfig({ trustedDirs: [process.cwd(), toolRootDir()], repoDir: root });
  log(`  [配置] 模型 ${cfg.model} · 端点 ${cfg.baseUrl.replace(/^https?:\/\//, '')} · 密钥来源 ${cfg.sources.apiKey}`);
  const client = new DeepSeekClient(cfg);
  const cache = new DiskCache(cacheDir);
  const maxFiles = opts.maxFiles ?? 40;
  const ctx: StageRunContext = { signal: opts.abort };

  const statePath = path.join(outDir, 'state.json');
  const state = readStateSafe(statePath);
  const saveState = (name: string, hash: string) => {
    state.stages[name] = { hash, at: new Date().toISOString() };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
  };
  const stageDone = (name: string, hash: string): boolean =>
    !opts.force && state.stages[name]?.hash === hash;

  return withRunLock(outDir, async () => {
    /* ---------- 阶段 0:画像(无 LLM) ---------- */
    banner('阶段 0:仓库画像(确定性,无 LLM)');
    stageBegin('profile', '仓库画像');
    const cachedFactsPath = path.join(outDir, 'repo_facts.json');
    // 画像输入哈希种子 = maxFiles + 根路径 + 文件清单 + 精读文件内容哈希。
    // 门控检查时用缓存画像构造同一种子;重新画像后用新画像构造同一公式落盘——两侧同构。
    const p0SeedFrom = (files: string[], readingPlan: string[]): string =>
      `v3|${maxFiles}|${root}|${sha1(JSON.stringify(files))}|${readingPlan.map((f) => `${f}:${hashFile(path.join(root, f))}`).join('|')}`;
    let gateSeed: string | null = null;
    if (fs.existsSync(cachedFactsPath)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cachedFactsPath, 'utf-8'));
        if (Array.isArray(cached.files) && Array.isArray(cached.readingPlan)) {
          gateSeed = p0SeedFrom(cached.files, cached.readingPlan);
        }
      } catch {
        /* 坏缓存画像按首跑处理 */
      }
    }
    let facts;
    let profileCached = false;
    if (gateSeed !== null && stageDone('profile', shortHash(gateSeed))) {
      facts = JSON.parse(fs.readFileSync(cachedFactsPath, 'utf-8'));
      profileCached = true;
      log(`  [门控命中] 画像未变化,直接复用(${facts.overview.totalFiles} 文件 / ${facts.overview.totalLOC} 行)`);
    } else {
      facts = profileRepo(root, maxFiles);
      fs.writeFileSync(cachedFactsPath, JSON.stringify(facts, null, 2), 'utf-8');
      saveState('profile', shortHash(p0SeedFrom(facts.files, facts.readingPlan)));
    }
    if (facts.skippedSensitive?.length) {
      warn(`  [安全] 已跳过 ${facts.skippedSensitive.length} 个敏感文件(不发给模型):${facts.skippedSensitive.slice(0, 5).join('、')}${facts.skippedSensitive.length > 5 ? ' …' : ''}`);
    }
    log(
      `  ${facts.overview.totalFiles} 文件 / ${facts.overview.totalLOC} 行 | 路由 ${facts.routes.length} | 表 ${facts.dbTables.length} | 热点 ${facts.hotspots.length} | 有趣代码 ${facts.interestingFiles.length}`
    );
    log(`  精读清单(${facts.readingPlan.length} 个文件):${facts.readingPlan.slice(0, 8).join('、')}${facts.readingPlan.length > 8 ? ' …' : ''}`);

    /* ---------- 分块 ---------- */
    const { chunks, truncated, skipped: skippedChunks } = loadChunks(root, facts.readingPlan);
    if (truncated.length) warn(`  [注意] 以下文件只读取了前几块:${truncated.join('、')}`);
    if (skippedChunks.length) warn(`  [注意] 以下文件读取失败被跳过:${skippedChunks.join('、')}`);
    log(`  分块完成:${chunks.length} 块`);
    stageEnd(
      'profile', '仓库画像',
      profileCached ? 'cached' : 'done',
      profileCached ? '门控命中,复用上次画像' : `${facts.overview.totalFiles} 文件 / ${facts.readingPlan.length} 个精读文件 / ${chunks.length} 块`
    );

    /* ---------- 阶段 1:精读 ---------- */
    banner('阶段 1:模块精读(DeepSeek)');
    stageBegin('read', '模块精读');
    const overviewJsonHash = sha1(JSON.stringify(facts.overview));
    const chunksHash = sha1(chunks.map((c) => `${c.file}:${c.startLine}-${c.endLine}:${c.content}`).join('||'));
    const s1Hash = shortHash(`v2|${overviewJsonHash}|${chunksHash}|${cfg.model}`);
    let cards, knowledge;
    let readCached = false;
    if (stageDone('read', s1Hash)) {
      cards = JSON.parse(fs.readFileSync(path.join(outDir, 'module_cards.json'), 'utf-8'));
      knowledge = JSON.parse(fs.readFileSync(path.join(outDir, 'knowledge.json'), 'utf-8'));
      readCached = true;
      log('  [门控命中] 模块卡未变化,直接复用');
    } else {
      ({ cards, knowledge } = await runStage1(client, cache, facts, chunks, ctx));
      fs.writeFileSync(path.join(outDir, 'module_cards.json'), JSON.stringify(cards, null, 2), 'utf-8');
      fs.writeFileSync(path.join(outDir, 'knowledge.json'), JSON.stringify(knowledge, null, 2), 'utf-8');
      saveState('read', s1Hash);
    }
    log(`  模块卡 ${cards.length} 张 | 定位:${knowledge.一句话定位}`);
    stageEnd('read', '模块精读', readCached ? 'cached' : 'done', readCached ? '门控命中,复用模块卡' : `${cards.length} 张模块卡`);

    /* ---------- 阶段 2:出题 ---------- */
    banner('阶段 2:覆盖矩阵出题(100 题)');
    stageBegin('questions', '出题(含修复环)');
    const qPath = path.join(outDir, 'questions.json');
    const s2Hash = shortHash(`v2|${s1Hash}|${sha1(JSON.stringify(cards))}|${sha1(JSON.stringify(knowledge))}|${cfg.model}`);
    let questions: Question[];
    let questionsReused = false;
    if (stageDone('questions', s2Hash) && fs.existsSync(qPath)) {
      questions = JSON.parse(fs.readFileSync(qPath, 'utf-8'));
      questionsReused = true;
      log(`  [门控命中] 题库已存在(${questions.length} 题),直接复用`);
    } else {
      questions = await runStage2(client, cache, facts, cards, knowledge, chunks, outDir, ctx);
      saveState('questions', s2Hash);
    }
    // 规范化:恰好 100 题(补题救回重复槽位时可能超);未知类别/超配额裁剪并透明化
    if (questions.length !== totalQuota()) {
      const { keep, droppedUnknownCategory, droppedOverQuota } = trimToQuotaDetailed(questions);
      if (keep.length !== questions.length || droppedUnknownCategory || droppedOverQuota) {
        warn(
          `  规范化:${questions.length} → ${keep.length} 题(按配额裁剪` +
            (droppedUnknownCategory ? `,其中 ${droppedUnknownCategory} 题类别不在矩阵内` : '') +
            (droppedOverQuota ? `,${droppedOverQuota} 题超配额` : '') + ')'
        );
      }
      questions = keep;
      fs.writeFileSync(qPath, JSON.stringify(questions, null, 2), 'utf-8');
    }
    // 规范化:剥掉形状不合格的对比块(空对象/缺行表会让渲染退化),保持数据诚实
    let strippedCmp = 0;
    for (const q of questions) {
      if (q.对比 && !isValidComparison(q.对比)) {
        delete q.对比;
        strippedCmp++;
      }
    }
    if (strippedCmp) {
      log(`  规范化:剥除 ${strippedCmp} 个不合格对比块`);
      fs.writeFileSync(qPath, JSON.stringify(questions, null, 2), 'utf-8');
    }

    /* ---------- 阶段 2.5:对比块补齐(凡选型必对比,硬约束兜底) ---------- */
    await repairComparisons(client, cache, facts, questions, outDir, ctx);
    /* ---------- 阶段 2.6:答案要点实质化(校订批注式要点重写) ---------- */
    await repairAnnotationAnswers(client, cache, facts, questions, outDir, ctx);
    /* ---------- 阶段 2.7:引用消毒(越界截断/坏引用删除,确定性) ---------- */
    const sanitized = sanitizeCitations(facts, questions);
    if (sanitized) {
      log(`  引用消毒:修正 ${sanitized} 处坏引用`);
      fs.writeFileSync(qPath, JSON.stringify(questions, null, 2), 'utf-8');
    }
    stageEnd('questions', '出题(含修复环)', 'done', questionsReused ? `题目复用+修复环增量,共 ${questions.length} 题` : `共 ${questions.length} 题`);

    /* ---------- 阶段 3:对抗校验 ---------- */
    banner('阶段 3:对抗校验(反幻觉)');
    stageBegin('verify', '对抗校验');
    // 哈希基于题目全文+分块+提示词+模型(题号恒为 Q01..Q100,旧的"只看 ID"会被全新题库整体绕过)
    const questionsHash = (qs: Question[]) =>
      sha1(qs.map((q) => JSON.stringify([q.id, q.question, q.答案要点, q.代码依据, q.对比 ?? null])).join('||'));
    const s3HashOf = () =>
      shortHash(`v3|${questionsHash(questions)}|${chunksHash}|${cfg.model}`);
    if (stageDone('verify', s3HashOf())) {
      log('  [门控命中] 校验结果已存在,直接复用');
      stageEnd('verify', '对抗校验', 'cached', '门控命中,复用校验结果');
    } else {
      const stats = await runStage3(client, facts, questions, outDir, ctx);
      stageEnd('verify', '对抗校验', 'done', `pass ${stats.pass} · fix ${stats.fix} · flag ${stats.flag} · 未覆盖 ${stats.unverified}`);
      if (stats.unverified > 0) {
        // 有未覆盖题:不记阶段完成,下次重跑自动补验
        warn(`  [注意] ${stats.unverified} 题未完成对抗校验(unverified),本阶段未记完成,下次运行将自动补验`);
      } else {
        saveState('verify', s3HashOf());
      }
    }

    /* ---------- 阶段 3.5:标红题答案重写(反幻觉闭环) ---------- */
    stageBegin('rewrite', '标红题重写');
    await rewriteFlaggedAnswers(client, cache, facts, questions, outDir, ctx);
    // 重写改变了题目内容 → 校验报告按最终题库重算(此前三处状态不一致)
    writeVerifyReport(
      questions,
      outDir,
      {
        total: questions.length,
        pass: questions.filter((q) => q.verified === 'pass').length,
        fix: questions.filter((q) => q.verified === 'fix').length,
        flag: questions.filter((q) => q.verified === 'flag').length,
        unverified: questions.filter((q) => q.verified === 'unverified').length,
        deterministicIssues: 0,
      }
    );
    stageEnd('rewrite', '标红题重写', 'done', `${questions.filter((q) => q.verified === 'flag').length} 题仍标红(需人工复核)`);

    /* ---------- 阶段 4:JD 加权(可选) ---------- */
    let jd: JdAnalysis | undefined;
    if (opts.jdPath) {
      banner('阶段 4:岗位描述加权');
      stageBegin('jd', 'JD 加权');
      const jdFile = path.resolve(opts.jdPath);
      if (!fs.existsSync(jdFile)) throw new Error(`JD 文件不存在:${jdFile}`);
      const jdText = fs.readFileSync(jdFile, 'utf-8');
      jd = await runStage4(client, cache, jdText, questions, outDir, ctx);
      // 必考标记落盘,保持 questions.json 与渲染产物一致
      fs.writeFileSync(qPath, JSON.stringify(questions, null, 2), 'utf-8');
      stageEnd('jd', 'JD 加权', 'done', '必考 Top20 已标记');
    } else {
      stageEnd('jd', 'JD 加权', 'skip', '未选择 JD 文件');
    }

    /* ---------- 阶段 5:总装 ---------- */
    banner('阶段 5:总装输出(MD 套件 + HTML 报告)');
    stageBegin('assemble', '总装输出');
    await runStage5(client, cache, facts, cards, knowledge, questions, outDir, jd, ctx);
    stageEnd('assemble', '总装输出', 'done', '01~06 Markdown + index.html');

    client.printUsage();
    if (stageStart.name) log(`  (${stageStart.name} 用时 ${fmtElapsed(Date.now() - stageStart.at)})`);
    banner('完成');
    opts.onStage?.({ id: 'done', label: '完成', status: 'done', elapsedMs: Date.now() - startedAt, note: `产物目录 ${outDir}` });
    log(`产物目录:${outDir}`);
    log(`总耗时 ${fmtElapsed(Date.now() - startedAt)}`);
    if (opts.host === 'vscode') {
      log('下一步:点右上角「打开报告」,或命令面板运行「代码转面试:打开面试报告」');
    } else {
      log('下一步:');
      log('  1. 浏览器打开 index.html(可搜索/隐藏答案自测/掌握度统计)');
      log(`  2. 排练:node dist/cli/index.js rehearse "${outDir}" --count 5`);
      log(`  3. 自评:node dist/cli/index.js evaluate "${outDir}"`);
    }
    return { outDir };
  });
}

/** 只跑自评环:对已有产物打分 */
export async function runEvaluationOnly(outDir: string, abort?: AbortSignal): Promise<void> {
  const resolved = path.resolve(outDir);
  // 受信目录 = cwd 与工具根;被分析仓库 = 产物目录的父目录(产物默认在 <仓库>/interview-output)
  const cfg = loadConfig({ trustedDirs: [process.cwd(), toolRootDir()], repoDir: path.dirname(resolved) });
  const client = new DeepSeekClient(cfg);
  await runEvaluation(client, resolved, { signal: abort });
  client.printUsage();
}

/** 删除遗留的校验断点(供 CLI/测试使用;题库重生成时 runStage2 内部也会自动清) */
export { resetVerifyCheckpoint };
