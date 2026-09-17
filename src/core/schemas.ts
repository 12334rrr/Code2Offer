/**
 * 全链路数据结构与运行时校验。
 * 题目 JSON 是整个项目的核心契约:阶段 2 生成、阶段 3 校验、阶段 5 渲染都依赖它。
 */

export const DIFFICULTIES = ['基础', '进阶', '刁钻'] as const;
/** Bump when deterministic user-facing question validation semantics change. */
export const QUESTION_VALIDATION_VERSION = '4';
export type Difficulty = (typeof DIFFICULTIES)[number];

/** 单条代码依据允许的最大行跨度(0.8.1 起 S 级收紧到 40:约一屏,面试官能当场翻到) */
export const MAX_CITE_SPAN = 40;

export interface CodeCite {
  file: string;
  lines: string; // 如 "12-34" 或 "12"
}

/** 追问(0.8.0):开放式追问必须给可直接背诵的标准答案要点——只问不答等于让候选人自己补全 */
export interface FollowUp {
  问题: string;
  参考要点: string;
}

/** 兼容旧题库(string 追问)与新模型输出的对象追问,统一成 FollowUp */
export function normalizeFollowUps(v: unknown): FollowUp[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x): FollowUp => {
      if (typeof x === 'string') return { 问题: x.trim(), 参考要点: '' };
      const o = (x ?? {}) as Record<string, any>;
      return {
        问题: String(o.问题 ?? o.question ?? '').trim(),
        参考要点: String(o.参考要点 ?? o.points ?? '').trim(),
      };
    })
    .filter((f) => f.问题);
}

/** 题位难度标签 → 量化难度分:模型给了数值就钳制到 1-10(保留意图);缺失/非法时按标签确定性兜底 */
export function difficultyScoreOf(d: Difficulty, v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isFinite(n)) return Math.min(10, Math.max(1, Math.round(n)));
  return d === '基础' ? 3 : d === '进阶' ? 6 : 8;
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
  /** 量化难度 1-10(0.8.0 起):1-3 记忆/复述,4-6 原理理解,7-8 权衡设计,9-10 底层实现/极端场景 */
  难度分?: number;
  target?: string; // 目标模块/文件
  question: string;
  考察点: string;
  答案要点: string[];
  代码依据: CodeCite[];
  追问链: FollowUp[];
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

/**
 * 模型偶尔把解释拼进 lines，例如 "204-239（实际为…）"。
 * 只接受字符串开头连续的合法数字范围并丢弃后缀；没有数字开头的散文一律返回 null。
 */
export function normalizeCiteLines(lines: unknown): string | null {
  if (typeof lines !== 'string') return null;
  const match = lines.trim().match(/^(\d+(?:\s*-\s*\d+)?(?:\s*,\s*\d+(?:\s*-\s*\d+)?)*)\b/);
  if (!match) return null;
  const ranges = parseCiteRanges(match[1].replace(/\s+/g, ''));
  if (!ranges) return null;
  return ranges.map(([start, end]) => (start === end ? String(start) : `${start}-${end}`)).join(',');
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

  // User-facing interview material must be independently rehearsable. Do not
  // allow model-process notes, vague source locations, or literal placeholders
  // to enter the question bank merely because their JSON shape is valid.
  const presentationFields: Array<[string, unknown]> = [
    ['question', o.question], ['考察点', o.考察点], ['加分回答', o.加分回答], ['常见错误回答', o.常见错误回答],
    ...(Array.isArray(o.答案要点) ? (o.答案要点 as unknown[]).map((v, i) => [`答案要点[${i}]`, v] as [string, unknown]) : []),
  ];
  for (const [field, value] of presentationFields) {
    if (typeof value === 'string' && hasPresentationIssue(value)) errors.push(`${field} 含不可背诵的占位/模糊定位/过程性措辞`);
  }

  // 追问链(0.8.0):≥2 条,且每条开放式追问必须带可直接背诵的参考要点
  const followUps = normalizeFollowUps(o.追问链);
  if (followUps.length < 2) {
    errors.push('追问链 至少 2 条');
  } else {
    followUps.forEach((f, i) => {
      if (hasPresentationIssue(f.问题)) errors.push(`追问链[${i}].问题 含不可背诵的占位/模糊定位/过程性措辞`);
      if (f.参考要点.length < 10) errors.push(`追问链[${i}] 缺少参考要点(开放式追问必须给标准答案要点,不能只问不答)`);
      else if (hasPresentationIssue(f.参考要点)) errors.push(`追问链[${i}].参考要点 含不可背诵的占位/模糊定位/过程性措辞`);
    });
  }

  // 量化难度分(0.8.0):给就必须是 1-10
  if (o.难度分 !== undefined && o.难度分 !== null) {
    const n = Number(o.难度分);
    if (!Number.isFinite(n) || n < 1 || n > 10) errors.push(`难度分 必须是 1-10 的数字,得到:${String(o.难度分)}`);
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
        continue;
      }
      // S 级"题题精确定位":单段行跨度超限 = 文件级/整文件式引用,背诵与复核都无法落地
      const wide = (parseCiteRanges(cc.lines) ?? []).find(([s, e]) => e - s + 1 > MAX_CITE_SPAN);
      if (wide) {
        errors.push(`代码依据 ${cc.file} 引用区间 ${wide[0]}-${wide[1]} 跨度超过 ${MAX_CITE_SPAN} 行,必须定位到具体实现段落(单条 ≤${MAX_CITE_SPAN} 行)`);
      }
    }
  }

  // 技术选型对比类:必须带客观对比块(形状判定与渲染/补齐环同一实现,消除双源漂移)
  if (o.category === '技术选型对比' && !isValidComparison(o.对比)) {
    errors.push('技术选型对比类题目必须包含结构完整的 对比 块(候选≥2/维度≥3/矩形表/含结论)');
  }
  return errors;
}

