import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { DeepSeekClient, parseJsonLoose } from '../core/deepseek';
import { Question } from '../core/schemas';
import { STAGE6_SCORE_SYSTEM, stage6ScoreUser } from '../core/prompts';
import { log, warn } from '../core/logger';
import { RunMode } from '../core/policy';

export interface RehearseOptions {
  outDir: string;
  client: DeepSeekClient;
  count?: number;
  category?: string;
  top20?: boolean;
  mode?: RunMode;
}

interface RehearsalState {
  scores: Record<string, number>;
  catStats: Record<string, { sum: number; n: number }>;
}

/** 评分钳制:0-10 有限数;非法值返回 null(不记 0 分污染弱项排序) */
function clampScore(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(10, n));
}

/** 阶段 6:终端模拟面试。必考优先、弱项类别优先;评分/追问/弱项记录。
 * 持久化策略:每答完一题立刻保存状态并追加排练记录——中途 Ctrl+C / 崩溃不再丢整轮成绩。 */
export async function runRehearsal(opts: RehearseOptions): Promise<void> {
  const qPath = path.join(opts.outDir, 'questions.json');
  if (!fs.existsSync(qPath)) {
    throw new Error(`未找到 ${qPath},请先运行 generate 生成题库`);
  }
  let questions: Question[];
  try {
    questions = JSON.parse(fs.readFileSync(qPath, 'utf-8'));
  } catch (err) {
    throw new Error(`questions.json 不是合法 JSON(${err instanceof Error ? err.message : err}),请重新 generate`);
  }
  if (opts.top20) questions = questions.filter((q) => q.必考);
  if (opts.category) questions = questions.filter((q) => q.category === opts.category);
  if (!questions.length) throw new Error('按当前筛选条件没有题目(可去掉 --top20/--category 试试)');

  const statePath = path.join(opts.outDir, 'rehearsal-state.json');
  let state: RehearsalState = { scores: {}, catStats: {} };
  if (fs.existsSync(statePath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      if (saved && typeof saved === 'object') {
        state = { scores: saved.scores ?? {}, catStats: saved.catStats ?? {} };
      }
    } catch {
      warn('  [警告] rehearsal-state.json 损坏,从空状态开始');
    }
  }
  const persistState = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
  const recordPath = path.join(opts.outDir, '排练记录.md');
  const stamp = new Date().toLocaleString('zh-CN');
  fs.appendFileSync(recordPath, `\n## 排练记录 ${stamp}\n\n`, 'utf-8');
  const appendRecord = (line: string) => fs.appendFileSync(recordPath, line + '\n', 'utf-8');

  // 排序:必考优先 → 历史均分低的类别优先(弱项) → 未作答优先
  const weakScore = (q: Question) => {
    const s = state.catStats[q.category];
    return s && s.n ? s.sum / s.n : 99;
  };
  const answered = (q: Question) => (state.scores[q.id] !== undefined ? 1 : 0);
  questions.sort(
    (a, b) =>
      Number(b.必考 ?? false) - Number(a.必考 ?? false) ||
      weakScore(a) - weakScore(b) ||
      answered(a) - answered(b)
  );

  const total = opts.count && opts.count > 0 ? Math.min(opts.count, questions.length) : questions.length;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (prompt: string) => new Promise<string>((res) => rl.question(prompt, res));

  log(`\n模拟面试开始:本次 ${total} 题(输入 :show 看参考要点 / :skip 跳过 / :quit 退出)`);
  log('提示:像真面试一样口述作答,再对照评分。\n');

  for (let i = 0; i < total; i++) {
    const q = questions[i];
    log(`\n===== 第 ${i + 1}/${total} 题 ${q.id} 〔${q.category}|${q.difficulty}〕${q.必考 ? '⭐必考 ' : ''}=====`);
    log(q.question);
    let answer = (await ask('\n你的回答 > ')).trim();
    if (answer === ':quit') break;
    // :show 可连续使用(此前第二次输 :show 会被当答案送评记 0 分)
    while (answer === ':show') {
      (q.答案要点 ?? []).forEach((a, idx) => log(`  要点${idx + 1}. ${a}`));
      answer = (await ask('你的回答 > ')).trim();
      if (answer === ':quit') break;
    }
    if (answer === ':quit') break;
    if (answer === ':skip') {
      appendRecord(`- ${q.id} 跳过:${q.question.slice(0, 50)}`);
      continue;
    }

    try {
      const raw = await opts.client.chat(
        [
          { role: 'system', content: STAGE6_SCORE_SYSTEM },
          { role: 'user', content: stage6ScoreUser(q, answer) },
        ],
        { requestType: 'stage6-rehearse', temperature: 0.1, jsonMode: true, maxTokens: 2000, hardMaxTokens: 3500, mode: opts.mode }
      );
      const r = parseJsonLoose<{
        score: number;
        strengths: string[];
        gaps: string[];
        followUp: string;
        modelAnswerDigest: string;
      }>(raw);
      const score = clampScore(r.score);
      if (score === null) {
        warn(`  [警告] 评分非法(返回 ${JSON.stringify(r.score)}),本题不计入统计;可重跑排练再试`);
        appendRecord(`- ${q.id} 评分解析失败(返回值非法),未计入统计`);
      } else {
        log(`\n评分:${score}/10`);
        (r.strengths ?? []).forEach((s) => log(`  + ${s}`));
        (r.gaps ?? []).forEach((g) => log(`  - 缺口:${g}`));
        log(`  ★ 参考答案浓缩:${r.modelAnswerDigest ?? ''}`);
        const cs = (state.catStats[q.category] ??= { sum: 0, n: 0 });
        cs.sum += score;
        cs.n += 1;
        state.scores[q.id] = score;
        persistState(); // 逐题落盘:中途退出不丢已答成绩
        appendRecord(
          `- ${q.id}(${q.category}|${q.difficulty})得分 ${score}/10;缺口:${(r.gaps ?? []).join(';') || '无'}`
        );
      }

      // 追问
      if (r.followUp) {
        log(`\n追问:${r.followUp}`);
        const fa = (await ask('回答追问(回车跳过) > ')).trim();
        if (fa && fa !== ':quit') {
          log('  (已记录你的追问回答,建议对照要点自查)');
          appendRecord(`  ↳ 追问:${r.followUp}\n    回答:${fa.slice(0, 120)}`);
        }
        if (fa === ':quit') break;
      }
    } catch (err) {
      warn(`  [警告] 评分失败,跳过该题记录:${err instanceof Error ? err.message : err}`);
    }
  }
  rl.close();

  const weakCats = Object.entries(state.catStats)
    .map(([cat, s]) => ({ cat, avg: s.sum / s.n, n: s.n }))
    .sort((a, b) => a.avg - b.avg)
    .slice(0, 3);
  appendRecord('');
  appendRecord(`**弱项类别 Top3:** ${weakCats.map((w) => `${w.cat}(均分 ${w.avg.toFixed(1)}/10,${w.n} 题)`).join('、') || '暂无'}`);
  appendRecord('');
  log(`\n本次排练结束。弱项:${weakCats.map((w) => w.cat).join('、') || '无'} → 已写入 排练记录.md`);
}
