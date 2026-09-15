// 环境配置:默认值 + 环境变量覆盖
'use strict';

function intEnv(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  port: intEnv('PORT', 3000),
  // 限流:每 IP 令牌桶容量与补充速率(个/秒)
  rateLimit: {
    capacity: intEnv('RL_CAPACITY', 20),
    refillPerSec: intEnv('RL_REFILL', 5),
  },
  // 热点数据 LRU 缓存
  cache: {
    maxSize: intEnv('CACHE_MAX', 100),
    ttlMs: intEnv('CACHE_TTL_MS', 30_000),
  },
  logLevel: process.env.LOG_LEVEL || 'info',
};

module.exports = config;
