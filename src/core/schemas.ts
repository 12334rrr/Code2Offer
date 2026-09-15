/**
 * 全链路数据结构与运行时校验。
 * 题目 JSON 是整个项目的核心契约:阶段 2 生成、阶段 3 校验、阶段 5 渲染都依赖它。
 */

export const DIFFICULTIES = ['基础', '进阶', '刁钻'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export interface CodeCite {
  file: string;
  lines: string; // 如 "12-34" 或 "12"
}

/** 横向对比块:用户核心要求——凡"为什么用 X"必须给出方案×维度的客观对比 */
export interface ComparisonBlock {
  候选方案: string[];
  维度: string[];
  对比表: string[][]; // 每行一个方案,首列为方案名
  结论: string; // 必须含适用边界:什么场景应反过来选另一个
}

export interface Question {
  id: string;
  category: string;
  difficulty: Difficulty;
  target?: string; // 目标模块/文件
  question: string;
  考察点: string;
  答案要点: string[];
  代码依据: CodeCite[];
  追问链: string[];
  加分回答: string;
  常见错误回答: string;
  对比?: ComparisonBlock;
  必考?: boolean;
  /** unverified = 校验未覆盖(模型失败/漏答),不得计入 pass 统计 */
  verified?: 'pass' | 'fix' | 'flag' | 'unverified';
  verifyNote?: string;
}

export interface ModuleCard {
  name: string;
  files: string[];
  职责: string;
  关键实现: Array<{ file: string; lines: string; name: string; 说明: string }>;
  设计决策: Array<{ 决策: string; 备选方案: string[]; 选择理由: string; 权衡: string }>;
  亮点: string[];
  缺点: string[];
  面试深挖点: string[];
}

export interface ProjectKnowledge {
  一句话定位: string;
  业务背景: string;
  架构描述: string;
  数据流: string;
  技术栈: Array<{ 领域: string; 选型: string; 备选: string; 理由: string }>;
  亮点: string[];
  缺点: string[];
}

export interface VerificationResult {
  id: string;
  verdict: 'pass' | 'fix' | 'flag';
  note: string;
  修正答案要点?: string[];
  修正代码依据?: CodeCite[];
  修正对比?: ComparisonBlock;
}

/* ---------------- 校验 ---------------- */

export function isDifficulty(v: unknown): v is Difficulty {
  return typeof v === 'string' && (DIFFICULTIES as readonly string[]).includes(v);
}

/**
 * 类别枚举注册:coverage.ts 拥有 CATEGORIES 单一事实源,加载时注入到这里,
 * schemas 无需反向依赖 coverage(避免循环导入)。未注册时不做枚举校验(兼容独立使用)。
 */
const knownCategories = new Set<string>();
export function registerQuestionCategories(names: string[]): void {
  knownCategories.clear();
  for (const n of names) knownCategories.add(n);
}

function isStrArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string');
}

/**
 * 解析引用行号:支持 "12"、"12-34" 与逗号多段 "103,107-127"。
 * 非法返回 null;各消费方(校验/摘录/评委)统一用它,避免规则漂移。
 */
export function parseCiteRanges(lines: string): Array<[number, number]> | null {
  if (typeof lines !== 'string' || !lines.trim()) return null;
  const out: Array<[number, number]> = [];
  for (const seg of lines.split(',')) {
    const m = seg.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const start = Number(m[1]);
    const end = Number(m[2] ?? m[1]);
    if (start < 1 || end < start) return null;
    out.push([start, end]);
  }
  return out.length ? out : null;
}

