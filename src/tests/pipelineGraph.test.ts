import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { invokePipelineGraph } from '../core/pipelineGraph';
import { makeTempDir, cleanup } from './helpers';

test('LangGraph 管线入口:执行真实节点并落盘最小生命周期 checkpoint', async () => {
  const dir = makeTempDir();
  try {
    const checkpoint = path.join(dir, '.pipeline-graph.json');
    const result = await invokePipelineGraph({ runId: 'run-test', checkpointPath: checkpoint, execute: async () => ({ outDir: '/safe/output' }) });
    assert.equal(result.outDir, '/safe/output');
    const saved = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
    assert.equal(saved.status, 'completed');
    assert.equal(saved.runId, 'run-test');
    assert.equal(saved.outDir, '/safe/output');
  } finally { cleanup(dir); }
});

test('LangGraph 管线入口:失败写 checkpoint 且向调用方保留原始错误', async () => {
  const dir = makeTempDir();
  try {
    const checkpoint = path.join(dir, '.pipeline-graph.json');
    await assert.rejects(invokePipelineGraph({ runId: 'run-failed', checkpointPath: checkpoint, execute: async () => { throw new Error('network lost'); } }), /network lost/);
    assert.equal(JSON.parse(fs.readFileSync(checkpoint, 'utf8')).status, 'failed');
  } finally { cleanup(dir); }
});
