'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {performance} = require('node:perf_hooks');
const {profileRepo} = require('../dist/core/profiler');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-benchmark-'));
async function main() {
  const fileCount = 2000;
  const source = ('export function validate(value) { return value; } // cache retry mutex\n').repeat(100);
  for (let i=0; i<fileCount; i++) fs.writeFileSync(path.join(root, `file-${i}.ts`), source);
  const memoryBefore = process.memoryUsage().rss;
  const started = performance.now();
  const pendingTick = new Promise(resolve => setImmediate(() => resolve(performance.now()-started)));
  const facts = profileRepo(root, 40);
  const elapsed = performance.now()-started;
  const blocked = await pendingTick;
  const result = {node:process.version,platform:process.platform,fileCount,sourceBytes:Buffer.byteLength(source)*fileCount,profileMs:+elapsed.toFixed(2),eventLoopCallbackDelayMs:+blocked.toFixed(2),rssDeltaBytes:process.memoryUsage().rss-memoryBefore,selectedFiles:facts.readingPlan.length,note:'Single synthetic local run; not an LLM or production throughput benchmark.'};
  console.log(JSON.stringify(result,null,2));
}
main().catch(e => {console.error(e);process.exitCode=1;}).finally(() => {
  if (!root.startsWith(path.join(os.tmpdir(), 'interview-benchmark-'))) throw new Error('Unexpected fixture root');
  fs.rmSync(root,{recursive:true,force:true});
});
