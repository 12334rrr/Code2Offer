/**
 * 分层架构图生成(0.9.0,零成本方案):
 * 全部由仓库画像/模块卡确定性推导——不发任何模型请求,token 成本为 0。
 * 产出两种格式,服务两个场景:
 *  1. SVG:浏览器直接打开/嵌入报告的分层架构图;
 *  2. draw.io XML(.drawio):可在 diagrams.net(免费)里打开继续编辑、导出 PPT 用图。
 * 布局:入口层 → API/路由层 → 业务模块层 → 数据与配置层;边按「文件归属模块」推导。
 */
import { RepoFacts } from '../core/profiler';
import { ModuleCard } from '../core/schemas';

export interface ArchDiagram {
  svg: string;
  drawio: string;
  summary: { layers: number; nodes: number; edges: number };
}

interface Node {
  id: string;
  layer: number;
  label: string;
  file?: string;
}

interface Edge {
  from: string;
  to: string;
}

interface Layout {
  nodes: Array<Node & { x: number; y: number; w: number; h: number }>;
  layerBoxes: Array<{ id: string; label: string; x: number; y: number; w: number; h: number }>;
  edges: Edge[];
  width: number;
  height: number;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const NODE_W = 250;
const NODE_H = 46;
const NODE_GAP = 14;
const PER_ROW = 3;
const CANVAS_W = 940;
const MARGIN = 20;
const TITLE_H = 30;

const basename = (f: string) => f.split('/').pop() ?? f;

function buildModel(facts: RepoFacts, cards: ModuleCard[]): { layers: Array<{ label: string; nodes: Node[] }>; edges: Edge[] } {
  const fileToModule = new Map<string, string>();
  for (const c of cards) for (const f of c.files) if (!fileToModule.has(f)) fileToModule.set(f, c.name);
  const moduleOf = (file?: string) => (file ? fileToModule.get(file) ?? undefined : undefined);

  /* 各层节点 */
  const entryNodes: Node[] = (facts.overview.entryPoints ?? []).slice(0, 6).map((f, i) => ({
    id: `entry${i}`, layer: 0, label: clip(basename(f), 26), file: f,
  }));

  const seenRoutes = new Set<string>();
  const routeNodes: Node[] = [];
  for (const r of facts.routes) {
    const key = `${r.method} ${r.route}`;
    if (seenRoutes.has(key) || routeNodes.length >= 8) continue;
    seenRoutes.add(key);
    routeNodes.push({ id: `route${routeNodes.length}`, layer: 1, label: clip(key, 26), file: r.file });
  }

  const moduleNodes: Node[] = cards.slice(0, 10).map((c, i) => ({
    id: `mod${i}`, layer: 2, label: clip(c.name, 24), file: c.files[0],
  }));

  const seenTables = new Set<string>();
  const dataNodes: Node[] = [];
  for (const t of facts.dbTables) {
    if (seenTables.has(t.table) || dataNodes.length >= 8) continue;
    seenTables.add(t.table);
    dataNodes.push({ id: `data${dataNodes.length}`, layer: 3, label: clip(t.table, 26), file: t.file });
  }
  for (const f of (facts.configFiles ?? []).slice(0, 3)) {
    if (dataNodes.length >= 11) break;
    dataNodes.push({ id: `cfg${dataNodes.length}`, layer: 3, label: `⚙ ${clip(basename(f), 22)}`, file: f });
  }

  const layers = [
    { label: '入口层', nodes: entryNodes },
    { label: 'API / 路由层', nodes: routeNodes },
    { label: '业务模块层', nodes: moduleNodes },
    { label: '数据与配置层', nodes: dataNodes },
  ].filter((l) => l.nodes.length);

  /* 边:同文件的跨层连接(入口→模块、路由→模块、模块→表/配置),去重 */
  const edges: Edge[] = [];
  const seenEdge = new Set<string>();
  const push = (from: Node, to: Node) => {
    if (from.id === to.id) return;
    const k = `${from.id}->${to.id}`;
    if (seenEdge.has(k)) return;
    seenEdge.add(k);
    edges.push({ from: from.id, to: to.id });
  };
  const all = layers.flatMap((l) => l.nodes);
  for (const n of all) {
    const m = moduleOf(n.file);
    if (!m) continue;
    const target = all.find((x) => x.layer === 2 && x.label === clip(m, 24));
    if (target) push(n, target);
  }
  // 入口 → 路由(同文件)
  for (const e of entryNodes) {
    const r = routeNodes.find((x) => x.file === e.file);
    if (r) push(e, r);
  }
  // 主题层相邻:入口→路由、路由→模块、模块→数据 的边优先保留(上面已覆盖);跨层兜底略过,保持图可读
  return { layers, edges };
}

function layout(layers: Array<{ label: string; nodes: Node[] }>, edges: Edge[]): Layout {
  const layerBoxes: Layout['layerBoxes'] = [];
  const nodes: Layout['nodes'] = [];
  let y = MARGIN;
  for (const [li, layer] of layers.entries()) {
    const rows = Math.ceil(layer.nodes.length / PER_ROW);
    const h = TITLE_H + rows * (NODE_H + NODE_GAP) + NODE_GAP;
    const box = { id: `layer${li}`, label: layer.label, x: MARGIN, y, w: CANVAS_W - MARGIN * 2, h };
    layerBoxes.push(box);
    layer.nodes.forEach((n, i) => {
      const row = Math.floor(i / PER_ROW);
      const col = i % PER_ROW;
      const rowCount = Math.min(PER_ROW, layer.nodes.length - row * PER_ROW);
      // 该行节点居中排布
      const rowW = rowCount * NODE_W + (rowCount - 1) * NODE_GAP;
      const x = MARGIN + (CANVAS_W - MARGIN * 2 - rowW) / 2 + col * (NODE_W + NODE_GAP);
      nodes.push({ ...n, x, y: y + TITLE_H + row * (NODE_H + NODE_GAP), w: NODE_W, h: NODE_H });
    });
    y += h + 24;
  }
  return { nodes, layerBoxes, edges, width: CANVAS_W, height: y + MARGIN };
}

const LAYER_COLORS = ['#DBEAFE', '#D1FAE5', '#FEF3C7', '#FCE7F3'];
const LAYER_STROKES = ['#2563EB', '#059669', '#D97706', '#DB2777'];

export function buildArchDiagram(facts: RepoFacts, cards: ModuleCard[]): ArchDiagram {
  const { layers, edges } = buildModel(facts, cards);
  const geo = layout(layers, edges);
  const nodeById = new Map(geo.nodes.map((n) => [n.id, n]));

  /* ---------- SVG ---------- */
  const svgParts: string[] = [];
  for (const b of geo.layerBoxes) {
    const ci = Number(b.id.replace('layer', ''));
    svgParts.push(
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="10" fill="${LAYER_COLORS[ci % 4]}" stroke="${LAYER_STROKES[ci % 4]}" stroke-width="1.5" opacity="0.55"/>`,
      `<text x="${b.x + 14}" y="${b.y + 21}" font-size="15" font-weight="bold" fill="#334155" font-family="system-ui,sans-serif">${esc(b.label)}</text>`
    );
  }
  for (const e of geo.edges) {
    const a = nodeById.get(e.from);
    const b = nodeById.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y;
    svgParts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#94A3B8" stroke-width="1.4" marker-end="url(#arrow)"/>`);
  }
  for (const n of geo.nodes) {
    svgParts.push(
      `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="8" fill="#FFFFFF" stroke="#CBD5E1" stroke-width="1.2"/>`,
      `<text x="${n.x + n.w / 2}" y="${n.y + n.h / 2 + 5}" text-anchor="middle" font-size="13" fill="#0F172A" font-family="system-ui,sans-serif">${esc(n.label)}</text>`
    );
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${geo.width}" height="${geo.height}" viewBox="0 0 ${geo.width} ${geo.height}" role="img" aria-label="分层架构图">` +
    `<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#94A3B8"/></marker></defs>` +
    `<rect width="${geo.width}" height="${geo.height}" fill="#F8FAFC"/>` +
    svgParts.join('') +
    `</svg>`;

  /* ---------- draw.io XML ---------- */
  const cells: string[] = [];
  for (const b of geo.layerBoxes) {
    const ci = Number(b.id.replace('layer', ''));
    cells.push(
      `<mxCell id="${b.id}" value="${esc(b.label)}" style="rounded=1;fillColor=${LAYER_COLORS[ci % 4]};strokeColor=${LAYER_STROKES[ci % 4]};verticalAlign=top;fontStyle=1;fontColor=#334155;" vertex="1" parent="1"><mxGeometry x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" as="geometry"/></mxCell>`
    );
  }
  for (const n of geo.nodes) {
    cells.push(
      `<mxCell id="${n.id}" value="${esc(n.label)}" style="rounded=1;whiteSpace=wrap;fillColor=#FFFFFF;strokeColor=#94A3B8;" vertex="1" parent="1"><mxGeometry x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" as="geometry"/></mxCell>`
    );
  }
  for (const [i, e] of geo.edges.entries()) {
    cells.push(
      `<mxCell id="edge${i}" style="endArrow=block;strokeColor=#94A3B8;" edge="1" parent="1" source="${e.from}" target="${e.to}"><mxGeometry relative="1" as="geometry"/></mxCell>`
    );
  }
  const drawio =
    `<mxfile host="Code2Offer" modified="${new Date().toISOString()}" agent="Code2Offer" version="21.0.0">` +
    `<diagram id="code2offer-arch" name="分层架构图">` +
    `<mxGraphModel dx="1000" dy="700" grid="1" gridSize="10" page="1" pageWidth="${geo.width}" pageHeight="${geo.height}">` +
    `<root><mxCell id="0"/><mxCell id="1" parent="0"/>` +
    cells.join('') +
    `</root></mxGraphModel></diagram></mxfile>`;

  return {
    svg,
    drawio,
    summary: { layers: geo.layerBoxes.length, nodes: geo.nodes.length, edges: geo.edges.length },
  };
}
