import { Difficulty, ModuleCard, ProjectKnowledge, Question, registerQuestionCategories } from './schemas';

/**
 * 覆盖矩阵:100 题不是"让模型一次编 100 个",而是由代码强制分配
 * 类别 × 难度 × 目标模块 的配额,分批出题。这是防"30 真话 + 70 换皮"的关键。
 */

export interface CategorySpec {
  name: string;
  description: string;
  quota: number;
  difficulties: Array<{ level: Difficulty; count: number; hint: string }>;
  needsModuleTarget: boolean;
  requireComparison: boolean;
}

export const CATEGORIES: CategorySpec[] = [
  {
    name: '项目整体与业务理解',
    description: '项目定位、解决什么问题、整体结构;考察候选人能否 3 分钟讲清自己的项目',
    quota: 8,
    difficulties: [
      { level: '基础', count: 4, hint: '是什么、做什么、给谁用' },
      { level: '进阶', count: 3, hint: '为什么这样分层/组织,业务与技术的映射' },
      { level: '刁钻', count: 1, hint: '如果重做一遍哪里最想推翻' },
    ],
    needsModuleTarget: false,
    requireComparison: false,
  },
  {
    name: '架构设计与分层',
    description: '模块划分、依赖方向、请求链路;依据画像中的架构事实出题',
    quota: 10,
    difficulties: [
      { level: '基础', count: 3, hint: '画出/描述分层与职责' },
      { level: '进阶', count: 4, hint: '依赖为什么这样走,解耦点在哪' },
      { level: '刁钻', count: 3, hint: '循环依赖、层级穿透、扩展时架构先裂在哪' },
    ],
    needsModuleTarget: false,
    requireComparison: false,
  },
  {
    name: '技术选型对比',
    description: '【用户核心要求】每个选型必考:候选方案 × 对比维度 × 客观优劣势(含所选方案缺点)× 适用边界',
    quota: 12,
    difficulties: [
      { level: '基础', count: 4, hint: 'X 和 Y 的区别,各自适用场景' },
      { level: '进阶', count: 5, hint: '本项目为什么选 X,给出维度化对比与代价' },
      { level: '刁钻', count: 3, hint: '什么条件下应反过来选另一个;选型在压力下何时失效' },
    ],
    needsModuleTarget: false,
    requireComparison: true,
  },
  {
    name: '核心模块深挖',
    description: '按模块卡的"关键实现"逐个击穿;目标模块由代码自动分配',
    quota: 24,
    difficulties: [
      { level: '基础', count: 8, hint: '这段代码做了什么,数据怎么流' },
      { level: '进阶', count: 10, hint: '为什么这样实现,替换方案与代价' },
      { level: '刁钻', count: 6, hint: '边界输入/并发/故障下的行为' },
    ],
    needsModuleTarget: true,
    requireComparison: false,
  },
  {
    name: '算法与数据结构',
    description: '项目中真实用到的结构(LRU、索引、去重、排序等),不考与代码无关的八股',
    quota: 8,
    difficulties: [
      { level: '基础', count: 3, hint: '用了什么结构,复杂度多少' },
      { level: '进阶', count: 3, hint: '为什么这个结构合适,换一个会怎样' },
      { level: '刁钻', count: 2, hint: '规模放大 1000 倍后复杂度瓶颈' },
    ],
    needsModuleTarget: false,
    requireComparison: false,
  },
  {
    name: '异常处理与边界',
    description: '错误传播、输入校验、空值/超时/重试;以真实代码的防御(或裸奔)为题眼',
    quota: 8,
    difficulties: [
      { level: '基础', count: 3, hint: '错误在哪里被捕获,返回什么' },
      { level: '进阶', count: 3, hint: '为什么这样设计错误路径' },
      { level: '刁钻', count: 2, hint: '构造一个让程序出错的输入序列' },
    ],
    needsModuleTarget: false,
    requireComparison: false,
  },
  {
    name: '性能优化',
    description: '缓存、批量、索引、热点路径;结合有趣代码启发式的命中项出题',
    quota: 8,
    difficulties: [
      { level: '基础', count: 2, hint: '哪里做了性能考虑' },
      { level: '进阶', count: 4, hint: '为什么这样优化,收益与代价' },
      { level: '刁钻', count: 2, hint: 'QPS 翻百倍先挂在哪,如何定位' },
    ],
    needsModuleTarget: false,
    requireComparison: false,
  },
  {
    name: '安全',
    description: '输入校验、注入、鉴权、敏感信息;代码里缺失的部分也是题(指出并让候选人答防御)',
    quota: 6,
    difficulties: [
      { level: '基础', count: 2, hint: '已有的校验/鉴权在哪' },
      { level: '进阶', count: 2, hint: '为什么这样防,还差什么' },
      { level: '刁钻', count: 2, hint: '现有代码可被如何攻击(友好表述)' },
    ],
    needsModuleTarget: false,
    requireComparison: false,
  },
  {
    name: '工程化与测试',
    description: '构建、规范、测试覆盖;没有测试的仓库就问"怎么补、先补哪" ',
    quota: 8,
    difficulties: [
      { level: '基础', count: 3, hint: '怎么跑起来、怎么构建' },
      { level: '进阶', count: 3, hint: '测试策略与取舍' },
      { level: '刁钻', count: 2, hint: 'CI 缺失会埋什么雷' },
    ],
    needsModuleTarget: false,
    requireComparison: false,
  },
  {
    name: '部署与运维',
    description: '配置管理、环境、日志、监控;依据 config 文件与入口出题',
    quota: 4,
    difficulties: [
      { level: '基础', count: 1, hint: '如何部署与配置' },
      { level: '进阶', count: 2, hint: '配置为什么这样组织' },
      { level: '刁钻', count: 1, hint: '线上出问题如何排查' },
    ],
    needsModuleTarget: false,
    requireComparison: false,
  },
  {
    name: '开放与成长',
    description: '项目中最难的点、收获、如果加人先让他做什么;考察叙事与自省',
    quota: 4,
    difficulties: [
      { level: '基础', count: 2, hint: '最难的bug/决策' },
      { level: '进阶', count: 1, hint: '技术成长与项目的关系' },
      { level: '刁钻', count: 1, hint: '面试官挑战项目价值时如何回应' },
    ],
    needsModuleTarget: false,
    requireComparison: false,
  },
];

