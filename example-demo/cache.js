// LRU + TTL 缓存:Get/Set 都写,容量淘汰最久未用,过期惰性删除
'use strict';

class LRUCache {
  constructor(maxSize, ttlMs) {
    if (maxSize <= 0) throw new Error('maxSize 必须 > 0');
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    // 利用 Map 的插入序实现 LRU:命中后 delete+set 移到"最新"端
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.map.get(key);
    if (entry === undefined) {
      this.misses++;
      return undefined;
    }
    if (Date.now() - entry.storedAt > this.ttlMs) {
      this.map.delete(key); // 惰性过期
      this.misses++;
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, storedAt: Date.now() });
    while (this.map.size > this.maxSize) {
      // 淘汰最久未使用(Map 首元素)
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  invalidate(key) {
    this.map.delete(key);
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      size: this.map.size,
      hitRate: total === 0 ? 0 : this.hits / total,
    };
  }
}

module.exports = { LRUCache };
