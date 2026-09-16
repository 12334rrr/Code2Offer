import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { estimatedCalls, modelForPolicy, policyFor } from '../core/policy';

test('RequestPolicy:所有请求类型都有显式预算/超时/重试/缓存/并发策略', () => {
  const types = ['stage1-module', 'stage1-synthesis', 'stage2-question', 'stage2-repair', 'stage2-comparison', 'stage2-points', 'stage3-verify', 'stage3-rewrite', 'stage4-jd', 'stage5-narrative', 'stage6-rehearse', 'evaluate'] as const;
  for (const type of types) {
    const p = policyFor(type, 'mock', 1234, 'balanced');
    assert.equal(p.requestType, type);
    assert.ok(p.baseMaxTokens > 0 && p.hardMaxTokens >= p.baseMaxTokens);
    assert.ok(p.timeout > 0 && p.retries >= 0 && p.concurrencyGroup);
  }
});

test('运行模式:经济模式明确是预览,平衡/深度保留 100 题目标', () => {
  assert.match(estimatedCalls('economy').note, /40/);
  assert.match(estimatedCalls('balanced').note, /100/);
  assert.match(estimatedCalls('deep').note, /100/);
});

test('推理型模型:结构化 JSON 请求优先使用 chat,叙述任务保留用户模型', () => {
  assert.equal(modelForPolicy('deepseek-flash', 'prefer-fast'), 'deepseek-chat');
  assert.equal(policyFor('stage1-module', 'deepseek-flash').model, 'deepseek-chat');
  assert.equal(policyFor('stage3-verify', 'deepseek-reasoner').model, 'deepseek-chat');
  assert.equal(policyFor('stage5-narrative', 'deepseek-flash').model, 'deepseek-flash');
});
