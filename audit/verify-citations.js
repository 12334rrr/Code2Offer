// 审计脚本:验证已发布示例产物中的 文件:行号 引用是否可解析且不越界
const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, '..', 'example-demo', 'interview-output');
const repo = path.join(__dirname, '..', 'example-demo');
const qs = JSON.parse(fs.readFileSync(path.join(outDir, 'questions.json'), 'utf-8'));
console.log('题目总数:', qs.length);
console.log('字段:', Object.keys(qs[0]).join(', '));

// 从所有字符串字段中递归提取 文件:行号 引用
const refRe = /([a-zA-Z0-9_.\/-]+\.(?:ts|js|py|go|java|sql|json|md)):(\d+)(?:-(\d+))?/g;
const stats = { total: 0, resolved: 0, outOfRange: [], missingFile: new Set() };

function walk(node) {
  if (typeof node === 'string') {
    let m;
    const s = node.replace(/`/g, '');
    while ((m = refRe.exec(s))) {
      stats.total++;
      const file = m[1].replace(/^\.\//, '');
      const line = parseInt(m[2], 10);
      const fp = path.join(repo, file);
      if (!fs.existsSync(fp)) { stats.missingFile.add(m[1]); continue; }
      const lines = fs.readFileSync(fp, 'utf-8').split('\n').length;
      if (line >= 1 && line <= lines) stats.resolved++;
      else stats.outOfRange.push(`${m[1]}:${m[2]} (文件共 ${lines} 行)`);
    }
  } else if (Array.isArray(node)) node.forEach(walk);
  else if (node && typeof node === 'object') Object.values(node).forEach(walk);
}
qs.forEach(walk);

console.log('引用总数:', stats.total);
console.log('可解析且在界内:', stats.resolved);
console.log('越界:', stats.outOfRange.length, stats.outOfRange.slice(0, 5));
console.log('文件不存在:', [...stats.missingFile]);

// 题目 id 唯一性
const ids = qs.map((q) => q.id);
console.log('id 唯一:', new Set(ids).size === ids.length, `(${ids.length} 个)`);

// 对比块抽查
const withCmp = qs.filter((q) => q.对比);
console.log('带对比块题数:', withCmp.length);
