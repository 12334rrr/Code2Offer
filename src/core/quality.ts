import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { RepoFacts, splitFileLines } from './profiler';
import { ModuleCard, Question, parseCiteRanges } from './schemas';
import { totalQuota, DEFAULT_QUESTION_TARGET } from './coverage';

export interface QualityReport {
  generatedAt: string;
  totalQuestions: number;
  quota: number;
  quotaCompleteness: number;
  verifiedRate: number;
  validCitationRate: number;
  citationFileCoverage: number;
  citationBoundaryPassRate: number;
  flaggedCount: number;
  unverifiedCount: number;
  uncoveredCount: number;
  emptyCardCount: number;
  degradationCount: number;
  evidenceDuplicationRate: number;
  score: number;
  grade: 'A+' | 'A' | 'B' | 'partial';
  aPlusEligible: boolean;
  reasons: string[];
}

const hash = (value: string): string => crypto.createHash('sha1').update(value).digest('hex');

function citeValid(facts: RepoFacts, file: string, lines: string): boolean {
  if (!facts.files.includes(file)) return false;
  const ranges = parseCiteRanges(lines);
  if (!ranges) return false;
  try {
    const total = splitFileLines(fs.readFileSync(path.join(facts.root, file), 'utf8')).length;
    return ranges.every(([start, end]) => start >= 1 && start <= end && end <= total);
  } catch { return false; }
}

export function buildQualityReport(facts: RepoFacts, cards: ModuleCard[], questions: Question[], target: number = DEFAULT_QUESTION_TARGET): {
  report: QualityReport;
  claimLedger: unknown[];
  evidenceGraph: { nodes: unknown[]; edges: unknown[] };
} {
  const quota = totalQuota(target);
  const totalCites = questions.reduce((n, q) => n + (q.代码依据?.length ?? 0), 0);
  const validCites = questions.reduce((n, q) => n + (q.代码依据 ?? []).filter((c) => citeValid(facts, c.file, c.lines)).length, 0);
  const citedFiles = new Set(questions.flatMap((q) => (q.代码依据 ?? []).filter((c) => citeValid(facts, c.file, c.lines)).map((c) => c.file)));
  const boundaryPass = validCites;
  const flaggedCount = questions.filter((q) => q.verified === 'flag').length;
  const unverifiedCount = questions.filter((q) => q.verified === 'unverified').length;
  const uncoveredCount = questions.filter((q) => !(q.代码依据?.length)).length;
  const emptyCardCount = cards.filter((c) => !c.职责?.trim() && !c.关键实现?.length && !c.设计决策?.length && !c.亮点?.length && !c.缺点?.length).length;
  const degradationCount = facts.notes.filter((n) => /降级|失败|跳过|截断|未覆盖/i.test(n)).length;
  const evidenceKeys = questions.flatMap((q) => (q.代码依据 ?? []).map((c) => `${c.file}:${c.lines}`));
  const duplicateCount = evidenceKeys.length - new Set(evidenceKeys).size;
  const reasons: string[] = [];
  if (questions.length !== quota) reasons.push(`题目配额 ${questions.length}/${quota}`);
  if (unverifiedCount) reasons.push(`${unverifiedCount} 题未完成校验`);
  if (flaggedCount) reasons.push(`${flaggedCount} 题仍标红`);
  if (uncoveredCount) reasons.push(`${uncoveredCount} 题无引用`);
  if (emptyCardCount) reasons.push(`${emptyCardCount} 张空模块卡`);
  if (totalCites !== validCites) reasons.push(`${totalCites - validCites} 条引用未通过确定性检查`);
  const completeness = quota ? Math.min(1, questions.length / quota) : 0;
  const verifiedRate = questions.length ? (questions.length - unverifiedCount) / questions.length : 0;
  const validRate = totalCites ? validCites / totalCites : 0;
  const score = Math.max(0, Math.min(100, Math.round((completeness * 35 + verifiedRate * 25 + validRate * 25 + (emptyCardCount ? 0 : 10) + (flaggedCount ? 0 : 5)) * 100) / 100));
  const eligible = questions.length === quota && unverifiedCount === 0 && flaggedCount === 0 && uncoveredCount === 0 && emptyCardCount === 0 && validCites === totalCites;
  const report: QualityReport = {
    generatedAt: new Date().toISOString(), totalQuestions: questions.length, quota,
    quotaCompleteness: completeness, verifiedRate, validCitationRate: validRate,
    citationFileCoverage: facts.files.length ? citedFiles.size / facts.files.length : 0,
    citationBoundaryPassRate: totalCites ? boundaryPass / totalCites : 0,
    flaggedCount, unverifiedCount, uncoveredCount, emptyCardCount, degradationCount,
    evidenceDuplicationRate: evidenceKeys.length ? duplicateCount / evidenceKeys.length : 0,
    score, grade: eligible && score >= 95 ? 'A+' : score >= 90 ? 'A' : score >= 75 ? 'B' : 'partial',
    aPlusEligible: eligible && score >= 95, reasons,
  };
  const claimLedger = questions.flatMap((q) => (q.答案要点 ?? []).map((claim) => ({
    claimId: hash(`${q.id}|${claim}`), questionId: q.id, claim,
    supportingCitations: q.代码依据 ?? [], verificationStatus: q.verified ?? 'unverified',
    confidence: q.verified === 'pass' ? 1 : q.verified === 'fix' ? 0.85 : q.verified === 'flag' ? 0.2 : 0,
    verifierNote: q.verifyNote ?? '', contentHash: hash(`${q.id}|${claim}|${JSON.stringify(q.代码依据 ?? [])}`),
  })));
  const nodes: unknown[] = [];
  const edges: unknown[] = [];
  for (const file of facts.files) nodes.push({ id: `file:${file}`, type: 'file', file });
  for (const card of cards) {
    const id = `module:${card.name}`; nodes.push({ id, type: 'module', name: card.name });
    for (const file of card.files) edges.push({ from: id, to: `file:${file}`, type: 'contains' });
  }
  for (const q of questions) {
    const qid = `question:${q.id}`; nodes.push({ id: qid, type: 'question', questionId: q.id });
    for (const cite of q.代码依据 ?? []) edges.push({ from: qid, to: `file:${cite.file}`, type: 'cites', lines: cite.lines });
    const card = cards.find((c) => c.files.some((f) => (q.代码依据 ?? []).some((cite) => cite.file === f)));
    if (card) edges.push({ from: qid, to: `module:${card.name}`, type: 'targets' });
  }
  for (const claim of claimLedger as Array<{ claimId: string; questionId: string }>) {
    nodes.push({ id: `claim:${claim.claimId}`, type: 'claim', claimId: claim.claimId });
    edges.push({ from: `question:${claim.questionId}`, to: `claim:${claim.claimId}`, type: 'supports' });
  }
  return { report, claimLedger, evidenceGraph: { nodes, edges } };
}