export interface Slot {
  category: string;
  difficulty: Difficulty;
  target: string;
  hint: string;
  requireComparison: boolean;
}

export function totalQuota(target: number = DEFAULT_QUESTION_TARGET): number {
  return scaledCategories(target).reduce((s, c) => s + c.quota, 0);
}

/* ---------------- 自适应题量(0.8.2):质量优先,不再硬性 100 ----------------
 * 动机:自跑日志显示硬性 100 会制造大量配额缺口 → 4 轮补题 + 逐批修复,
 * 白烧 token 且把题位稀释到 audit/docs 等低价值文件上。
 * economy 30 / balanced 60 / deep 80;--questions 可覆盖(10-100)。
 * 矩阵按比例缩放(每类保底 1 题),覆盖广度不丢。 */

export const DEFAULT_QUESTION_TARGET = 100;
/** 下限 = 类别数(每类保底 1 题,11 类 → 11) */
export const MIN_QUESTION_TARGET = CATEGORIES.length;

export function questionTargetFor(mode: string | undefined, override?: number): number {
  if (override !== undefined && Number.isFinite(override)) {
    return Math.max(MIN_QUESTION_TARGET, Math.min(100, Math.round(override)));
  }
  if (mode === 'economy') return 30;
  if (mode === 'balanced') return 60;
  if (mode === 'deep') return 80;
  return DEFAULT_QUESTION_TARGET;
}

type ScaledCategory = (typeof CATEGORIES)[number];

const scaledCache = new Map<number, ScaledCategory[]>();

/** 按目标题量取缩放后的类别矩阵(evaluate 等外部消费方用) */
export function categoriesFor(target: number = DEFAULT_QUESTION_TARGET): ScaledCategory[] {
  return scaledCategories(target);
}

