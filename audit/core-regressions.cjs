/* Offline audit probes. PASS means the observed defect was reproduced, not fixed. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { profileRepo } = require('../dist/core/profiler');
const { loadChunks } = require('../dist/core/chunker');
const { DeepSeekClient } = require('../dist/core/deepseek');

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-core-audit-'));
  t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'interview-core-audit-'))); fs.rmSync(root, {recursive:true, force:true}); });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name); fs.mkdirSync(path.dirname(target), {recursive:true}); fs.writeFileSync(target, content);
  }
  return root;
}

test('C01 synthetic .env secret is selected and rendered into source chunks', t => {
  const root = fixture(t, {'.env':'DEEPSEEK_API_KEY=FAKE_AUDIT_SENTINEL', 'index.js':'export const x = 1;'});
  const facts = profileRepo(root);
  assert.ok(facts.readingPlan.includes('.env'));
  assert.ok(loadChunks(root, facts.readingPlan).chunks.some(c => c.content.includes('FAKE_AUDIT_SENTINEL')));
});
test('C02 root-anchored gitignore rule fails to exclude secret file', t => {
  const root = fixture(t, {'.gitignore':'/secret.ts\n', 'secret.ts':'const secret = "FAKE";', 'index.js':'export {};'});
  assert.ok(profileRepo(root).files.includes('secret.ts'));
});
test('C03 nested .gitignore is ignored', t => {
  const root = fixture(t, {'sub/.gitignore':'private.ts\n', 'sub/private.ts':'const secret = "FAKE";', 'index.js':'export {};'});
  assert.ok(profileRepo(root).readingPlan.includes('sub/private.ts'));
});
test('C04 character-class ignore rule is silently skipped', t => {
  const root = fixture(t, {'.gitignore':'secret[0-9].ts\n', 'secret1.ts':'const secret = "FAKE";', 'index.js':'export {};'});
  const facts = profileRepo(root);
  assert.ok(facts.files.includes('secret1.ts'));
  assert.ok(!facts.notes.some(n => n.includes('secret[0-9]')));
});
test('C05 globstar ignore rule fails for ordinary nested path', t => {
  const root = fixture(t, {'.gitignore':'**/secret.ts\n', 'a/b/secret.ts':'const secret = "FAKE";', 'index.js':'export {};'});
  assert.ok(profileRepo(root).files.includes('a/b/secret.ts'));
});
test('C06 290000-character line bypasses nominal 14000-character chunk limit', t => {
  const root = fixture(t, {'large.ts':'x'.repeat(290000)});
  const result = loadChunks(root, ['large.ts']);
  assert.equal(result.chunks[0].content.length, 290000);
  assert.equal(result.truncated.length, 0);
});
test('C07 module grouping silently drops modules after twelve', () => {
  const { groupByModule } = require('../dist/stages/stage1Read');
  const chunks = Array.from({length:13}, (_, i) => ({file:`m${i}/file.ts`, startLine:1, endLine:2, content:'export {};'}));
  assert.equal(groupByModule(chunks).length, 12);
});
test('C08 Map.get is classified as HTTP route', t => {
  const root = fixture(t, {'index.ts':'const cache = new Map();\ncache.get("admin-token");'});
  assert.ok(profileRepo(root).routes.some(r => r.route === 'admin-token' && r.method === 'GET'));
});
test('C09 package-relative main entry is lost in a monorepo', t => {
  const root = fixture(t, {'packages/a/package.json':'{"main":"lib/entry.js"}', 'packages/a/lib/entry.js':'export {};'});
  assert.deepEqual(profileRepo(root).overview.entryPoints, []);
});

function configWith(files, env={}) {
  const exports = {};
  const fakeFs = { existsSync:p => Object.hasOwn(files,p), readFileSync:p => files[p] };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../dist/core/config.js'),'utf8'), {
    exports, require:id => id === 'fs' ? fakeFs : path, __dirname:path.resolve('/audit-tool/dist/core'),
    process:{env, cwd:() => path.resolve('/audit-cwd')}
  });
  return exports.loadConfig(path.resolve('/audit-target'));
}
test('C10 tool-root .env overwrites target-repository .env', () => {
  const cfg = configWith({[path.resolve('/audit-target/.env')]:'DEEPSEEK_API_KEY=FAKE_TARGET', [path.resolve('/audit-tool/.env')]:'DEEPSEEK_API_KEY=FAKE_TOOL'});
  assert.equal(cfg.apiKey, 'FAKE_TOOL');
});
test('C11 repository-controlled HTTP endpoint pairs with environment API key', () => {
  const cfg = configWith({[path.resolve('/audit-target/.env')]:'DEEPSEEK_BASE_URL=http://untrusted.invalid'}, {DEEPSEEK_API_KEY:'FAKE_ENV_KEY'});
  assert.equal(cfg.baseUrl, 'http://untrusted.invalid');
  assert.equal(cfg.apiKey, 'FAKE_ENV_KEY');
});
test('C12 inline .env comment becomes part of credential', () => {
  const cfg = configWith({[path.resolve('/audit-target/.env')]:'DEEPSEEK_API_KEY=FAKE_KEY # comment'});
  assert.equal(cfg.apiKey, 'FAKE_KEY # comment');
});
test('C13 infinite timeout accepted by config', () => {
  const cfg = configWith({}, {DEEPSEEK_API_KEY:'FAKE_KEY', DEEPSEEK_TIMEOUT_MS:'Infinity'});
  assert.equal(cfg.timeoutMs, Infinity);
  assert.throws(() => AbortSignal.timeout(cfg.timeoutMs), {code:'ERR_OUT_OF_RANGE'});
});
test('C14 nonempty token-truncated completion accepted as success', async t => {
  const original = global.fetch; t.after(() => global.fetch = original);
  global.fetch = async () => ({ok:true, text:async () => JSON.stringify({choices:[{message:{content:'## Incomplete output'}, finish_reason:'length'}]})});
  const client = new DeepSeekClient({apiKey:'FAKE', baseUrl:'https://offline.invalid', model:'deepseek-chat'});
  assert.equal(await client.chat([{role:'user',content:'synthetic'}]), '## Incomplete output');
  assert.equal(client.totalCalls, 1);
});
test('C15 authentication failures retried four times; fake echoed secret reaches logs', async () => {
  const exports = {}; let calls = 0; const logs = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../dist/core/deepseek.js'),'utf8'), {
    exports, AbortSignal, setTimeout:callback => {callback(); return 1;}, console:{warn:s => logs.push(s),log:()=>{}},
    fetch:async () => {calls++; return {ok:false,status:401,text:async () => JSON.stringify({error:{message:'invalid key FAKE_ECHOED_KEY'}})};}
  });
  const client = new exports.DeepSeekClient({apiKey:'FAKE_ECHOED_KEY',baseUrl:'https://offline.invalid',model:'deepseek-chat'});
  await assert.rejects(client.chat([{role:'user',content:'synthetic'}]), /FAKE_ECHOED_KEY/);
  assert.equal(calls, 4);
  assert.ok(logs.some(s => s.includes('FAKE_ECHOED_KEY')));
});
