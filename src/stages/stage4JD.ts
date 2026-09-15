import * as fs from 'fs';
import * as path from 'path';
import { DeepSeekClient, parseJsonLoose } from '../core/deepseek';
import { DiskCache, PROMPT_VERSION } from '../core/cache';
import { Question } from '../core/schemas';
import { STAGE4_JD_SYSTEM, stage4JdUser } from '../core/prompts';
import { StageRunContext } from './stage1Read';
import { log } from '../core/logger';

export interface JdAnalysis {
  关键词: string[];
  能力要求: string[];
  高相关主题: string[];
  必考ID: string[];
  开场白STAR: string;
  复述侧重: { 多讲: string[]; 少讲: string[] };
}

const strArr = (v: unknown): string[] => {
  // jsonMode 下常见漂移:字符串被输出成 "A、B" 而非数组。统一收敛成 string[]
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === 'string') {
    return v
      .split(/[、,;,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
};

/**
 * 形状收敛与校验(审计 R-6):
 * parseJsonLoose 只保证"是合法 JSON"。此前坏形状(关键词是字符串等)会先落缓存再在
 * 消费处 .map 崩溃,且 --force 不清 DiskCache → 每次重跑在同一行崩,必须手删缓存。
 * 现在:解析后先收敛形状,仍不合法则重生成,只有合格结果才允许进缓存。
 */
function normalizeJdAnalysis(raw: unknown): JdAnalysis | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const 复述侧重 = (typeof o.复述侧重 === 'object' && o.复述侧重 !== null ? o.复述侧重 : {}) as Record<string, unknown>;
  const analysis: JdAnalysis = {
    关键词: strArr(o.关键词),
    能力要求: strArr(o.能力要求),
    高相关主题: strArr(o.高相关主题),
    必考ID: strArr(o.必考ID),
    开场白STAR: typeof o.开场白STAR === 'string' ? o.开场白STAR : '',
    复述侧重: { 多讲: strArr(复述侧重.多讲), 少讲: strArr(复述侧重.少讲) },
  };
  const usable = analysis.关键词.length > 0 || analysis.必考ID.length > 0 || analysis.开场白STAR.length > 0;
  return usable ? analysis : null;
}

/** 阶段 4(可选):岗位描述 → 关键词映射 → 必考 Top20 + STAR 定制 */
export async function runStage4(
  client: DeepSeekClient,
  cache: DiskCache,
  jdText: string,
  questions: Question[],
  outDir: string,
  ctx: StageRunContext = {}
): Promise<JdAnalysis> {
  const list = questions
    .map((q) => `${q.id}|${q.category}|${q.difficulty}|${q.question.slice(0, 80)}`)
    .join('\n');

  // 缓存键含题库清单全文(此前只有长度:topup/修订后等长题库会复用旧匹配,必考标记错位)
  const key = cache.key('stage4', PROMPT_VERSION, jdText, list);
  let analysis = normalizeJdAnalysis(cache.get<unknown>(key));
  if (!analysis) {
    log('  分析岗位描述并重排 ...');
    const call = (temperature: number) =>
      client.chat(
        [
          { role: 'system', content: STAGE4_JD_SYSTEM },
          { role: 'user', content: stage4JdUser(jdText.slice(0, 6000), list) },
        ],
        { temperature, jsonMode: true, maxTokens: 6000, signal: ctx.signal }
      );
    // 最多两次:第一次形状漂移(常见于推理模型)时降温重试
    for (let attempt = 0; attempt < 2 && !analysis; attempt++) {
      analysis = normalizeJdAnalysis(parseJsonLoose(await call(attempt === 0 ? 0.3 : 0.2)));
    }
    if (!analysis) {
      throw new Error('JD 分析输出形状不合格(已重试),本次跳过 JD 加权;可重跑 generate 再试');
    }
    cache.set(key, analysis);
  }

  // 收紧:必考 ID 必须真实存在,且不超过 20
  const ids = new Set(questions.map((q) => q.id));
  const mustAsk = [...new Set(analysis.必考ID)].filter((id) => ids.has(id)).slice(0, 20);
  analysis.必考ID = mustAsk;
  for (const q of questions) q.必考 = mustAsk.includes(q.id);

  const md: string[] = [
    `# 岗位定制分析(JD 加权)`,
    ``,
    `## JD 关键词`,
    analysis.关键词.map((k) => `- ${k}`).join('\n') || '(无)',
    ``,
    `## 能力要求`,
    analysis.能力要求.map((k) => `- ${k}`).join('\n') || '(无)',
    ``,
    `## 必考 Top${mustAsk.length}`,
    mustAsk.map((id) => `- ${id}`).join('、') || '(无)',
    ``,
    `## 1 分钟开场白(STAR,按岗位定制)`,
    analysis.开场白STAR,
    ``,
    `## 复述侧重`,
    `### 多讲`,
    analysis.复述侧重.多讲.map((k) => `- ${k}`).join('\n') || '(无)',
    `### 少讲`,
    analysis.复述侧重.少讲.map((k) => `- ${k}`).join('\n') || '(无)',
    '',
  ];
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, '00_JD定制分析.md'), md.join('\n'), 'utf-8');
  log(`  必考 Top${mustAsk.length} 已标记 → 00_JD定制分析.md`);
  return analysis;
}
