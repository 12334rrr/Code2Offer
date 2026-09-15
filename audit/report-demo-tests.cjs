/* Independent audit: loads TypeScript in memory; no API calls or .env reads. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const ts = require('../node_modules/typescript');
const root = path.resolve(__dirname, '..');
const results = [];
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
function compile(p, mocks = {}, extras = {}) {
  const exports = {};
  const code = ts.transpileModule(read(p), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const context = { exports, require: name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    throw Error('Unexpected dependency (blocked): ' + name);
  }, console: { log() {}, warn() {}, error() {} }, ...extras };
  vm.runInNewContext(code, context, { filename: p });
  return exports;
}
function record(id, evidence) { results.push({ id, ...evidence }); console.log(JSON.stringify(results.at(-1))); }
const renderer = compile('src/report/htmlReport.ts');
const knowledge = { 一句话定位: 'Synthetic audit project', 业务背景: 'audit', 架构描述: 'audit', 数据流: 'audit', 技术栈: [], 亮点: [], 缺点: [] };
const question = (id = 'Q01', overrides = {}) => ({ id, category: '测试', difficulty: '基础', question: '这是一道用于测试的题目', 考察点: 'test', 答案要点: ['one', 'two'], 代码依据: [{ file: 'test.js', lines: '1' }], 追问链: ['why', 'how'], 加分回答: 'bonus', 常见错误回答: 'wrong', verified: 'pass', ...overrides });
const render = (questions = [question()]) => renderer.renderHtml({ knowledge, questions, stats: { pass: questions.length, fix: 0, flag: 0 }, model: 'synthetic-no-api', generatedAt: '2026-09-15T00:00:00.000Z' });

function runReport(html, questions, shared = new Map()) {
  const elements = { sidebar: { innerHTML: '', querySelectorAll() { return []; } }, search: { value: '' }, catSel: { value: '' }, empty: { classList: { toggle() {} } } };
  const cards = questions.map(q => ({ id: q.id, style: {}, getAttribute(name) { return ({ 'data-cat': q.category, 'data-diff': q.difficulty, 'data-must': '0', 'data-text': q.question })[name]; } }));
  for (const q of questions) elements['st-' + q.id] = { textContent: '', style: {} };
  const sandbox = { document: { querySelectorAll(selector) { return selector === '.card' ? cards : []; }, getElementById(id) { return elements[id]; } }, localStorage: { getItem(k) { return shared.get(k) ?? null; }, setItem(k, v) { shared.set(k, v); } } };
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return { sandbox, elements, shared };
}

async function cli(args) {
  const captured = [];
  const cfg = {};
  compile('src/cli/index.ts', {
    fs: {}, path,
    '../core/config': { loadConfig: () => cfg },
    '../core/deepseek': { DeepSeekClient: class {} },
    '../core/runner': { runPipeline: async o => captured.push({ command: 'generate', ...o }), runEvaluationOnly: async o => captured.push({ command: 'evaluate', outDir: o }) },
    '../stages/stage6Rehearse': { runRehearsal: async o => captured.push({ command: 'rehearse', ...o, client: undefined }) },
    '../core/prompts': {}, '../core/chunker': {}, '../stages/stage2Questions': {},
  }, { process: { argv: ['node', 'cli', ...args], exit: code => captured.push({ exitCode: code }) } });
  await new Promise(resolve => setImmediate(resolve));
  return captured;
}

function request(port, method, route, payload) {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? undefined : JSON.stringify(payload);
    const req = http.request({ hostname: '127.0.0.1', port, method, path: route, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { const raw = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, bytes: Buffer.byteLength(raw), body: raw ? JSON.parse(raw) : null }); });
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function main() {
  const pair = [question('Q01'), question('Q02')];
  const a = runReport(render(pair), pair);
  a.sandbox.mark('Q01', 1);
  const b = runReport(render([question('Q01', { question: '另一个仓库的不同题目' })]), [question()], a.shared);
  record('HTML-PROGRESS', { storeKey: a.sandbox.STORE_KEY, markedOfTotal: '1/2', sidebarShows100Percent: a.elements.sidebar.innerHTML.includes('100%'), secondReportInheritedMark: b.elements['st-Q01'].textContent });
  let badStorage;
  try { runReport(render(), [question()], new Map([['cip-progress-v1', 'null']])); } catch(e) { badStorage = e.message; }
  record('HTML-NULL-STORAGE', { error: badStorage });
  const html = render();
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  record('HTML-EMPTY', { emptyMarkedHidden: html.includes('class="empty hidden"'), genericHiddenRule: /(?:^|[}\s,])\.hidden\s*[{,]/.test(css), answerHiddenOnly: css.includes('.answer.hidden{display:none}') });
  const payload = "Q01');globalThis.auditInjected=1;//";
  const injectedHtml = render([question(payload)]);
  const onclick = injectedHtml.match(/onclick="(toggleAnswer[^\"]*)"/)[1];
  const proof = { toggleAnswer() {} };
  vm.runInNewContext(onclick, proof);
  record('HTML-ID-INJECTION', { payload, handler: onclick, executedMarker: proof.auditInjected, limitation: 'Synthetic externally supplied ID; normal stage 2 assigns Qxx IDs.' });
  record('HTML-ESCAPE', { modelTextEscaped: render([question('Q01', { question: '<img src=x onerror=alert(1)>' })]).includes('&lt;img src=x onerror=alert(1)&gt;') });

  record('CLI-FORCE', { normal: await cli(['generate', './repo', '--force']), reordered: await cli(['generate', '--force', './repo']) });
  const invalid = await cli(['generate', './repo', '--max-files', 'abc']);
  record('CLI-NUMBERS', { invalid, maxFilesIsNaN: Number.isNaN(invalid[0]?.maxFiles), negativeCount: await cli(['rehearse', './output', '--count', '-1']) });
  record('CLI-FLAGS', { missingJdValue: await cli(['generate', './repo', '--jd']), typoIgnored: await cli(['generate', './repo', '--jdd', 'job.txt']), helpExit: await cli(['--help']) });

  const prompts = compile('src/core/prompts.ts').buildPromptDocs();
  const normalize = s => s.replace(/\r\n/g, '\n');
  const drift = prompts.filter(d => normalize(read('docs/prompts/' + d.file)) !== normalize(`# ${d.title}\n\n> ${d.description}\n\n${d.body}\n`)).map(d => d.file);
  const template = prompts.find(d => d.file === '横向对比模板.md').body.split('\n').filter(l => l.startsWith('|'));
  record('PROMPTS', { exportedCount: prompts.length, filesOutOfSync: drift, comparisonTableColumnCounts: template.map(l => l.split('|').length - 2) });

  for (const dir of ['interview-output', 'example-demo/interview-output']) {
    const qs = JSON.parse(read(dir + '/questions.json'));
    const cram = read(dir + '/06_速记卡.md');
    const flaggedInCram = qs.filter(q => q.verified === 'flag' && cram.includes('**' + q.id + '**')).map(q => q.id);
    const md = read(dir + '/02_百问百答.md');
    record('ARTIFACTS-' + dir, { total: qs.length, byVerdict: qs.reduce((acc, q) => (acc[q.verified ?? 'unverified'] = (acc[q.verified ?? 'unverified'] ?? 0) + 1, acc), {}), categories: new Set(qs.map(q => q.category)).size, difficulties: [...new Set(qs.map(q => q.difficulty))], flaggedInCram, cramContainsWarning: /存疑|标红|flag|复核/.test(cram), qaCharacters: md.length, htmlBytes: Buffer.byteLength(read(dir + '/index.html')) });
  }

  const assembly = compile('src/stages/stage5Assemble.ts', {
    fs, path,
    '../core/prompts': { STAGE5_NARRATIVE_SYSTEM: 'audit', STAGE5_HIGHLIGHTS_SYSTEM: 'audit', STAGE5_WEAKNESS_SYSTEM: 'audit', STAGE5_DECISIONS_SYSTEM: 'audit' },
    '../core/cache': { PROMPT_VERSION: 'audit' },
    '../report/htmlReport': renderer,
  });
  const fixtureDir = path.join(__dirname, 'stage5-fixture');
  const fakeClient = { model: 'synthetic-no-api', chat: async () => '# Synthetic narrative\nNo LLM call was made.' };
  const fakeCache = { key: () => 'audit', get: () => undefined, set() {} };
  await assembly.runStage5(fakeClient, fakeCache, { overview: { totalFiles: 1, totalLOC: 1, languages: { '.js': { loc: 1 } } }, routes: [], dbTables: [], hotspots: [], testEvidence: { files: [], testCount: 0, assertCount: 0 } }, [], knowledge, [question('Q01', { verified: 'flag', verifyNote: 'Audit: unsupported claim' })], fixtureDir);
  const fixtureCram = fs.readFileSync(path.join(fixtureDir, '06_速记卡.md'), 'utf8');
  record('CRAM-FLAG', { includesFlaggedQuestion: fixtureCram.includes('**Q01**'), includesWarning: /存疑|标红|flag|复核|unsupported/.test(fixtureCram) });

  const actualQs = JSON.parse(read('example-demo/interview-output/questions.json'));
  record('ARTIFACT-204-CONTRADICTION', { selected: actualQs.filter(q => ['Q42', 'Q54', 'Q57', 'Q60', 'Q87', 'Q91'].includes(q.id)).map(q => ({ id: q.id, verified: q.verified, verifyNote: q.verifyNote, relevantAnswers: q.答案要点.filter(t => /204/.test(t)), relevantFollowUps: q.追问链.filter(t => /204/.test(t)) })) });

  const baseline = spawnSync(process.execPath, ['tests/store.test.js'], { cwd: path.join(root, 'example-demo'), encoding: 'utf8' });
  record('DEMO-BASELINE', { exitCode: baseline.status, stdout: baseline.stdout.trim(), stderr: baseline.stderr.trim() });
  process.env.LOG_LEVEL = 'error';
  const { TaskStore } = require('../example-demo/store');
  const sample = new TaskStore();
  sample.create({ title: 'a', status: 'doing', assignee: 'alice' });
  sample.create({ title: 'b', status: 'doing', assignee: 'bob' });
  record('DEMO-FILTER', { requested: { status: 'doing', assignee: 'alice' }, result: sample.list({ status: 'doing', assignee: 'alice' }) });
  const { server, limiter } = require('../example-demo/server');
  limiter.capacity = 1000;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const first = await request(port, 'GET', '/api/tasks?status=doing');
    const created = await request(port, 'POST', '/api/tasks', { title: 'new', status: 'doing' });
    const stalePost = await request(port, 'GET', '/api/tasks?status=doing');
    const patched = await request(port, 'PATCH', '/api/tasks/2', { status: 'done' });
    const stalePatch = await request(port, 'GET', '/api/tasks?status=doing');
    const deleted = await request(port, 'DELETE', '/api/tasks/3');
    const staleDelete = await request(port, 'GET', '/api/tasks?status=doing');
    record('DEMO-CACHE', { firstTotal: first.body.total, createdStatus: created.status, postTotal: stalePost.body.total, postContainsCreated: stalePost.body.items.some(t => t.id === created.body.id), patchStatus: patched.status, patchQueryContainsDone: stalePatch.body.items.some(t => t.status === 'done'), deletedStatus: deleted.status, deleteQueryContainsDeleted: staleDelete.body.items.some(t => t.id === 3) });
    record('DEMO-204', { responseStatus: deleted.status, responseBodyBytes: deleted.bytes, disprovesSavedNarrativeClaim: 'Saved demo narrative claims 4 bytes null are actually sent; Node suppressed the body.' });
    record('DEMO-NEGATIVE-LIMIT', { response: await request(port, 'GET', '/api/tasks?limit=-1') });
    record('DEMO-ARRAY-PATCH', { response: await request(port, 'PATCH', '/api/tasks/2', []) });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  const csp = "default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-auditnonce'; img-src data:;";
  const probe = `\nvar auditResult = {};\nvar auditAnswer = document.querySelector('.answer');\nauditResult.initialHidden = getComputedStyle(auditAnswer).display === 'none';\ndocument.querySelector('.card-foot button').click();\nauditResult.hiddenAfterClick = getComputedStyle(auditAnswer).display === 'none';\nauditResult.emptyVisible = getComputedStyle(document.getElementById('empty')).display !== 'none';\nvar out = document.createElement('pre'); out.id='audit-result'; out.textContent=JSON.stringify(auditResult); document.body.appendChild(out);\n`;
  fs.mkdirSync(path.join(__dirname, 'browser-probes'), { recursive: true });
  for (const mode of ['plain', 'webview-csp']) {
    let candidate = html.replace('</script>', probe + '</script>');
    if (mode === 'webview-csp') candidate = candidate.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`).replace('<script>', '<script nonce="auditnonce">');
    const file = path.join(__dirname, 'browser-probes', mode + '.html');
    fs.writeFileSync(file, candidate);
  }
  record('BROWSER-LIMITATION', { status: 'NOT_EXECUTED_SUCCESSFULLY', reason: 'Initial Edge headless attempts yielded no observable output. CUA then refused localhost because the admin-enforced browser policy could not be verified. Browser control was not retried or bypassed. Fixtures are saved for a later authorized manual run; this suite does not launch browsers.' });
  fs.writeFileSync(path.join(__dirname, 'report-demo-results.json'), JSON.stringify({ node: process.version, date: new Date().toISOString(), results }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
