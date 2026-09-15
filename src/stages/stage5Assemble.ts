import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { DeepSeekClient } from '../core/deepseek';
import { RepoFacts } from '../core/profiler';
import { DiskCache, PROMPT_VERSION } from '../core/cache';
import { ModuleCard, ProjectKnowledge, Question } from '../core/schemas';
import {
  STAGE5_NARRATIVE_SYSTEM,
  STAGE5_HIGHLIGHTS_SYSTEM,
  STAGE5_WEAKNESS_SYSTEM,
  STAGE5_DECISIONS_SYSTEM,
} from '../core/prompts';
import { renderHtml } from '../report/htmlReport';
import { JdAnalysis } from './stage4JD';
import { StageRunContext } from './stage1Read';
import { log } from '../core/logger';

/** Markdown 表格单元格清洗:| 会拆列、换行会断行(LLM 输出里 a || b、O(n|V|) 很常见) */
export function sanitizeMdCell(s: unknown): string {
  return String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/** 单行文本清洗(标题/行内字段):换行拆散结构,反引号破坏内联代码 */
function sanitizeMdInline(s: unknown): string {
  return String(s ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/`/g, "'")
    .trim();
}

/** LLM 叙述稿常自带一级标题,包装时剥掉避免与文件标题重复 */
function stripLeadingH1(md: string): string {
  return md.replace(/^\s*#\s+[^\n]*\n+/, '');
}

/** 占位符兜底:把 <待填>/TODO 类标记替换为诚实表述(面试材料不允许出现占位符) */
function scrubPlaceholders(md: string): string {
  return md
    .replace(/[<＜〔【]\s*待填\s*[>＞〕】]/g, '(暂无可信数据,不编造)')
    .replace(/待填/g, '(暂无可信数据)')
    .replace(/\b(TODO|TBD)\b/g, '(待补充)');
}

function materialForNarrative(knowledge: ProjectKnowledge, cards: ModuleCard[], facts: RepoFacts): string {
  return `# 项目知识卡
${JSON.stringify(knowledge, null, 1)}

# 模块理解卡
${cards
  .map((c) =>
    JSON.stringify(
      { name: c.name, 职责: c.职责, 关键实现: c.关键实现.slice(0, 5), 设计决策: c.设计决策, 亮点: c.亮点.slice(0, 4), 缺点: c.缺点.slice(0, 3) },
      null,
      1
    )
  )
  .join('\n\n')}

# 测试证据(静态统计,可直接引用,禁止夸大)
${JSON.stringify(facts.testEvidence, null, 1)}`;
}

async function generateMarkdown(
  client: DeepSeekClient,
  cache: DiskCache,
  cacheNs: string,
  system: string,
  material: string,
  maxTokens = 8000,
  signal?: AbortSignal
): Promise<string> {
  // 键包含 system 全文:提示词任何改动立即失效旧缓存(length 相同的微调也会失效)
  const key = cache.key(cacheNs, PROMPT_VERSION, system, material);
  const cached = cache.get<string>(key);
  if (cached) {
    log(`  [缓存] ${cacheNs}`);
    return cached;
  }
  const raw = await client.chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: material },
    ],
    { temperature: 0.4, maxTokens, signal }
  );
  cache.set(key, raw);
  return raw;
}

function comparisonTableMd(q: Question): string[] {
  const cmp = q.对比!;
  const dims = Array.isArray(cmp.维度) ? cmp.维度 : [];
  const rows = Array.isArray(cmp.对比表) ? cmp.对比表 : [];
  const width = Math.max(dims.length + 1, ...(rows.length ? rows.map((r) => r.length) : [1]));
  const header = `| 方案 | ${dims.map(sanitizeMdCell).join(' | ')} |`;
  const sep = `|${Array(width).fill('---').join('|')}|`;
  const body = rows.map((r) => `| ${Array.from({ length: width }, (_, i) => sanitizeMdCell(r[i] ?? '')).join(' | ')} |`);
  return [header, sep, ...body, '', `**结论:** ${sanitizeMdCell(cmp.结论 ?? '')}`, ''];
}

function questionMd(q: Question): string[] {
  const lines: string[] = [];
  lines.push(`### ${q.id}〔${q.difficulty}〕${q.必考 ? '⭐必考 ' : ''}${sanitizeMdInline(q.question)}`);
  lines.push('');
  lines.push(`- 考察点:${sanitizeMdInline(q.考察点)}${q.target && q.target !== '项目整体' ? `(目标:${sanitizeMdInline(q.target)})` : ''}`);
  lines.push(`- 代码依据:${q.代码依据.map((c) => `\`${sanitizeMdInline(c.file)}:${c.lines}\``).join('、') || '(无)'}`);
  if (q.verified === 'flag') lines.push(`- ⚠️ 校验标红:${sanitizeMdInline(q.verifyNote ?? '存在代码无法支撑的主张,请人工复核')}`);
  lines.push('');
  lines.push('**答案要点:**');
  lines.push('');
  q.答案要点.forEach((a, i) => lines.push(`${i + 1}. ${sanitizeMdInline(a)}`));
  lines.push('');
  if (q.追问链.length) {
    lines.push(`**追问链:** ${q.追问链.map((f, i) => `${i + 1}) ${sanitizeMdInline(f)}`).join('  ')}`);
    lines.push('');
  }
  lines.push(`**加分回答:** ${sanitizeMdInline(q.加分回答)}`);
  lines.push('');
  lines.push(`**常见错误回答:** ${sanitizeMdInline(q.常见错误回答)}`);
  lines.push('');
  if (q.对比) {
    lines.push('**横向对比:**');
    lines.push('');
    lines.push(...comparisonTableMd(q));
  }
  return lines;
}

export interface Stage5Stats {
  pass: number;
  fix: number;
  flag: number;
}

export async function runStage5(
  client: DeepSeekClient,
  cache: DiskCache,
  facts: RepoFacts,
  cards: ModuleCard[],
  knowledge: ProjectKnowledge,
  questions: Question[],
  outDir: string,
  jd?: JdAnalysis,
  ctx: StageRunContext = {}
): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });
  const material = materialForNarrative(knowledge, cards, facts);

  // 四份叙述稿互不依赖,并行生成(推理模型单次分钟级,串行使总装时长 ×4)
  log('  并行生成《项目讲解》《亮点与防守》《缺点与改进》《设计决策与选型对比》...');
  const [narrative, highlights, weaknesses, decisions] = await Promise.all([
    generateMarkdown(client, cache, '05a-narrative', STAGE5_NARRATIVE_SYSTEM, material, 8000, ctx.signal),
    generateMarkdown(client, cache, '05b-highlights', STAGE5_HIGHLIGHTS_SYSTEM, material, 8000, ctx.signal),
    generateMarkdown(client, cache, '05c-weakness', STAGE5_WEAKNESS_SYSTEM, material, 8000, ctx.signal),
    generateMarkdown(client, cache, '05d-decisions', STAGE5_DECISIONS_SYSTEM, material, 8000, ctx.signal),
  ]);
  log('  四份叙述稿生成完毕');

  // 01 项目讲解 = LLM 叙述 + 仓库事实附录
  const factAppendix = [
    '',
    '---',
    '',
    '## 附:仓库事实速览(阶段 0 确定性产出)',
    '',
    `- 文件数 ${facts.overview.totalFiles} | 总行数 ${facts.overview.totalLOC}`,
    `- 语言分布:${Object.entries(facts.overview.languages)
      .sort((a, b) => b[1].loc - a[1].loc)
      .map(([ext, v]) => `${ext}(${v.loc}行)`)
      .join('、')}`,
    facts.routes.length ? `- 检测到路由 ${facts.routes.length} 条,如:${facts.routes.slice(0, 8).map((r) => `${r.method} ${r.route}`).join('、')}` : '',
    facts.dbTables.length ? `- 数据表:${facts.dbTables.map((t) => t.table).join('、')}` : '',
    facts.hotspots.length ? `- git 热点(改动最多):${facts.hotspots.slice(0, 5).map((h) => h.file).join('、')}` : '',
    facts.testEvidence.files.length
      ? `- 测试证据(静态统计):${facts.testEvidence.files.length} 个测试文件 / ${facts.testEvidence.testCount} 个用例 / ${facts.testEvidence.assertCount} 处断言`
      : '- 测试证据:未检测到测试文件',
    '',
  ]
    .filter(Boolean)
    .join('\n');
  fs.writeFileSync(
    path.join(outDir, '01_项目讲解.md'),
    `# 项目讲解\n\n${scrubPlaceholders(stripLeadingH1(narrative))}\n${factAppendix}\n`,
    'utf-8'
  );

  fs.writeFileSync(path.join(outDir, '03_亮点与防守.md'), `# 亮点与防守\n\n${scrubPlaceholders(stripLeadingH1(highlights))}\n`, 'utf-8');
  fs.writeFileSync(path.join(outDir, '04_缺点与改进.md'), `# 缺点与改进\n\n${scrubPlaceholders(stripLeadingH1(weaknesses))}\n`, 'utf-8');
  fs.writeFileSync(
    path.join(outDir, '05_设计决策与选型对比.md'),
    `# 设计决策与选型对比\n\n${scrubPlaceholders(stripLeadingH1(decisions))}\n`,
    'utf-8'
  );

  // 02 百问百答(确定性渲染,题目来自校验后的 questions.json)
  const byCategory = new Map<string, Question[]>();
  for (const q of questions) {
    const arr = byCategory.get(q.category) ?? [];
    arr.push(q);
    byCategory.set(q.category, arr);
  }
  const qaMd: string[] = [
    `# 百问百答(共 ${questions.length} 题)`,
    '',
    `> 每题带 代码依据(文件:行号),可直接在仓库检索验证;⚠️ 标红题见 校验报告.md。`,
    '',
    '## 目录',
    '',
    ...[...byCategory.entries()].map(([cat, arr]) => `- ${cat}(${arr.length} 题)`),
    '',
  ];
  for (const [cat, arr] of byCategory) {
    qaMd.push(`## ${cat}(${arr.length} 题)`, '');
    for (const q of arr) qaMd.push(...questionMd(q));
  }
  fs.writeFileSync(path.join(outDir, '02_百问百答.md'), qaMd.join('\n'), 'utf-8');

  // 06 速记卡(考前 30 分钟版)
  const mustFirst = [...questions].sort((a, b) => Number(b.必考 ?? false) - Number(a.必考 ?? false));
  const cram = mustFirst.slice(0, 30).map((q) => {
    const pts = q.答案要点.slice(0, 2).join(' / ');
    return `- **${q.id}** ${q.question.slice(0, 50)} → ${pts.slice(0, 120)}`;
  });
  fs.writeFileSync(
    path.join(outDir, '06_速记卡.md'),
    `# 速记卡(考前 30 分钟)${jd ? `\n\n必考题已置顶(来自 JD 加权)。` : ''}\n\n${cram.join('\n')}\n`,
    'utf-8'
  );

  // index.html(单文件可搜索报告)
  const pass = questions.filter((q) => q.verified === 'pass').length;
  const fix = questions.filter((q) => q.verified === 'fix').length;
  const flag = questions.filter((q) => q.verified === 'flag').length;
  const html = renderHtml({
    knowledge,
    questions,
    jd: jd
      ? { 开场白STAR: jd.开场白STAR, 必考ID: jd.必考ID, 复述侧重: jd.复述侧重, 关键词: jd.关键词 }
      : undefined,
    stats: { pass, fix, flag },
    model: client.model,
    generatedAt: new Date().toISOString(),
    // localStorage 命名空间:不同仓库的掌握状态不再互相串扰
    repoKey: crypto.createHash('sha1').update(facts.root).digest('hex').slice(0, 10),
  });
  fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf-8');
  log('  产物已写入:01~06 Markdown + index.html');
}
