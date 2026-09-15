import { test } from 'node:test';
import * as assert from 'node:assert';
import { renderHtml } from '../report/htmlReport';
import { ProjectKnowledge, Question } from '../core/schemas';
import { sanitizeMdCell } from '../stages/stage5Assemble';

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
  追问链: ['追问 1'],
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
  assert.ok(html.includes('cip-progress-abc123'));
  const html2 = renderHtml({ knowledge, questions: [mkQ()], stats: { pass: 0, fix: 0, flag: 0 }, model: 'm', generatedAt: 't' });
  assert.ok(!html2.includes('cip-progress-abc123'));
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
