import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * 基于内容哈希的磁盘缓存:同一份代码 + 同一版提示词只算一次,
 * 重跑(改 JD / 校验失败重试 / 增量补题)只花增量钱。
 */
export class DiskCache {
  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  /** 分隔符用 NUL:普通文本里不会出现,消除 parts.join('\u0000') 的跨参拼接歧义 */
  key(...parts: Array<string | number>): string {
    return crypto
      .createHash('sha1')
      .update(parts.join('\u0000'))
      .digest('hex');
  }

  has(k: string): boolean {
    return fs.existsSync(this.pathOf(k));
  }

  get<T>(k: string): T | undefined {
    const p = this.pathOf(k);
    if (!fs.existsSync(p)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
    } catch {
      return undefined;
    }
  }

  set(k: string, v: unknown): void {
    // 原子写:进程中途被杀不会留下截断的半份缓存
    const p = this.pathOf(k);
    const tmp = `${p}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
      fs.renameSync(tmp, p);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 清理失败无所谓 */
      }
      throw new Error(`缓存写入失败:${p}`);
    }
  }

  private pathOf(k: string): string {
    return path.join(this.dir, `${k}.json`);
  }
}

/** 版本号:提示词或算法改动后 +1,使旧缓存自然失效 */
export const PROMPT_VERSION = '2';