export function writeQualityArtifacts(outDir: string, facts: RepoFacts, cards: ModuleCard[], questions: Question[], target: number = DEFAULT_QUESTION_TARGET): QualityReport {
  const result = buildQualityReport(facts, cards, questions, target);
  fs.writeFileSync(path.join(outDir, 'quality-report.json'), JSON.stringify(result.report, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, 'claim-ledger.json'), JSON.stringify(result.claimLedger, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, 'evidence-graph.json'), JSON.stringify(result.evidenceGraph, null, 2), 'utf8');
  const r = result.report;
  const md = [`# 质量门禁报告`, '', `- 等级:${r.grade}`, `- 综合分数:${r.score}/100`, `- 题目配额:${r.totalQuestions}/${r.quota} (${Math.round(r.quotaCompleteness * 100)}%)`, `- 已校验率:${Math.round(r.verifiedRate * 100)}%`, `- 有效引用率:${Math.round(r.validCitationRate * 100)}%`, `- 引用文件覆盖率:${Math.round(r.citationFileCoverage * 100)}%`, `- 引用边界通过率:${Math.round(r.citationBoundaryPassRate * 100)}%`, `- 标红:${r.flaggedCount}`, `- 未覆盖:${r.unverifiedCount}`, `- 无引用:${r.uncoveredCount}`, `- 空模块卡:${r.emptyCardCount}`, `- 降级记录:${r.degradationCount}`, `- 证据重复率:${Math.round(r.evidenceDuplicationRate * 100)}%`, '', r.aPlusEligible ? '> A+ 门禁通过。' : `> A+ 门禁未通过:${r.reasons.join('；') || '综合分数不足'}`, ''];
  fs.writeFileSync(path.join(outDir, '质量门禁报告.md'), md.join('\n'), 'utf8');
  return r;
}
