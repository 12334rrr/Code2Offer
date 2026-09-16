/* VSIX 内容与密钥检查:Node ZIP 解析,不依赖 Windows unzip。 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');
const VSIX = path.resolve(__dirname, '../vscode/code-interview-prep-0.5.1.vsix');

function entries(zipPath) {
  const b = fs.readFileSync(zipPath); let e = -1;
  for (let i = b.length - 22; i >= 0; i--) if (b.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  assert.ok(e >= 0, 'VSIX ZIP 尾部缺失');
  const n = b.readUInt16LE(e + 10), cd = b.readUInt32LE(e + 16); let p = cd; const out = [];
  for (let i = 0; i < n; i++) {
    assert.equal(b.readUInt32LE(p), 0x02014b50, 'ZIP 中央目录损坏');
    const method = b.readUInt16LE(p + 10), size = b.readUInt32LE(p + 20), nl = b.readUInt16LE(p + 28), xl = b.readUInt16LE(p + 30), cl = b.readUInt16LE(p + 32), off = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nl).toString('utf8');
    const lnl = b.readUInt16LE(off + 26), lxl = b.readUInt16LE(off + 28);
    const data = b.subarray(off + 30 + lnl + lxl, off + 30 + lnl + lxl + size);
    out.push({ name, data: method === 0 ? data : zlib.inflateRawSync(data) }); p += 46 + nl + xl + cl;
  }
  return out;
}

const list = entries(VSIX);
const names = list.map((x) => x.name);
for (const name of names) assert.ok(!/(^|\/)(?:\.env[^/]*|node_modules|interview-output|audit|JD)(?:\/|$)/i.test(name), `VSIX 含不应打包路径:${name}`);
assert.ok(!names.some((n) => /\.map$|\.vsix$/i.test(n)), 'VSIX 不应嵌套 sourcemap/旧包');
const allText = list.map((x) => x.data.toString('utf8')).join('\n');
assert.ok(!/\b(?:sk|ghp|xox[bp])-[A-Za-z0-9._-]{20,}\b/.test(allText), 'VSIX 疑似含真实 token');
assert.ok(names.includes('extension/dist/extension.js') && names.includes('extension/media/activitybar.svg'));
console.log(JSON.stringify({ passed: true, fileCount: names.length, files: names, bytes: fs.statSync(VSIX).size, sha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(VSIX)).digest('hex') }, null, 2));
