// 令牌桶限流(按 IP):容量 capacity,每秒补充 refillPerSec 个
'use strict';

class TokenBucketLimiter {
  constructor(capacity, refillPerSec) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.buckets = new Map(); // ip -> {tokens, last}
  }

  _bucket(ip, now) {
    let b = this.buckets.get(ip);
    if (!b) {
      b = { tokens: this.capacity, last: now };
      this.buckets.set(ip, b);
    }
    return b;
  }

  /** 返回 {allowed, remaining, retryAfterMs} */
  take(ip, now = Date.now()) {
    const b = this._bucket(ip, now);
    const elapsedSec = (now - b.last) / 1000;
    b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec);
    b.last = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, remaining: Math.floor(b.tokens), retryAfterMs: 0 };
    }
    const need = 1 - b.tokens;
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.ceil((need / this.refillPerSec) * 1000),
    };
  }

  // 防内存膨胀:清理长期不活跃的桶
  sweep(now = Date.now(), idleMs = 10 * 60 * 1000) {
    for (const [ip, b] of this.buckets) {
      if (now - b.last > idleMs) this.buckets.delete(ip);
    }
    return this.buckets.size;
  }
}

module.exports = { TokenBucketLimiter };