/** 把类别×难度配额矩阵按 target/100 缩放(两级最大余数法):类别和恰为 target,每类 ≥1,类内难度和 = 类配额;结果缓存 */
function scaledCategories(target: number): ScaledCategory[] {
  const t = Math.max(10, Math.min(200, Math.round(target)));
  const hit = scaledCache.get(t);
  if (hit) return hit;
  const factor = t / DEFAULT_QUESTION_TARGET;

  // 类级:floor + 最大余数补足,和恰为 t
  const catTargets = CATEGORIES.map((c) => ({ c, exact: c.quota * factor, base: Math.max(1, Math.floor(c.quota * factor)) }));
  let sum = catTargets.reduce((s, x) => s + x.base, 0);
  const byFrac = [...catTargets].sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)));
  let i = 0;
  while (sum < t) {
    byFrac[i % byFrac.length].base++;
    sum++;
    i++;
  }
  const byBaseDesc = [...catTargets].sort((a, b) => b.base - a.base);
  let j = 0;
  while (sum > t && byBaseDesc.some((x) => x.base > 1)) {
    const x = byBaseDesc[j % byBaseDesc.length];
    if (x.base > 1) {
      x.base--;
      sum--;
    }
    j++;
  }

  const out: ScaledCategory[] = catTargets.map(({ c, base }) => {
    // 类内:难度按 base/c.quota 比例分配,和恰为 base
    const ds = c.difficulties.map((d) => ({ count: d.count, base: Math.floor((d.count / c.quota) * base) }));
    let dsum = ds.reduce((s, x) => s + x.base, 0);
    const dfs = [...ds].sort((a, b) => ((b.count / c.quota) * base - b.base) - ((a.count / c.quota) * base - a.base));
    let k = 0;
    while (dsum < base) {
      dfs[k % dfs.length].base++;
      dsum++;
      k++;
    }
    const byD = [...ds].sort((a, b) => b.base - a.base);
    let m = 0;
    while (dsum > base && byD.some((x) => x.base > 0)) {
      const x = byD[m % byD.length];
      if (x.base > 0) {
        x.base--;
        dsum--;
      }
      m++;
    }
    return { ...c, quota: base, difficulties: c.difficulties.map((d, idx) => ({ ...d, count: ds[idx].base })) };
  });
  scaledCache.set(t, out);
  return out;
}

// 类别枚举注册进 schemas 的运行时校验(单一事实源在这里,避免循环导入)
registerQuestionCategories(CATEGORIES.map((c) => c.name));

const CMP_REQUIRED_CATS = new Set(CATEGORIES.filter((c) => c.requireComparison).map((c) => c.name));

/** 该类别是否强制要求对比块(与 schemas.validateQuestion 的硬编码类别保持同步) */
export function requiresComparison(category: string): boolean {
  return CMP_REQUIRED_CATS.has(category);
}

/**
 * 裁剪到恰好 100 题:按 (类别|难度) 配额保留先出现的,超出剔除,重编 ID。
 * 用于补题救回重复槽位后的规范化。未知类别(历史数据/手改)的配额为 0,会被裁掉并计数返回。
 */
export function trimToQuota(questions: Question[]): Question[] {
  const { keep } = trimToQuotaDetailed(questions);
  return keep.map((q, i) => ({ ...q, id: `Q${String(i + 1).padStart(2, '0')}` }));
}

/** trimToQuota 的详细版:同时返回被裁数量(未知类别 / 超配额),供日志透明化 */
export function trimToQuotaDetailed(questions: Question[], target: number = DEFAULT_QUESTION_TARGET): {
  keep: Question[];
  droppedUnknownCategory: number;
  droppedOverQuota: number;
} {
  const quotaMap = new Map<string, number>();
  for (const c of scaledCategories(target)) {
    for (const d of c.difficulties) quotaMap.set(`${c.name}|${d.level}`, d.count);
  }
  const seen = new Map<string, number>();
  const keep: Question[] = [];
  let droppedUnknownCategory = 0;
  let droppedOverQuota = 0;
  for (const q of questions) {
    const k = `${q.category}|${q.difficulty}`;
    const quota = quotaMap.get(k) ?? 0;
    if (quota === 0) {
      droppedUnknownCategory++;
      continue;
    }
    const n = seen.get(k) ?? 0;
    if (n < quota) {
      seen.set(k, n + 1);
      keep.push(q);
    } else {
      droppedOverQuota++;
    }
  }
  return { keep: keep.slice(0, totalQuota(target)), droppedUnknownCategory, droppedOverQuota };
}