/** Reject strings that make a generated answer impossible to rehearse or verify. */
export function hasPresentationIssue(text: string): boolean {
  return /(?:所给|该|引用处)?原文.{0,8}(?:未完整展示|未展示|未提供)|(?:需|请).{0,5}(?:补充|核对)|无法确认|待(?:补充|确认)|\bX\s*(?:和|与)\s*Y\b|\d+\s*附近|\d+\s*[-~至]\s*\d+\s*行段内/.test(text)
    // 0.8.1:证据元话语型"答案"(讨论证据够不够,而不是回答问题)同样不可背诵
    || /未被?(?:任何)?(?:引用|摘录|原文|材料|现有代码)[^。]{0,8}(?:覆盖|展示|证实)|未经验证的推断|无法从[^。]{0,10}(?:代码|引用|摘录|原文)[^。]{0,6}(?:证实|推出|确认)/.test(text);
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
    难度分: difficultyScoreOf(difficulty, o.难度分 ?? o.difficultyScore),
    target,
    question: String(o.question ?? ''),
    考察点: String(o.考察点 ?? ''),
    答案要点: cleanArr(o.答案要点),
    代码依据: Array.isArray(o.代码依据)
      ? o.代码依据.map((c: any) => ({
          file: String(c?.file ?? ''),
          lines: normalizeCiteLines(c?.lines) ?? String(c?.lines ?? ''),
        }))
      : [],
    追问链: normalizeFollowUps(o.追问链).slice(0, 4),
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

/* ---------------- 风险给药语义(0.8.1):指出风险必须当场给改进方案 ---------------- */
/** 单一事实源:审计脚本(audit/s-level-audit.cjs)与修复环(repairRiskWithoutFix)共用 */

export const RISK_RE = /(风险|缺陷|隐患|坏味道|不足|局限|退化|失效|溢出|竞态|死锁|泄漏|开销|瓶颈|裂点|盲区|代价)/;
export const FIX_RE = /(改进|修复|应(?:改|调|做|把|在|显式|补|调用)|改为|换成|建议|方案|升级|拆分|校验|加锁|限流|兜底|重试|降级|注入|白名单|转义|验证方式|压测|回归基线|采用|选择|补上|补齐)/;

/** 该题是否"指出风险但没有任何改进表述"(需要定向修补) */
export function riskWithoutFix(q: Question): boolean {
  return q.答案要点.some((a) => RISK_RE.test(a)) && !q.答案要点.some((a) => FIX_RE.test(a));
}

/**
 * 对比块客观性启发检查(0.9.1):结论钦定"首选/最优/最佳"式单边措辞,
 * 而整个对比块(表+结论)没有任何缺点/代价表述 → 判定偏袒,触发 2.5 环定向重写。
 * 形状合格(isValidComparison)但内容偏袒的块,是评委抓到的 S 级缺口。
 */
export function comparisonLacksObjectivity(c?: ComparisonBlock): boolean {
  if (!isValidComparison(c)) return false;
  const block = c as ComparisonBlock;
  const verdictBias = /(首选|最优|最佳|性价比最高|完胜|碾压|完爆)/.test(block.结论);
  const text = [block.结论, ...block.对比表.flat()].join(' ');
  const hasDrawback = /(缺点|代价|劣势|短板|不足|局限|风险|开销)/.test(text);
  return verdictBias && !hasDrawback;
}

/** 旧题库升级(0.8.0):读 questions.json 时把 string 追问归一为 FollowUp、补 难度分 兜底 */
export function normalizeQuestionLegacy(q: Question): Question {
  return {
    ...q,
    难度分: difficultyScoreOf(q.difficulty, q.难度分),
    追问链: normalizeFollowUps(q.追问链),
  };
}
