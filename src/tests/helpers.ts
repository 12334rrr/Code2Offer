/** 测试公共工具:临时目录夹具 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function makeTempDir(prefix = 'cip-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function write(dir: string, rel: string, content: string): string {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

export function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
