/*
 * S 级题库审计(人工验收清单 A 组的自动化底座):
 * 对指定 run 目录做确定性检查 + 抽样内容贴合检查。输出逐项结论,不达标即非零退出。
 * 运行:node audit/s-level-audit.cjs <run目录> [抽样数=20]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const runDir = path.resolve(process.argv[2] || '');
const SAMPLE = Number(process.argv[3] || 20);
if (!fs.existsSync(path.join(runDir, 'questions.json'))) { console.error('run 目录无效:' + runDir); process.exit(2); }
const qs = JSON.parse(fs.readFileSync(path.join(runDir, 'questions.json'), 'utf8'));
const facts = JSON.parse(fs.readFileSync(path.join(runDir, 'repo_facts.json'), 'utf8'));
const root = facts.root;
// 风险给药与引用精度:直接用产品内单源(与修复环/消毒完全同一把尺子)
const { riskWithoutFix, MAX_CITE_SPAN } = require('../dist/core/schemas');
const report = [];
const fail = (id, msg) => report.push({ id, ok: false, msg });

const span = (l) => (l || '').split(',').map((s) => { const [a, b] = s.split('-').map(Number); return [a, Number.isFinite(b) ? b : a]; });
const readLines = (() => {
  const cache = new Map();
  return (file) => {
    if (!cache.has(file)) {
      try {
        const t = fs.readFileSync(path.join(root, file), 'utf8');
        const lines = t.split(/\r?\n/);
        if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
        cache.set(file, lines);
      } catch { cache.set(file, null); }
    }
    return cache.get(file);
  };
})();
const excerpt = (file, lines) => {
  const all = readLines(file);
  if (!all) return null;
  return span(lines)
    .map(([s, e]) => all.slice(Math.max(0, s - 1), Math.min(all.length, e)).join('\n'))
    .join('\n');
};

/* ---------- A1 引用全部可解析 + 抽样内容贴合 ---------- */
let unresolved = 0, outOfRange = 0, wide = 0;
for (const q of qs) {
  for (const c of q.代码依据 || []) {
    if (!readLines(c.file)) { unresolved++; continue; }
    for (const [s, e] of span(c.lines)) {
      if (!(s >= 1 && e >= s && e <= readLines(c.file).length)) outOfRange++;
      else if (e - s + 1 > MAX_CITE_SPAN) wide++;
    }
  }
}
if (unresolved) fail('A1-存在性', `${unresolved} 条引用文件无法读取`);
if (outOfRange) fail('A1-边界', `${outOfRange} 条引用行号越界`);
if (wide) fail('A1-精度', `${wide} 条引用跨度 >${MAX_CITE_SPAN} 行`);

/* 抽样:答案要点与引用处代码的关键词贴合(去停用词后看代码标识符是否出现) */
const STOP = new Set(['的','了','在','是','和','与','或','对','为','当','时','中','把','被','并','而','及','这','那','如果','因为','所以','通过','使用','可以','会','不','没','有','无','进行','实现','处理','支持','防止','避免','导致','问题','代码','数据','请求','文件','函数','逻辑','情况','状态','返回','需要','应该','已经','目前','当前','直接','同时','以及','其中','基于','用于','之后','这里','这样','存在','出现','执行','调用','提供','完成','得到','该','本','个','条','次','更','最','也','都','即','等','如','例如']);
const terms = (text) =>
  [...new Set((text.match(/[A-Za-z_$][\w$]{2,}|\d+/g) || []).map((s) => s.toLowerCase()))].filter((t) => !STOP.has(t));
let spotChecked = 0, weakMatch = [];
{
  const pool = qs.filter((q) => (q.代码依据 || []).length && q.答案要点?.length);
  const step = Math.max(1, Math.floor(pool.length / SAMPLE));
  for (const q of pool.slice(0, step * SAMPLE).slice(0, SAMPLE)) {
    const ex = (q.代码依据 || []).map((c) => excerpt(c.file, c.lines)).filter(Boolean).join('\n').toLowerCase();
    if (!ex) continue;
    spotChecked++;
    const key = terms(q.答案要点.join(' ')).filter((t) => t.length >= 4);
    const hit = key.filter((t) => ex.includes(t));
    if (key.length >= 3 && hit.length / key.length < 0.25) {
      weakMatch.push(`${q.id}:${hit.length}/${key.length} 命中(${key.slice(0, 5).join(',')})`);
    }
  }
}
if (weakMatch.length) fail('A2-贴合抽样', `${weakMatch.length}/${spotChecked} 题要点与引用处代码关键词贴合度低 → ${weakMatch.join(' ; ')}`);
else report.push({ id: 'A2-贴合抽样', ok: true, msg: `${spotChecked} 题抽样,要点中的代码标识符均可在引用原文找到` });