/** 运行时校验一道题;返回错误列表(空 = 通过)。files 是仓库真实文件集合。 */
export function validateQuestion(q: unknown, files: Set<string>): string[] {
  const errors: string[] = [];
  if (typeof q !== 'object' || q === null) return ['不是对象'];
  const o = q as Record<string, unknown>;
  if (typeof o.question !== 'string' || o.question.length < 8) errors.push('question 缺失或过短');
  if (typeof o.考察点 !== 'string' || !o.考察点) errors.push('考察点 缺失');
  if (!isDifficulty(o.difficulty)) errors.push(`difficulty 必须是 ${DIFFICULTIES.join('/')}`);
  if (typeof o.category !== 'string' || !o.category) errors.push('category 缺失');
  else if (knownCategories.size && !knownCategories.has(o.category)) errors.push(`category "${o.category}" 不在覆盖矩阵类别内`);
  if (!isStrArray(o.答案要点)) errors.push('答案要点 必须是非空字符串数组');
  else if ((o.答案要点 as string[]).some((a) => !a.trim())) errors.push('答案要点 含空条目');
  if (typeof o.加分回答 !== 'string' || !o.加分回答) errors.push('加分回答 缺失');
  if (typeof o.常见错误回答 !== 'string' || !o.常见错误回答) errors.push('常见错误回答 缺失');

  // 追问链 >= 2
  if (!Array.isArray(o.追问链) || o.追问链.length < 2 || !o.追问链.every((x) => typeof x === 'string')) {
    errors.push('追问链 至少 2 条');
  }

  // 代码依据:非空,且文件必须真实存在
  const cites = o.代码依据;
  if (!Array.isArray(cites) || cites.length === 0) {
    errors.push('代码依据 至少 1 条');
  } else {
    for (const c of cites) {
      const cc = c as Record<string, unknown>;
      if (typeof cc !== 'object' || typeof cc.file !== 'string' || !cc.file) {
        errors.push('代码依据 项缺少 file');
        continue;
      }
      if (!files.has(cc.file)) {
        errors.push(`代码依据 文件不存在于仓库:${cc.file}`);
      }
      if (typeof cc.lines !== 'string' || !parseCiteRanges(cc.lines)) {
        errors.push(`代码依据 lines 格式应为 "12" / "12-34" / "12-34,56-78",得到:${String(cc.lines)}`);
      }
    }
  }

  // 技术选型对比类:必须带客观对比块(形状判定与渲染/补齐环同一实现,消除双源漂移)
  if (o.category === '技术选型对比' && !isValidComparison(o.对比)) {
    errors.push('技术选型对比类题目必须包含结构完整的 对比 块(候选≥2/维度≥3/矩形表/含结论)');
  }
  return errors;
}

/**
 * 对比块形状是否合格(渲染与补齐环共用;与 validateQuestion 的对比校验同源)。
 * 严格版:矩形表(每行 = 维度数 + 1)、行首非空、单元格非空——
 * 空对象/空行/[[],[]] 之类不再通过,防"形状合法但内容为零"的块混进渲染。
 */
export function isValidComparison(c: unknown): boolean {
  const rec = c as Record<string, unknown> | undefined;
  if (!rec || typeof rec !== 'object') return false;
  if (!isStrArray(rec.候选方案) || rec.候选方案.length < 2) return false;
  if (!isStrArray(rec.维度) || rec.维度.length < 3) return false;
  const dims = rec.维度 as string[];
  const rows = rec.对比表;
  if (!Array.isArray(rows) || rows.length < 2) return false;
  const width = dims.length + 1;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== width) return false; // 非矩形
    for (const cell of row) {
      if (typeof cell !== 'string' || !cell.trim()) return false; // 空单元格
    }
  }
  if (typeof rec.结论 !== 'string' || rec.结论.length < 10) return false;
  return true;
}

/**
 * 宽松转一道模型输出的 JSON 为 Question(补默认值、截断超长)。
 * 类别/难度/目标一律以题位(slot)为准,不信模型回显——覆盖矩阵是"防换皮"的根,
 * 模型自报 category 漂移会穿透配额与对比块硬约束(审计 R-5)。
 */
export function coerceQuestion(raw: unknown, id: string, category: string, difficulty: Difficulty, target: string): Question {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, any>;
  const cleanArr = (v: unknown): string[] =>
    (Array.isArray(v) ? v.map(String) : []).map((s) => s.trim()).filter(Boolean);
  return {
    id,
    category,
    difficulty,
    target,
    question: String(o.question ?? ''),
    考察点: String(o.考察点 ?? ''),
    答案要点: cleanArr(o.答案要点),
    代码依据: Array.isArray(o.代码依据)
      ? o.代码依据.map((c: any) => ({ file: String(c?.file ?? ''), lines: String(c?.lines ?? '') }))
      : [],
    追问链: cleanArr(o.追问链).slice(0, 4),
    加分回答: String(o.加分回答 ?? ''),
    常见错误回答: String(o.常见错误回答 ?? ''),
    对比: o.对比
      ? {
          候选方案: cleanArr(o.对比.候选方案),
          维度: cleanArr(o.对比.维度),
          对比表: Array.isArray(o.对比.对比表) ? o.对比.对比表.map((r: any) => (Array.isArray(r) ? r.map(String) : [])) : [],
          结论: String(o.对比.结论 ?? ''),
        }
      : undefined,
  };
}
