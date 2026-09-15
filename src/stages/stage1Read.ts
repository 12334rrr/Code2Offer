import { DeepSeekClient, parseJsonLoose } from '../core/deepseek';
import { RepoFacts } from '../core/profiler';
import { Chunk, renderChunks } from '../core/chunker';
import { ModuleCard, ProjectKnowledge } from '../core/schemas';
import { DiskCache, PROMPT_VERSION } from '../core/cache';
import { log, warn } from '../core/logger';
import {
  STAGE1_MODULE_SYSTEM,
  STAGE1_SYNTHESIS_SYSTEM,
  stage1ModuleUser,
  stage1SynthesisUser,
} from '../core/prompts';

export interface Stage1Output {
  cards: ModuleCard[];
  knowledge: ProjectKnowledge;
  /** 被模块上限裁掉的分组名(透明化:此前第 13 个模块静默消失) */
  droppedModules: string[];
}

/** 阶段 1 并发度:模块卡相互独立,并发 3 显著缩短总时长(推理模型单次分钟级) */
const MODULE_CONCURRENCY = 3;

const MAX_MODULES = 12;

/** 按顶层目录分组为模块;(根目录) 单独一组。返回被上限裁掉的分组,交由调用方记录 */
export function groupByModule(chunks: Chunk[]): { modules: Array<{ name: string; chunks: Chunk[] }>; dropped: string[] } {
  const map = new Map<string, Chunk[]>();
  for (const c of chunks) {
    const top = c.file.includes('/') ? c.file.split('/')[0] : '(根目录)';
    const arr = map.get(top) ?? [];
    arr.push(c);
    map.set(top, arr);
  }
  const sorted = [...map.entries()]
    .map(([name, cs]) => ({ name, chunks: cs }))
    .sort((a, b) => {
      const size = (x: typeof a) => x.chunks.reduce((s, c) => s + c.endLine - c.startLine, 0);
      return size(b) - size(a);
    });
  return { modules: sorted.slice(0, MAX_MODULES), dropped: sorted.slice(MAX_MODULES).map((m) => m.name) };
}

function overviewDigest(facts: RepoFacts): string {
  const langs = Object.entries(facts.overview.languages)
    .sort((a, b) => b[1].loc - a[1].loc)
    .map(([ext, v]) => `${ext}:${v.files}个文件/${v.loc}行`)
    .join(', ');
  return JSON.stringify(
    {
      文件数: facts.overview.totalFiles,
      总行数: facts.overview.totalLOC,
      语言分布: langs,
      manifests: facts.overview.manifests,
      入口: facts.overview.entryPoints,
      路由: facts.routes.slice(0, 20),
      数据表: facts.dbTables.slice(0, 15),
      配置文件: facts.configFiles.slice(0, 10),
      git热点: facts.hotspots.slice(0, 10).map((h) => h.file),
      备注: facts.notes,
    },
    null,
    1
  );
}

function coerceCard(raw: unknown, fallbackName: string, files: string[]): ModuleCard {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, any>;
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter((s) => s.trim()) : []);
  return {
    name: typeof o.name === 'string' && o.name ? o.name : fallbackName,
    files: Array.isArray(o.files) && o.files.length ? o.files.map(String) : files,
    职责: String(o.职责 ?? ''),
    关键实现: Array.isArray(o.关键实现)
      ? o.关键实现.map((k: any) => ({
          file: String(k?.file ?? ''),
          lines: String(k?.lines ?? ''),
          name: String(k?.name ?? ''),
          说明: String(k?.说明 ?? ''),
        }))
      : [],
    设计决策: Array.isArray(o.设计决策)
      ? o.设计决策.map((d: any) => ({
          决策: String(d?.决策 ?? ''),
          备选方案: arr(d?.备选方案),
          选择理由: String(d?.选择理由 ?? ''),
          权衡: String(d?.权衡 ?? ''),
        }))
      : [],
    亮点: arr(o.亮点),
    缺点: arr(o.缺点),
    面试深挖点: arr(o.面试深挖点),
  };
}

/** 空卡判定:全部实质字段为空(模型返回 {} 或跑题输出),不能进缓存 */
function isEmptyCard(card: ModuleCard): boolean {
  return (
    !card.职责.trim() &&
    !card.关键实现.length &&
    !card.设计决策.length &&
    !card.亮点.length &&
    !card.缺点.length
  );
}

function coerceKnowledge(raw: unknown): ProjectKnowledge {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, any>;
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter((s) => s.trim()) : []);
  return {
    一句话定位: String(o.一句话定位 ?? ''),
    业务背景: String(o.业务背景 ?? ''),
    架构描述: String(o.架构描述 ?? ''),
    数据流: String(o.数据流 ?? ''),
    技术栈: Array.isArray(o.技术栈)
      ? o.技术栈.map((t: any) => ({
          领域: String(t?.领域 ?? ''),
          选型: String(t?.选型 ?? ''),
          备选: String(t?.备选 ?? ''),
          理由: String(t?.理由 ?? ''),
        }))
      : [],
    亮点: arr(o.亮点),
    缺点: arr(o.缺点),
  };
}