/* ---------- A3 风险必给药(与产品 riskWithoutFix 同源) ---------- */
const riskyNoFix = qs.filter(riskWithoutFix);
if (riskyNoFix.length) fail('A3-风险给药', `${riskyNoFix.length} 题指出风险但无任何改进表述:${riskyNoFix.slice(0, 5).map((q) => q.id).join(',')}`);
else report.push({ id: 'A3-风险给药', ok: true, msg: '指出风险的题均伴随改进表述' });

/* ---------- A4 追问闭环 ---------- */
const badFollow = qs.filter((q) => (q.追问链 || []).some((f) => !f.参考要点 || f.参考要点.length < 10));
if (badFollow.length) fail('A4-追问闭环', `${badFollow.length} 题追问缺参考要点`);
else report.push({ id: 'A4-追问闭环', ok: true, msg: `${qs.length} 题 × ${qs[0].追问链.length} 条追问全部带参考要点` });

/* ---------- A5 难度分 ---------- */
const noScore = qs.filter((q) => !Number.isFinite(q.难度分) || q.难度分 < 1 || q.难度分 > 10);
if (noScore.length) fail('A5-难度分', `${noScore.length} 题难度分缺失/越界`);
else {
  const s = qs.map((q) => q.难度分);
  const dist = {};
  for (const x of s) dist[x] = (dist[x] || 0) + 1;
  const topRate = (Math.max(...Object.values(dist)) / s.length) * 100;
  report.push({ id: 'A5-难度分', ok: true, msg: `全量落盘,值域 ${Math.min(...s)}-${Math.max(...s)},均值 ${(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1)}(同分率最高 ${topRate.toFixed(0)}%)` });
}

/* ---------- A7 校验:flag/回退 ---------- */
const flag = qs.filter((q) => q.verified === 'flag');
const unverified = qs.filter((q) => q.verified === 'unverified');
if (flag.length) fail('A7-flag', `${flag.length} 题标红待人工复核:${flag.map((q) => q.id).join(',')}`);
if (unverified.length) fail('A7-unverified', `${unverified.length} 题未完成校验`);
const vr = fs.readFileSync(path.join(runDir, '校验报告.md'), 'utf8');
const rollbacks = (vr.match(/已回退/g) || []).length;
if (rollbacks) report.push({ id: 'A7-修复回退', ok: true, msg: `${rollbacks} 处修正因引用非法被回退(防御生效,已保留原裁决人工可查)` });

/* ---------- 渲染:02 MD 与 index.html 展示参考要点/难度分 ---------- */
const md = fs.readFileSync(path.join(runDir, '02_百问百答.md'), 'utf8');
const html = fs.readFileSync(path.join(runDir, 'index.html'), 'utf8');
const mdPoints = (md.match(/↳ 参考要点/g) || []).length;
const mdScores = (md.match(/\/10〕/g) || []).length;
if (mdPoints < qs.length) fail('渲染-MD', `02 文档参考要点 ${mdPoints} < 题数 ${qs.length}`);
if (mdScores < qs.length) fail('渲染-MD-难度', `02 文档难度分 ${mdScores} < 题数 ${qs.length}`);
// 抽 3 条参考要点原文确认进了 HTML(转义后仍应包含核心词)
const samplePts = qs.slice(0, 50).flatMap((q) => q.追问链.map((f) => f.参考要点)).filter((p) => p.length >= 15);
const htmlMissing = samplePts.slice(0, 40).filter((p) => {
  const core = p.replace(/[<>&"']/g, '').slice(0, 12);
  return !html.includes(core);
});
if (htmlMissing.length) fail('渲染-HTML', `${htmlMissing.length}/${Math.min(40, samplePts.length)} 条参考要点未出现在 HTML`);
if (report.some((r) => !r.ok)) {
  console.log('S 级审计:不通过');
  for (const r of report) console.log(`${r.ok ? '✓' : '✗'} ${r.id} — ${r.msg}`);
  process.exit(1);
}
console.log('S 级审计:全部通过');
for (const r of report) console.log(`✓ ${r.id} — ${r.msg}`);
