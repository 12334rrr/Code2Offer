import { test } from 'node:test';
import * as assert from 'node:assert';
import { buildArchDiagram } from '../report/archDiagram';
import { RepoFacts } from '../core/profiler';
import { ModuleCard } from '../core/schemas';

const facts = (over: Partial<RepoFacts> = {}): RepoFacts =>
  ({
    root: '/repo',
    generatedAt: new Date().toISOString(),
    files: ['src/server.js', 'src/store.js', 'src/cache.js', 'src/schema.sql', 'package.json'],
    overview: { totalFiles: 5, totalLOC: 100, languages: {}, manifests: [], entryPoints: ['src/server.js'] },
    routes: [
      { file: 'src/server.js', method: 'GET', route: '/tasks' },
      { file: 'src/server.js', method: 'POST', route: '/tasks' },
    ],
    dbTables: [{ file: 'src/schema.sql', table: 'tasks' }],
    configFiles: ['package.json'],
    hotspots: [],
    interestingFiles: [],
    testEvidence: { files: [], testCount: 0, assertCount: 0 },
    tree: '',
    readingPlan: [],
    notes: [],
    skippedSensitive: [],
    skippedByReason: {},
    ...over,
  }) as RepoFacts;

const cards: ModuleCard[] = [
  {
    name: 'server 模块', files: ['src/server.js'], 职责: '入口', 关键实现: [], 设计决策: [], 亮点: [], 缺点: [], 面试深挖点: [],
  },
  {
    name: 'store 模块', files: ['src/store.js', 'src/schema.sql'], 职责: '存储', 关键实现: [], 设计决策: [], 亮点: [], 缺点: [], 面试深挖点: [],
  },
];

test('buildArchDiagram:四层结构与归属边', () => {
  const d = buildArchDiagram(facts(), cards);
  assert.strictEqual(d.summary.layers, 4, '入口/路由/模块/数据 四层齐全');
  assert.ok(d.summary.nodes >= 5, `节点数 ${d.summary.nodes} 至少覆盖入口+路由+模块+表`);
  // 边:入口→server 模块、路由→server 模块、server→store?(不同文件不连)、store 模块→tasks 表
  assert.ok(d.summary.edges >= 3, `归属边 ${d.summary.edges} 至少 3 条`);
  // SVG:层标签与转义
  assert.ok(d.svg.includes('入口层') && d.svg.includes('业务模块层') && d.svg.includes('数据与配置层'));
  assert.ok(d.svg.startsWith('<svg xmlns'), 'SVG 根元素合法');
  assert.ok(!d.svg.includes('<script'), 'SVG 不含脚本(CSP 安全)');
  // drawio:mxfile 结构 + 节点/边 cell 数
  assert.ok(d.drawio.startsWith('<mxfile host="Code2Offer"'));
  assert.ok(d.drawio.includes('<mxGraphModel'));
  assert.strictEqual((d.drawio.match(/vertex="1"/g) || []).length, d.summary.layers + d.summary.nodes);
  assert.strictEqual((d.drawio.match(/edge="1"/g) || []).length, d.summary.edges);
});

test('buildArchDiagram:HTML 特殊字符被转义;空仓库不崩溃', () => {
  const tricky = facts({
    overview: { totalFiles: 1, totalLOC: 1, languages: {}, manifests: [], entryPoints: ['<script>alert(1)</script>.js'] },
    routes: [],
    dbTables: [],
    configFiles: [],
  });
  const d = buildArchDiagram(tricky, cards);
  assert.ok(!d.svg.includes('<script>alert'), '标签被转义,不产生可执行节点');
  assert.ok(d.svg.includes('&gt;'), '特殊字符已被实体转义(/> → &gt;)');
  assert.ok(d.drawio.includes('&gt;'), 'drawio 同样转义');
  // 空卡片 + 空路由也能出图(只有入口层)
  const empty = buildArchDiagram(facts({ routes: [], dbTables: [], configFiles: [] }), []);
  assert.strictEqual(empty.summary.layers, 1);
  assert.ok(empty.summary.nodes >= 1);
});
