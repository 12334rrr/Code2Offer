// HTTP 入口:手写极简路由 + 统一错误处理 + 限流 + 缓存旁路
'use strict';

const http = require('http');
const { URL } = require('url');
const config = require('./config');
const { createLogger } = require('./logger');
const { TaskStore } = require('./store');
const { LRUCache } = require('./cache');
const { TokenBucketLimiter } = require('./ratelimit');
const { validateTaskInput } = require('./validate');

const log = createLogger(config.logLevel);
const store = new TaskStore();
const cache = new LRUCache(config.cache.maxSize, config.cache.ttlMs);
const limiter = new TokenBucketLimiter(config.rateLimit.capacity, config.rateLimit.refillPerSec);

// 预置演示数据
store.create({ title: '搭建项目骨架', status: 'done', assignee: 'alice' });
store.create({ title: '实现任务 CRUD', status: 'doing', assignee: 'alice' });
store.create({ title: '接入限流', status: 'doing', assignee: 'bob' });

function send(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

class HttpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** 列表查询缓存:查询串 → 结果(TTL 内直接命中,写操作后整体失效) */
function listFromCacheOrStore(query) {
  const key = 'list?' + query.toString();
  const hit = cache.get(key);
  if (hit !== undefined) {
    log.debug('list cache hit', { key });
    return hit;
  }
  const params = Object.fromEntries(query.entries());
  const limit = Math.min(Number(params.limit) || 50, 200); // 上限保护
  const offset = Math.max(Number(params.offset) || 0, 0);
  const result = store.list({ status: params.status, assignee: params.assignee, limit, offset });
  cache.set(key, result);
  return result;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new HttpError(413, '请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (data === '') return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new HttpError(400, 'JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

const routes = [
  {
    method: 'GET',
    pattern: /^\/api\/tasks$/,
    handler: async (req, res, m, url) => {
      const result = listFromCacheOrStore(url.searchParams);
      send(res, 200, result);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/tasks\/(\d+)$/,
    handler: async (req, res, m) => {
      const task = store.get(Number(m[1]));
      if (!task) throw new HttpError(404, '任务不存在');
      send(res, 200, task);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/tasks$/,
    handler: async (req, res) => {
      const body = await readBody(req);
      const errors = validateTaskInput(body);
      if (errors.length) throw new HttpError(422, errors.join(';'));
      const task = store.create(body);
      cache.invalidate('list?' + new URL(req.url, 'http://x').searchParams.toString());
      send(res, 201, task);
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/tasks\/(\d+)$/,
    handler: async (req, res, m) => {
      const body = await readBody(req);
      const errors = validateTaskInput(body, true);
      if (errors.length) throw new HttpError(422, errors.join(';'));
      const task = store.update(Number(m[1]), body);
      if (!task) throw new HttpError(404, '任务不存在');
      send(res, 200, task);
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/tasks\/(\d+)$/,
    handler: async (req, res, m) => {
      const ok = store.remove(Number(m[1]));
      if (!ok) throw new HttpError(404, '任务不存在');
      send(res, 204, null);
    },
  },
  {
    method: 'GET',
    pattern: /^\/health$/,
    handler: async (req, res) => {
      send(res, 200, {
        status: 'ok',
        tasks: store.count(),
        cache: cache.stats(),
        buckets: limiter.sweep(),
        uptimeSec: Math.floor(process.uptime()),
      });
    },
  },
];

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  const ip = req.socket.remoteAddress ?? 'unknown';
  try {
    // 限流在路由前:省掉无效请求的全部开销
    const permit = limiter.take(ip);
    if (!permit.allowed) {
      res.setHeader('Retry-After', Math.ceil(permit.retryAfterMs / 1000));
      send(res, 429, { error: '请求过于频繁', retryAfterMs: permit.retryAfterMs });
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    for (const r of routes) {
      const m = url.pathname.match(r.pattern);
      if (m && r.method === req.method) {
        await r.handler(req, res, m, url);
        log.info('request', { method: req.method, path: url.pathname, ms: Date.now() - startedAt });
        return;
      }
    }
    send(res, 404, { error: '路由不存在' });
  } catch (err) {
    const code = err instanceof HttpError ? err.code : 500;
    if (code >= 500) log.error('request failed', { err: err.message, stack: err.stack });
    else log.warn('request rejected', { err: err.message });
    if (!res.headersSent) send(res, code, { error: err.message });
  }
});

if (require.main === module) {
  server.listen(config.port, () => {
    log.info('server started', { port: config.port });
  });
}

module.exports = { server, store, cache, limiter };
