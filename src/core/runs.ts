import * as fs from 'fs';
import * as path from 'path';

/**
 * 每次生成自动落入独立输出目录(用户要求:前一次与后一次的产物不混放)。
 *
 * 布局:<输出根>/runs/run-0001、run-0002 …(零填充序号,字典序 = 生成顺序)。
 * 显式 --out / 自定义目录 = 旧语义,产物仍直接写进指定目录,不建 runs/。
 *
 * 增量不丢:开始新 run 时把「门控状态 + 阶段缓存 + 校验断点 + 门控输入产物」
 * 从最近一次 run 携带过来——仓库没变的部分照常命中缓存,几乎零成本;
 * 最终面向用户的产物(Markdown/HTML/报告)不携带,每个 run 目录自成一套完整快照。
 */

const RUN_DIR_RE = /^run-(\d{4,})$/;

export interface RunAllocation {
  /** 本次运行的独立产物目录(已创建) */
  runDir: string;
  /** 最近一次已存在的 run 目录(可作为增量来源),首次运行为 undefined */
  previousRunDir?: string;
  /** 序号(1 起) */
  index: number;
}

/** runs 容器目录 */
export function runsRootOf(outRoot: string): string {
  return path.join(outRoot, 'runs');
}

function runDirsIn(runsRoot: string): Array<{ index: number; dir: string }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ index: number; dir: string }> = [];
  for (const e of entries) {
    const m = e.isDirectory() && RUN_DIR_RE.exec(e.name);
    if (m) out.push({ index: Number(m[1]), dir: path.join(runsRoot, e.name) });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** 分配一个新的独立 run 目录(序号 = 现有最大 + 1;删除早期 run 不影响后续编号) */
export function allocateRunDir(outRoot: string): RunAllocation {
  const runsRoot = runsRootOf(outRoot);
  fs.mkdirSync(runsRoot, { recursive: true });
  const existing = runDirsIn(runsRoot);
  const last = existing[existing.length - 1];
  const index = (last?.index ?? 0) + 1;
  const runDir = path.join(runsRoot, `run-${String(index).padStart(4, '0')}`);
  fs.mkdirSync(runDir, { recursive: true });
  return { runDir, previousRunDir: last?.dir, index };
}

/**
 * 携带清单 = 让阶段门控/缓存/断点继续工作所需的最小集合:
 * - state.json            阶段门控哈希
 * - repo_facts.json       画像门控输入(命中时直接复用)
 * - module_cards/knowledge/questions.json  阶段 1/2 门控命中时的直接读取来源
 * - jd_analysis.json      阶段 4 门控命中时的读取来源(哈希不匹配自然不命中,携带无害)
 * - .verify-progress.json 阶段 3 校验断点(自带输入指纹)
 * - .cache/               全部 LLM 调用缓存
 * 最终产物(01~06.md、index.html、各类报告)与 .run-lock 绝不携带。
 */
const CARRY_FILES = [
  'state.json',
  'repo_facts.json',
  'module_cards.json',
  'knowledge.json',
  'questions.json',
  'jd_analysis.json',
  '.verify-progress.json',
];

/** 把上一次 run 的增量状态带到新目录;返回携带项(供日志展示) */
export function carryForwardIncrement(from: string | undefined, to: string): { carried: string[] } {
  const carried: string[] = [];
  if (!from || !fs.existsSync(from)) return { carried };
  for (const name of CARRY_FILES) {
    const src = path.join(from, name);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(to, name));
    carried.push(name);
  }
  const cacheSrc = path.join(from, '.cache');
  if (fs.existsSync(cacheSrc)) {
    fs.cpSync(cacheSrc, path.join(to, '.cache'), { recursive: true });
    carried.push('.cache/');
  }
  return { carried };
}

/** 最近一次完成的 run(含 index.html);无 runs 布局或全部未完成时返回 undefined */
export function latestRunDir(outRoot: string): string | undefined {
  const runsRoot = runsRootOf(outRoot);
  const done = runDirsIn(runsRoot)
    .reverse()
    .find((r) => fs.existsSync(path.join(r.dir, 'index.html')));
  return done?.dir;
}

/** 从产物目录反推被分析仓库根:优先 run-manifest.json 的快照记录,回退父目录(旧布局) */
export function repoRootOfOutput(outDir: string): string {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(outDir, 'run-manifest.json'), 'utf-8')) as {
      repository?: { root?: string };
    };
    if (m.repository?.root && fs.existsSync(m.repository.root)) return m.repository.root;
  } catch {
    /* 旧产物无 manifest,按旧布局处理 */
  }
  return path.dirname(path.resolve(outDir));
}
