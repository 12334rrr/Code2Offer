import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { tavily } from '@tavily/core';

export interface WebSource {
  title: string;
  url: string;
  excerpt: string;
  score?: number;
  retrievedAt: string;
}

export interface WebResearchOptions {
  apiKey?: string;
  cacheDir: string;
  maxResults?: number;
  maxCalls?: number;
}

/**
 * Tavily is deliberately an external-reference supplement, never a repository
 * fact source. Queries are restricted to short public technical terms and the
 * caller receives no ability to extract/crawl arbitrary URLs.
 */
export class TavilyResearch {
  private calls = 0;
  constructor(private readonly options: WebResearchOptions) {}

  enabled(): boolean { return Boolean(this.options.apiKey?.trim()); }

  async searchPublicTechnicalFact(query: string): Promise<WebSource[]> {
    if (!this.enabled()) return [];
    const safeQuery = validatePublicQuery(query);
    const maxCalls = this.options.maxCalls ?? 5;
    if (this.calls >= maxCalls) throw new Error(`Tavily 搜索预算已耗尽(${maxCalls} 次)`);
    const key = crypto.createHash('sha256').update(safeQuery).digest('hex');
    const cacheFile = path.join(this.options.cacheDir, `tavily-${key}.json`);
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { at: number; sources: WebSource[] };
      if (Date.now() - cached.at < 24 * 60 * 60 * 1000) return cached.sources;
    } catch { /* cache miss or corrupt cache */ }

    this.calls++;
    const client = tavily({ apiKey: this.options.apiKey!.trim() });
    const response = await client.search(safeQuery, {
      maxResults: Math.min(5, Math.max(1, this.options.maxResults ?? 3)),
      searchDepth: 'basic',
      includeAnswer: false,
      includeRawContent: false,
    });
    const retrievedAt = new Date().toISOString();
    const sources = (response.results ?? [])
      .filter((r) => isPublicHttpUrl(r.url))
      .map((r) => ({ title: String(r.title ?? '').slice(0, 240), url: r.url, excerpt: String(r.content ?? '').slice(0, 1500), score: r.score, retrievedAt }));
    fs.mkdirSync(this.options.cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), sources }, null, 2), 'utf8');
    return sources;
  }
}

export function validatePublicQuery(query: string): string {
  const value = query.trim().replace(/\s+/g, ' ');
  if (!value || value.length > 300) throw new Error('Tavily 查询必须是 1-300 字符的公开技术问题');
  if (/[\r\n]/.test(query) || /(?:[A-Za-z]:\\|\/home\/|\/Users\/|\.env\b|-----BEGIN|sk-[\w-]{8,})/i.test(value)) {
    throw new Error('Tavily 查询不能包含代码、路径或密钥');
  }
  return value;
}

function isPublicHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase();
    return host !== 'localhost' && host !== '::1' && !/^127\./.test(host) && !/^10\./.test(host) && !/^192\.168\./.test(host) && !/^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  } catch { return false; }
}