/**
 * 计算缺口题位:现有题目按 (类别|难度) 占用配额后,剩余未满足的 slot 列表。
 * runStage2 的补题轮与 topUpToQuota 共用同一算法——
 * 此前两处各写一套"从 slots 顺序切片",批间坍塌后窗口漂移,丢失的类别永远不补(审计 R-5)。
 */
export function computeDeficitSlots(questions: Question[], cards: ModuleCard[], knowledge?: ProjectKnowledge, target: number = DEFAULT_QUESTION_TARGET): Slot[] {
  const slots = buildSlots(cards, knowledge, target);
  const used = new Map<string, number>();
  const knownCats = new Set(CATEGORIES.map((c) => c.name));
  for (const q of questions) {
    if (!knownCats.has(q.category)) continue; // 未知类别题会被 trim 裁掉,不计入占用
    const k = `${q.category}|${q.difficulty}`;
    used.set(k, (used.get(k) ?? 0) + 1);
  }
  const missing: Slot[] = [];
  for (const s of slots) {
    const k = `${s.category}|${s.difficulty}`;
    const left = used.get(k) ?? 0;
    if (left > 0) used.set(k, left - 1);
    else missing.push(s);
  }
  return missing;
}

function shuffleStable<T>(arr: T[], salt: number): T[] {
  // 确定性"打散":同一仓库出题顺序稳定,便于缓存与对照
  // 模数取 1009(> 任何现实配额):模数 ≤ 题数时 k 大量碰撞,打散退化为近似原序
  return arr
    .map((x, i) => ({ x, k: (i * 37 + salt * 13) % 1009 }))
    .sort((a, b) => a.k - b.k)
    .map((e) => e.x);
}

/** 由模块卡 + 项目知识卡生成题位(配额按 target 缩放,每类保底 1 题) */
export function buildSlots(cards: ModuleCard[], knowledge?: ProjectKnowledge, target: number = DEFAULT_QUESTION_TARGET): Slot[] {
  const slots: Slot[] = [];
  const moduleTargets = cards.length
    ? cards
    : ([
        {
          name: '项目整体',
          files: [],
          职责: '整个仓库',
          关键实现: [],
          设计决策: [],
          亮点: [],
          缺点: [],
          面试深挖点: [],
        } as ModuleCard,
      ]);

  // 选型对比的目标:优先知识卡里的技术栈条目,其次各模块的设计决策
  const comparisonTargets: string[] = [];
  if (knowledge?.技术栈?.length) {
    for (const t of knowledge.技术栈) comparisonTargets.push(`${t.领域}:${t.选型}`);
  }
  for (const c of moduleTargets) {
    for (const d of c.设计决策 ?? []) comparisonTargets.push(`${c.name}:${d.决策}`);
  }
  if (!comparisonTargets.length) comparisonTargets.push('项目整体选型');

  let cmpIdx = 0;
  let deepIdx = 0;
  for (const cat of scaledCategories(target)) {
    for (const d of cat.difficulties) {
      for (let i = 0; i < d.count; i++) {
        let target = '项目整体';
        if (cat.needsModuleTarget) {
          const m = moduleTargets[deepIdx % moduleTargets.length];
          target = m.name;
          deepIdx++;
        } else if (cat.requireComparison) {
          target = comparisonTargets[cmpIdx % comparisonTargets.length];
          cmpIdx++;
        }
        slots.push({
          category: cat.name,
          difficulty: d.level,
          target,
          hint: d.hint,
          requireComparison: cat.requireComparison,
        });
      }
    }
  }
  // 打散难度与类别,避免同一批 10 题全是同一类别(但保持确定性)
  return shuffleStable(slots, 7);
}
