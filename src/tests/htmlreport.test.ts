import { test } from 'node:test';
import * as assert from 'node:assert';
import { renderHtml } from '../report/htmlReport';
import { ProjectKnowledge, Question } from '../core/schemas';
import { comparisonTableMd, sanitizeMdCell } from '../stages/stage5Assemble';

const knowledge: ProjectKnowledge = {
  一句话定位: '一个演示项目',
  业务背景: 'x',
  架构描述: 'x',
  数据流: 'x',
  技术栈: [],
  亮点: [],
  缺点: [],
};

const mkQ = (over: Partial<Question> = {}): Question => ({
  id: 'Q01',
  category: '核心模块深挖',
  difficulty: '基础',
  question: '问题 <script>alert(1)</script>',
  考察点: '考察 "点" & <b>',
  答案要点: ['要点 <img src=x onerror=alert(1)>'],
  代码依据: [{ file: 'src/a.ts', lines: '1-9' }],
  追问链: [{ 问题: '追问 1', 参考要点: '参考要点说明内容' }],
  加分回答: '加分 \' 引号',
  常见错误回答: '错误 "双引号"',
  ...over,
});

test('renderHtml:全文无内联事件处理器(nonce CSP 可生效)', () => {
  const html = renderHtml({ knowledge, questions: [mkQ()], stats: { pass: 1, fix: 0, flag: 0 }, model: 'm', generatedAt: 't' });
  assert.ok(!/on(click|input|change)\s*=/i.test(html), '不得出现内联事件处理器');
  assert.ok(html.includes('data-id="Q01"'), '按钮应使用 data-id 委托');
});

test('renderHtml:LLM 文本中的标签与引号被转义', () => {
  const html = renderHtml({ knowledge, questions: [mkQ()], stats: { pass: 0, fix: 0, flag: 0 }, model: 'm', generatedAt: 't' });
  assert.ok(!html.includes('<script>alert(1)</script>'), '题面中的 script 必须被转义');
  assert.ok(!html.includes('<img src=x'), '要点中的 img 必须被转义');
  assert.ok(html.includes('&lt;script&gt;'));
});

test('renderHtml:localStorage 键按仓库隔离', () => {
  const html = renderHtml({
    knowledge,
    questions: [mkQ()],
    stats: { pass: 0, fix: 0, flag: 0 },
    model: 'm',
    generatedAt: 't',
    repoKey: 'abc123',
  });
  assert.match(html, /cip-progress-v2-abc123-[a-f0-9]{12}/);
  const html2 = renderHtml({ knowledge, questions: [mkQ()], stats: { pass: 0, fix: 0, flag: 0 }, model: 'm', generatedAt: 't' });
  assert.ok(!html2.includes('cip-progress-abc123'));
});

test('renderHtml:状态组合筛选/主题/学习进度与题库版本隔离均为本地事件委托', () => {
  const html = renderHtml({
    knowledge,
    questions: [mkQ({ verified: 'flag' })],
    stats: { pass: 0, fix: 0, flag: 1, unverified: 0 },
    quality: { grade: 'B', score: 82, aPlusEligible: false },
    model: 'm', generatedAt: 't', repoKey: 'repo',
  });
  assert.ok(html.includes('只练未掌握'));
  assert.ok(html.includes('只看标红/未覆盖'));
  assert.ok(html.includes('themeBtn') && html.includes('exportBtn'));
  assert.ok(html.includes('quality'));
  assert.match(html, /questionVersion/);
  assert.ok(!/<(?:button|input|select)[^>]+\bon(?:click|input|change)\s*=/i.test(html));
});

test('renderHtml:unverified 题显示未覆盖徽标', () => {
  const html = renderHtml({
    knowledge,
    questions: [mkQ({ verified: 'unverified' })],
    stats: { pass: 0, fix: 0, flag: 0 },
    model: 'm',
    generatedAt: 't',
  });
  assert.ok(html.includes('未覆盖'));
});

test('sanitizeMdCell:竖线转义、换行压平(表格不再被拆散)', () => {
  assert.strictEqual(sanitizeMdCell('a || b'), 'a \\|\\| b');
  assert.strictEqual(sanitizeMdCell('第一行\n第二行'), '第一行 第二行');
  assert.strictEqual(sanitizeMdCell(undefined), '');
});

test('comparisonTableMd:模型重复回显表头时只渲染一个表头', () => {
  const lines = comparisonTableMd({
    对比: { 候选方案: ['A', 'B'], 维度: ['性能', '成本'], 对比表: [['方案', '性能', '成本'], ['A', '高', '低'], ['B', '中', '中']], 结论: '按场景选择' },
  } as any);
  assert.equal(lines.filter((line) => line === '| 方案 | 性能 | 成本 |').length, 1);
  assert.ok(lines.includes('| A | 高 | 低 |'));
});