/** 知识卡降级兜底:两次解析都失败时用模块卡拼一份确定性摘要,不抛异常作废前两阶段花费 */
function fallbackKnowledge(cards: ModuleCard[]): ProjectKnowledge {
  const top = cards.slice(0, 4).map((c) => `${c.name}:${c.职责 || '(职责未解析)'}`).join(';');
  return {
    一句话定位: '(降级汇总)各模块:' + top,
    业务背景: '(知识卡解析失败,降级为模块摘要,建议重跑本阶段)',
    架构描述: cards.map((c) => `${c.name}(${c.files.length} 文件)`).join('、'),
    数据流: '(降级:暂无,以模块卡为准)',
    技术栈: [],
    亮点: cards.flatMap((c) => c.亮点.slice(0, 2)),
    缺点: cards.flatMap((c) => c.缺点.slice(0, 2)),
  };
}

/** 有界并发映射:保持输出顺序,便于缓存与对照 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface StageRunContext {
  /** 用户取消信号:阶段间与请求间检查 */
  signal?: AbortSignal;
}

export async function runStage1(
  client: DeepSeekClient,
  cache: DiskCache,
  facts: RepoFacts,
  chunks: Chunk[],
  ctx: StageRunContext = {}
): Promise<Stage1Output> {
  const overviewJson = overviewDigest(facts);
  const { modules, dropped } = groupByModule(chunks);
  log(`  模块分组:${modules.map((m) => `${m.name}(${m.chunks.length}块)`).join('、')}`);
  if (dropped.length) {
    warn(`  [注意] 模块数超过 ${MAX_MODULES},以下分组未精读(可提高 --max-files):${dropped.join('、')}`);
  }

  const cards = await mapLimit(modules, MODULE_CONCURRENCY, async (mod) => {
    const chunkText = renderChunks(mod.chunks);
    const files = [...new Set(mod.chunks.map((c) => c.file))];
    // 缓存键含 overviewJson(prompt 的组成部分):改未精读文件使画像变化后,旧模块卡不再错误命中
    const key = cache.key('stage1', PROMPT_VERSION, mod.name, overviewJson, chunkText);
    const cached = cache.get<ModuleCard>(key);
    if (cached && !isEmptyCard(cached)) {
      log(`  [缓存] 模块 ${mod.name}`);
      return cached;
    }
    log(`  精读模块:${mod.name} ...`);
    const call = (temperature: number) =>
      client.chat(
        [
          { role: 'system', content: STAGE1_MODULE_SYSTEM },
          { role: 'user', content: stage1ModuleUser(mod.name, overviewJson, chunkText) },
        ],
        { temperature, jsonMode: true, maxTokens: 8000, signal: ctx.signal }
      );
    let card: ModuleCard | null = null;
    for (let attempt = 0; attempt < 2 && !card; attempt++) {
      try {
        const parsed = coerceCard(parseJsonLoose(await call(attempt === 0 ? 0.2 : 0.3)), mod.name, files);
        // 空卡视同解析失败:重试;仍失败走兜底。绝不入缓存(防 {} 永久投毒,审计 Q-R1)
        if (!isEmptyCard(parsed)) card = parsed;
      } catch (err) {
        if (String(err instanceof Error ? err.message : err) === '已取消') throw err;
        warn(`  [警告] 模块 ${mod.name} 第 ${attempt + 1} 次解析失败:${err instanceof Error ? err.message : err}`);
      }
    }
    if (!card) {
      warn(`  [警告] 模块 ${mod.name} 两次解析失败/返回空卡,使用兜底卡(不缓存)`);
      card = coerceCard({}, mod.name, files);
    } else {
      cache.set(key, card);
    }
    return card;
  });

  // 项目级汇总
  const cardsJson = JSON.stringify(cards, null, 1);
  const kKey = cache.key('stage1-synth', PROMPT_VERSION, overviewJson, cardsJson);
  let knowledge = cache.get<ProjectKnowledge>(kKey);
  if (knowledge && knowledge.一句话定位) {
    log('  [缓存] 项目知识卡');
  } else {
    log('  汇总项目知识卡 ...');
    const synthCall = (temperature: number) =>
      client.chat(
        [
          { role: 'system', content: STAGE1_SYNTHESIS_SYSTEM },
          { role: 'user', content: stage1SynthesisUser(cardsJson, overviewJson) },
        ],
        { temperature, jsonMode: true, maxTokens: 8000, signal: ctx.signal }
      );
    let parsed: ProjectKnowledge | null = null;
    try {
      parsed = coerceKnowledge(parseJsonLoose(await synthCall(0.2)));
    } catch (err) {
      warn('  [警告] 知识卡解析失败,重试一次:' + (err instanceof Error ? err.message : err));
    }
    if (!parsed || !parsed.一句话定位) {
      try {
        parsed = coerceKnowledge(parseJsonLoose(await synthCall(0.3)));
      } catch (err) {
        if (String(err instanceof Error ? err.message : err) === '已取消') throw err;
        warn('  [警告] 知识卡二次解析失败,降级为模块摘要兜底(不缓存):' + (err instanceof Error ? err.message : err));
      }
    }
    // 兜底知识卡不入缓存;两次成功解析但为空对象同样按兜底处理
    if (parsed && parsed.一句话定位) {
      knowledge = parsed;
      cache.set(kKey, knowledge);
    } else {
      knowledge = fallbackKnowledge(cards);
    }
  }
  return { cards, knowledge, droppedModules: dropped };
}
