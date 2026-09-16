#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { DeepSeekClient } from '../core/deepseek';
import { loadConfig, toolRootDir } from '../core/config';
import { runPipeline, runEvaluationOnly } from '../core/runner';
import { runRehearsal } from '../stages/stage6Rehearse';
import { buildPromptDocs } from '../core/prompts';
import { loadChunks } from '../core/chunker';
import { topUpToQuota } from '../stages/stage2Questions';
import { RepoFacts } from '../core/profiler';
import { ModuleCard, ProjectKnowledge } from '../core/schemas';
import { RunMode } from '../core/policy';
import { repoRootOfOutput } from '../core/runs';

const VERSION = '0.5.2';

const USAGE = `代码转面试 ${VERSION} — 读取完整代码仓库,生成真实面试场景全套材料(DeepSeek)

用法:
  code2offer generate <仓库路径> [--jd <岗位描述.txt>] [--out <固定输出目录>] [--mode economy|balanced|deep] [--force] [--max-files <n>]
      生成全套材料:项目讲解 / 百问百答(含横向对比) / 亮点防守 / 缺点改进 / 设计决策对比 / index.html 报告
      默认每次生成都新建独立目录 <仓库>/interview-output/runs/run-NNNN:前后两次产物互不覆盖,
      增量缓存/断点自动从上一次接续(仓库没变的部分零成本);--out 指定固定目录时沿用旧覆盖语义

  code2offer rehearse <输出目录> [--count <n>] [--category <类别>] [--top20]
      模拟面试排练:逐题提问 → 你作答 → DeepSeek 评分+追问 → 记录弱项

  code2offer evaluate <输出目录>
      自评环:DeepSeek 当评委,对产物按维度打分(满分10),给出优势/劣势/改进清单

  code2offer topup <输出目录>
      按覆盖矩阵配额定向补齐缺题(历史批次坍塌后的恢复,不必整库重出)

  code2offer export-prompts [输出目录=docs/prompts]
      导出全部阶段提示词为 Markdown(可单独粘贴到任意大模型工具使用)

  code2offer --version | --help

示例:
  node dist/cli/index.js generate ./my-repo --jd jd.txt
      # 产物落在 ./my-repo/interview-output/runs/run-0001/(下次自动 run-0002,互不覆盖)
  node dist/cli/index.js rehearse ./my-repo/interview-output/runs/run-0001 --count 5 --top20
  node dist/cli/index.js evaluate ./my-repo/interview-output/runs/run-0001
`;

/** 值旗标(消耗下一个参数);其余 --xxx 一律按布尔处理 */
const VALUE_FLAGS = new Set(['jd', 'out', 'mode', 'max-files', 'count', 'category']);

export interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positional?: string;
}

/**
 * 参数解析(审计 Q-4 重写):
 * 旧版把"布尔旗标后面的第一个参数"吞成旗标值——`rehearse --top20 <目录>` 直接失败、
 * `generate --force <仓库>` 的 force 变成字符串导致 === true 判假(静默失效)。
 * 现在:只有已知值旗标消耗下一个参数;位置参数 = 第一个既不是旗标也未作为值被消耗的参数。
 */
export function parseFlags(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const consumed = new Set<number>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (VALUE_FLAGS.has(key)) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        consumed.add(i + 1);
      } else {
        throw new Error(`旗标 --${key} 需要一个参数值(如 --${key} xxx)`);
      }
    } else {
      flags[key] = true;
    }
    consumed.add(i);
  }
  const positional = argv.find((a, i) => !a.startsWith('--') && !consumed.has(i));
  return { flags, positional };
}

