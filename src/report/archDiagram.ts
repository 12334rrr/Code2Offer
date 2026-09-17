/**
 * 分层架构图生成 v2(0.9.1):暗色成品级样式(参考生产级架构大图),
 * 仍为纯确定性推导——不发任何模型请求,token 成本 0,无幻觉。
 * 相比 v1:标题区(仓库名/徽章)、层容器虚线边框+提示语、节点卡片双行(标题+文件/要点)、
 * 语义化边色(同层调用/跨层归属/数据)、底部图例;节点携带 data-mod 供报告内点击联动面试题。
 * 产出:SVG(嵌入报告 + 独立文件)与 .drawio(diagrams.net 免费编辑)。
 */
import { RepoFacts } from '../core/profiler';
import { ModuleCard } from '../core/schemas';

export interface ArchDiagram {
  svg: string;
  drawio: string;
  summary: { layers: number; nodes: number; edges: number };
  /** 节点 → 模块映射(报告内点击节点时联动的面试题按此检索) */
  modules: Array<{ nodeId: string; name: string; files: string[] }>;
}

interface Node {
  id: string;
  layer: number;
  title: string;
  sub: string;
  file?: string;
}

interface Edge {
  from: string;
  to: string;
  kind: 'flow' | 'data';
}

interface Layout {
  nodes: Array<Node & { x: number; y: number; w: number; h: number }>;
  layerBoxes: Array<{ id: string; label: string; hint: string; x: number; y: number; w: number; h: number; ci: number }>;
  edges: Edge[];
  width: number;
  height: number;
  titleH: number;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const NODE_W = 252;
const NODE_H = 58;
const NODE_GAP = 14;
const PER_ROW = 3;
const CANVAS_W = 1180;
const MARGIN = 28;
const LAYER_TITLE_H = 44;

const basename = (f: string) => f.split('/').pop() ?? f;

/** 深色主题调色板(层):边框/强调/填充 */
const PALETTE = [
  { stroke: '#F5C518', fill: 'rgba(245,197,24,0.06)' }, // 入口:金
  { stroke: '#38BDF8', fill: 'rgba(56,189,248,0.07)' }, // 路由:青
  { stroke: '#A78BFA', fill: 'rgba(167,139,250,0.07)' }, // 模块:紫
  { stroke: '#34D399', fill: 'rgba(52,211,153,0.07)' }, // 数据:绿
];
const NODE_FILL = '#111A2C';
const NODE_STROKE = '#2A3A55';

function buildModel(facts: RepoFacts, cards: ModuleCard[]): { layers: Array<{ label: string; hint: string; nodes: Node[] }>; edges: Edge[] } {
  const fileToModule = new Map<string, string>();
  for (const c of cards) for (const f of c.files) if (!fileToModule.has(f)) fileToModule.set(f, c.name);

  const entryNodes: Node[] = (facts.overview.entryPoints ?? []).slice(0, 6).map((f, i) => ({
    id: `entry${i}`, layer: 0, title: clip(basename(f), 22), sub: clip(f, 34), file: f,
  }));

  const seenRoutes = new Set<string>();
  const routeNodes: Node[] = [];
  for (const r of facts.routes) {
    const key = `${r.method} ${r.route}`;
    if (seenRoutes.has(key) || routeNodes.length >= 8) continue;
    seenRoutes.add(key);
    routeNodes.push({ id: `route${routeNodes.length}`, layer: 1, title: clip(key, 22), sub: clip(basename(r.file), 30), file: r.file });
  }

  const moduleNodes: Node[] = cards.slice(0, 9).map((c, i) => ({
    id: `mod${i}`, layer: 2, title: clip(c.name, 20),
    sub: clip(`${c.files.length} 文件 · ${(c.职责 ?? '').slice(0, 18)}`, 34), file: c.files[0],
  }));

  const seenTables = new Set<string>();
  const dataNodes: Node[] = [];
  for (const t of facts.dbTables) {
    if (seenTables.has(t.table) || dataNodes.length >= 8) continue;
    seenTables.add(t.table);
    dataNodes.push({ id: `data${dataNodes.length}`, layer: 3, title: clip(t.table, 22), sub: clip(basename(t.file), 30), file: t.file });
  }
  for (const f of (facts.configFiles ?? []).slice(0, 3)) {
    if (dataNodes.length >= 11) break;
    dataNodes.push({ id: `cfg${dataNodes.length}`, layer: 3, title: `⚙ ${clip(basename(f), 18)}`, sub: '配置', file: f });
  }

  const layers = [
    { label: '入口层', hint: '用户/调用方从这里进入', nodes: entryNodes },
    { label: 'API / 路由层', hint: '对外接口与请求处理', nodes: routeNodes },
    { label: '业务模块层', hint: '核心实现,点击节点查看相关面试题', nodes: moduleNodes },
    { label: '数据与配置层', hint: '存储结构与运行配置', nodes: dataNodes },
  ].filter((l) => l.nodes.length);

  const edges: Edge[] = [];
  const seenEdge = new Set<string>();
  const push = (from: Node, to: Node, kind: Edge['kind']) => {
    if (from.id === to.id) return;
    const k = `${from.id}->${to.id}`;
    if (seenEdge.has(k)) return;
    seenEdge.add(k);
    edges.push({ from: from.id, to: to.id, kind });
  };
  const all = layers.flatMap((l) => l.nodes);
  const moduleByFile = new Map<string, Node>();
  for (const n of all) if (n.layer === 2 && n.file) moduleByFile.set(n.file, n);
  const moduleNodeOf = (file?: string) => {
    const m = file ? fileToModule.get(file) : undefined;
    if (!m) return undefined;
    return all.find((x) => x.layer === 2 && (x as { title?: string }).title === clip(m, 20));
  };
  for (const n of all) {
    const target = moduleNodeOf(n.file);
    if (target) push(n, target, n.layer === 3 ? 'data' : 'flow');
  }
  for (const e of entryNodes) {
    const r = routeNodes.find((x) => x.file === e.file);
    if (r) push(e, r, 'flow');
  }
  return { layers, edges };
}

function layout(layers: Array<{ label: string; hint: string; nodes: Node[] }>, edges: Edge[], titleH: number): Layout {
  const layerBoxes: Layout['layerBoxes'] = [];
  const nodes: Layout['nodes'] = [];
  let y = MARGIN + titleH + 16;
  for (const [li, layer] of layers.entries()) {
    const rows = Math.ceil(layer.nodes.length / PER_ROW);
    const h = LAYER_TITLE_H + rows * (NODE_H + NODE_GAP) + NODE_GAP;
    layerBoxes.push({ id: `layer${li}`, label: layer.label, hint: layer.hint, x: MARGIN, y, w: CANVAS_W - MARGIN * 2, h, ci: li });
    layer.nodes.forEach((n, i) => {
      const row = Math.floor(i / PER_ROW);
      const col = i % PER_ROW;
      const rowCount = Math.min(PER_ROW, layer.nodes.length - row * PER_ROW);
      const rowW = rowCount * NODE_W + (rowCount - 1) * NODE_GAP;
      const x = MARGIN + (CANVAS_W - MARGIN * 2 - rowW) / 2 + col * (NODE_W + NODE_GAP);
      nodes.push({ ...n, x, y: y + LAYER_TITLE_H + row * (NODE_H + NODE_GAP), w: NODE_W, h: NODE_H });
    });
    y += h + 26;
  }
  return { nodes, layerBoxes, edges, width: CANVAS_W, height: y + MARGIN + 64, titleH };
}

export function buildArchDiagram(facts: RepoFacts, cards: ModuleCard[], opts?: { repoName?: string; badge?: string }): ArchDiagram {
  const repoName = opts?.repoName || facts.root.split(/[\\/]/).filter(Boolean).pop() || '仓库';
  const badge = opts?.badge ?? '';
  const { layers, edges } = buildModel(facts, cards);
  const titleH = 86;
  const geo = layout(layers, edges, titleH);
  const nodeById = new Map(geo.nodes.map((n) => [n.id, n]));

  /* ---------- SVG(暗色成品级) ---------- */
  const parts: string[] = [];
  // 标题区
  parts.push(
    `<rect x="0" y="0" width="${geo.width}" height="${titleH}" fill="#0B1220"/>`,
    `<rect x="${MARGIN}" y="24" width="6" height="40" fill="#F5C518" rx="3"/>`,
    `<text x="${MARGIN + 20}" y="44" font-size="22" font-weight="bold" fill="#F8FAFC" font-family="system-ui,sans-serif">${esc(repoName)} · 系统总体架构</text>`,
    `<text x="${MARGIN + 20}" y="66" font-size="12" fill="#7C8DB0" font-family="system-ui,sans-serif">Code-grounded · 由仓库画像确定性推导 · 空层自动省略 · 可在 diagrams.net 编辑 架构图.drawio</text>`,
    `<rect x="${geo.width - MARGIN - (badge ? 150 : 0) - 118}" y="28" width="${badge ? 150 : 118}" height="30" rx="15" fill="rgba(245,197,24,0.12)" stroke="#F5C518"/>`,
    `<text x="${geo.width - MARGIN - (badge ? 75 : 59)}" y="48" text-anchor="middle" font-size="13" fill="#F5C518" font-family="system-ui,sans-serif">${esc(badge || 'Code2Offer')}</text>`
  );
  if (badge) {
    parts.push(
      `<rect x="${geo.width - MARGIN - 118}" y="28" width="118" height="30" rx="15" fill="rgba(56,189,248,0.12)" stroke="#38BDF8"/>`,
      `<text x="${geo.width - MARGIN - 59}" y="48" text-anchor="middle" font-size="13" fill="#38BDF8" font-family="system-ui,sans-serif">Code2Offer</text>`
    );
  }
  // 层容器(虚线)
  for (const b of geo.layerBoxes) {
    const p = PALETTE[b.ci % 4];
    parts.push(
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="14" fill="${p.fill}" stroke="${p.stroke}" stroke-width="1.4" stroke-dasharray="7 5" opacity="0.92"/>`,
      `<text x="${b.x + 18}" y="${b.y + 27}" font-size="15" font-weight="bold" fill="${p.stroke}" font-family="system-ui,sans-serif">${esc(b.label)}</text>`,
      `<text x="${b.x + b.w - 16}" y="${b.y + 27}" text-anchor="end" font-size="11" fill="#5B6B8C" font-family="system-ui,sans-serif">${esc(b.hint)}</text>`
    );
  }
  // 边(语义色:flow 金 / data 青)
  for (const e of geo.edges) {
    const a = nodeById.get(e.from);
    const b = nodeById.get(e.to);
    if (!a || !b) continue;
    const color = e.kind === 'data' ? '#38BDF8' : '#F5C518';
    const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y;
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.6" marker-end="url(#arrow)"/>`);
  }
  // 节点卡片(标题+副行,携带 data-mod 供报告点击联动)
  for (const n of geo.nodes) {
    const p = PALETTE[n.layer % 4];
    const dataMod = n.layer === 2 ? ` data-mod="${esc(n.title)}"` : '';
    parts.push(
      `<g class="arch-node"${dataMod} data-id="${n.id}" style="cursor:pointer">`,
      `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="10" fill="${NODE_FILL}" stroke="${NODE_STROKE}" stroke-width="1.2"/>`,
      `<rect x="${n.x}" y="${n.y}" width="4" height="${n.h}" fill="${p.stroke}" rx="2"/>`,
      `<text x="${n.x + 14}" y="${n.y + 23}" font-size="13.5" font-weight="bold" fill="#F1F5F9" font-family="system-ui,sans-serif">${esc(n.title)}</text>`,
      `<text x="${n.x + 14}" y="${n.y + 43}" font-size="11" fill="#7C8DB0" font-family="system-ui,sans-serif">${esc(n.sub)}</text>`,
      `</g>`
    );
  }
  // 图例
  const legendY = geo.height - MARGIN - 18;
  parts.push(
    `<line x1="${MARGIN}" y1="${legendY}" x2="${MARGIN + 34}" y2="${legendY}" stroke="#F5C518" stroke-width="2" marker-end="url(#arrow)"/>`,
    `<text x="${MARGIN + 42}" y="${legendY + 4}" font-size="11.5" fill="#7C8DB0" font-family="system-ui,sans-serif">调用 / 归属</text>`,
    `<line x1="${MARGIN + 150}" y1="${legendY}" x2="${MARGIN + 184}" y2="${legendY}" stroke="#38BDF8" stroke-width="2" marker-end="url(#arrow)"/>`,
    `<text x="${MARGIN + 192}" y="${legendY + 4}" font-size="11.5" fill="#7C8DB0" font-family="system-ui,sans-serif">数据 / 配置</text>`,
    `<text x="${geo.width - MARGIN}" y="${legendY + 4}" text-anchor="end" font-size="11" fill="#5B6B8C" font-family="system-ui,sans-serif">${esc(layers.map((l) => `${l.label} ${l.nodes.length}`).join(' · '))}</text>`
  );

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${geo.width}" height="${geo.height}" viewBox="0 0 ${geo.width} ${geo.height}" role="img" aria-label="分层架构图">` +
    `<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#94A3B8"/></marker></defs>` +
    `<rect width="${geo.width}" height="${geo.height}" fill="#0B1220" rx="12"/>` +
    parts.join('') +
    `</svg>`;

  /* ---------- draw.io XML(样式同步暗色) ---------- */
  const cells: string[] = [];
  for (const b of geo.layerBoxes) {
    const p = PALETTE[b.ci % 4];
    cells.push(
      `<mxCell id="${b.id}" value="${esc(b.label)}" style="rounded=1;fillColor=#111A2C;strokeColor=${p.stroke};dashed=1;verticalAlign=top;fontStyle=1;fontColor=${p.stroke};" vertex="1" parent="1"><mxGeometry x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" as="geometry"/></mxCell>`
    );
  }
  for (const n of geo.nodes) {
    const p = PALETTE[n.layer % 4];
    cells.push(
      `<mxCell id="${n.id}" value="${esc(n.title)}&#10;${esc(n.sub)}" style="rounded=1;whiteSpace=wrap;fillColor=${NODE_FILL};strokeColor=${p.stroke};fontColor=#F1F5F9;" vertex="1" parent="1"><mxGeometry x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" as="geometry"/></mxCell>`
    );
  }
  for (const [i, e] of geo.edges.entries()) {
    cells.push(
      `<mxCell id="edge${i}" style="endArrow=block;strokeColor=${e.kind === 'data' ? '#38BDF8' : '#F5C518'};" edge="1" parent="1" source="${e.from}" target="${e.to}"><mxGeometry relative="1" as="geometry"/></mxCell>`
    );
  }
  const drawio =
    `<mxfile host="Code2Offer" modified="${new Date().toISOString()}" agent="Code2Offer" version="21.0.0">` +
    `<diagram id="code2offer-arch" name="分层架构图">` +
    `<mxGraphModel dx="1200" dy="800" grid="0" page="1" pageWidth="${geo.width}" pageHeight="${geo.height}" background="#0B1220">` +
    `<root><mxCell id="0"/><mxCell id="1" parent="0"/>` +
    cells.join('') +
    `</root></mxGraphModel></diagram></mxfile>`;

  return {
    svg,
    drawio,
    summary: { layers: geo.layerBoxes.length, nodes: geo.nodes.length, edges: geo.edges.length },
    modules: cards.slice(0, 9).map((c, i) => ({ nodeId: `mod${i}`, name: c.name, files: c.files })),
  };
}