function requireNumber(flags: Record<string, string | boolean>, name: string): number | undefined {
  const v = flags[name];
  if (v === undefined || v === true) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--${name} 需要正整数,得到:${v}`);
  }
  return Math.round(n);
}

function requireMode(flags: Record<string, string | boolean>): RunMode | undefined {
  const value = flags.mode;
  if (value === undefined) return undefined;
  if (value === 'economy' || value === 'balanced' || value === 'deep') return value;
  throw new Error(`--mode 只能是 economy/balanced/deep,得到:${String(value)}`);
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  if (command === '--version' || command === '-v') {
    console.log(VERSION);
    return;
  }
  if (command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }

  const { flags, positional } = parseFlags(rest);

  switch (command) {
    case 'generate': {
      if (!positional) {
        console.error(USAGE);
        process.exit(1);
      }
      await runPipeline({
        repoPath: positional,
        jdPath: typeof flags.jd === 'string' ? flags.jd : undefined,
        outDir: typeof flags.out === 'string' ? flags.out : undefined,
        force: flags.force === true,
        maxFiles: requireNumber(flags, 'max-files'),
        mode: requireMode(flags),
        host: 'cli',
      });
      break;
    }
    case 'rehearse': {
      if (!positional) {
        console.error(USAGE);
        process.exit(1);
      }
      const cfg = loadConfig({ trustedDirs: [process.cwd(), toolRootDir()], repoDir: repoRootOfOutput(path.resolve(positional)) });
      const client = new DeepSeekClient(cfg);
      await runRehearsal({
        outDir: path.resolve(positional),
        client,
        count: requireNumber(flags, 'count'),
        category: typeof flags.category === 'string' ? flags.category : undefined,
        top20: flags.top20 === true,
      });
      break;
    }
    case 'topup': {
      if (!positional) {
        console.error(USAGE);
        process.exit(1);
      }
      const outDir = path.resolve(positional);
      const readJson = <T>(p: string, what: string): T => {
        try {
          return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
        } catch (err) {
          throw new Error(`无法读取 ${what}(${p}):${err instanceof Error ? err.message : err};请重新 generate`);
        }
      };
      const facts = readJson<RepoFacts>(path.join(outDir, 'repo_facts.json'), '仓库画像');
      const cards = readJson<ModuleCard[]>(path.join(outDir, 'module_cards.json'), '模块卡');
      const knowledge = readJson<ProjectKnowledge>(path.join(outDir, 'knowledge.json'), '知识卡');
      const { chunks } = loadChunks(facts.root, facts.readingPlan);
      const cfg = loadConfig({ trustedDirs: [process.cwd(), toolRootDir()], repoDir: repoRootOfOutput(outDir) });
      const client = new DeepSeekClient(cfg);
      await topUpToQuota(client, facts, cards, knowledge, chunks, outDir);
      client.printUsage();
      console.log('提示:重新运行 generate 将继续执行校验与总装(出题阶段会被门控跳过)。');
      break;
    }
    case 'evaluate': {
      if (!positional) {
        console.error(USAGE);
        process.exit(1);
      }
      await runEvaluationOnly(positional);
      break;
    }
    case 'export-prompts': {
      const outDir = path.resolve(typeof positional === 'string' ? positional : 'docs/prompts');
      fs.mkdirSync(outDir, { recursive: true });
      const docs = buildPromptDocs();
      const index: string[] = ['# 提示词包总览', '', '完整管线的全部阶段提示词,可单独粘贴到任何大模型工具使用。', ''];
      for (const d of docs) {
        const md = `# ${d.title}\n\n> ${d.description}\n\n${d.body}\n`;
        fs.writeFileSync(path.join(outDir, d.file), md, 'utf-8');
        index.push(`- [${d.title}](${encodeURI(d.file)})`);
      }
      fs.writeFileSync(path.join(outDir, 'README.md'), index.join('\n') + '\n', 'utf-8');
      console.log(`已导出 ${docs.length} 份提示词 → ${outDir}`);
      break;
    }
    default:
      console.log(USAGE);
      if (command) process.exit(1);
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (/HTTP 401/.test(msg)) {
    console.error(`\n[错误] 鉴权失败(401):请检查 .env 中的 DEEPSEEK_API_KEY 是否有效。`);
  } else if (/已取消/.test(msg)) {
    console.error(`\n[已取消] ${msg}`);
  } else {
    console.error(`\n[错误] ${msg}`);
  }
  process.exit(1);
});
