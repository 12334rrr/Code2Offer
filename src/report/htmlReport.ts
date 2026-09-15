import { ProjectKnowledge, Question } from '../core/schemas';

export interface HtmlData {
  knowledge: ProjectKnowledge;
  questions: Question[];
  jd?: {
    开场白STAR: string;
    必考ID: string[];
    复述侧重?: { 多讲: string[]; 少讲: string[] };
    关键词?: string[];
  };
  stats: { pass: number; fix: number; flag: number };
  model: string;
  generatedAt: string;
  /** localStorage 命名空间键(默认按生成时间隔离):不同仓库的进度互不串扰 */
  repoKey?: string;
}

/** HTML 文本转义:覆盖 & < > " '(单引号用于属性内 JS 字符串场景的纵深防御) */
function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function verifyBadge(q: Question): string {
  if (q.verified === 'flag') return '<span class="badge flag">⚠ 存疑</span>';
  if (q.verified === 'fix') return '<span class="badge fix">✎ 已修订</span>';
  if (q.verified === 'pass') return '<span class="badge pass">✓ 已校验</span>';
  if (q.verified === 'unverified') return '<span class="badge unv">? 未覆盖</span>';
  return '';
}

function comparisonTableHtml(q: Question): string {
  const cmp = q.对比!;
  const dims = Array.isArray(cmp.维度) ? cmp.维度 : [];
  const rows = Array.isArray(cmp.对比表) ? cmp.对比表 : [];
  const width = Math.max(dims.length + 1, ...(rows.length ? rows.map((r) => r.length) : [1]));
  let html = '<table class="cmp"><thead><tr><th>方案</th>';
  for (let i = 0; i < width - 1; i++) html += `<th>${esc(cmp.维度[i] ?? `维度${i + 1}`)}</th>`;
  html += '</tr></thead><tbody>';
  for (const row of rows) {
    html += '<tr>';
    for (let i = 0; i < width; i++) html += `<td>${esc(row[i] ?? '')}</td>`;
    html += '</tr>';
  }
  html += `</tbody></table><p class="cmp-conclusion"><b>结论:</b>${esc(cmp.结论)}</p>`;
  return html;
}

/** 卡片可检索文本:题目/要点/考察点 + 追问链/加分/易错/对比(此前后四类永远搜不到) */
function searchText(q: Question): string {
  const cmpText = q.对比
    ? [q.对比.候选方案 ?? [], q.对比.维度 ?? [], q.对比.结论 ?? ''].flat().join(' ')
    : '';
  return [
    q.question,
    q.答案要点.join(' '),
    q.考察点,
    (q.追问链 ?? []).join(' '),
    q.加分回答,
    q.常见错误回答,
    cmpText,
  ]
    .join(' ')
    .toLowerCase();
}

function questionCard(q: Question): string {
  const cites = q.代码依据.map((c) => `<code>${esc(c.file)}:${esc(c.lines)}</code>`).join(' ');
  const ol = q.答案要点.map((a) => `<li>${esc(a)}</li>`).join('');
  const follows = q.追问链.map((f, i) => `<div class="follow">追问${i + 1}:${esc(f)}</div>`).join('');
  return `
<article class="card" id="${esc(q.id)}" data-cat="${esc(q.category)}" data-diff="${esc(q.difficulty)}" data-must="${q.必考 ? 1 : 0}" data-text="${esc(searchText(q))}">
  <div class="card-head">
    <span class="qid">${esc(q.id)}</span>
    <span class="chip cat">${esc(q.category)}</span>
    <span class="chip d-${esc(q.difficulty)}">${esc(q.difficulty)}</span>
    ${q.必考 ? '<span class="chip must">⭐必考</span>' : ''}
    ${verifyBadge(q)}
    <span class="target">${esc(q.target && q.target !== '项目整体' ? q.target : '')}</span>
  </div>
  <h3 class="q">${esc(q.question)}</h3>
  <div class="answer hidden">
    <p class="point"><b>考察点:</b>${esc(q.考察点)}</p>
    <b>答案要点</b>
    <ol>${ol}</ol>
    <p><b>代码依据:</b>${cites}</p>
    ${q.verified === 'flag' ? `<p class="warn">⚠ 存疑:${esc(q.verifyNote ?? '')}(请人工复核后再背诵)</p>` : ''}
    ${q.verified === 'unverified' ? `<p class="warn">? 此题尚未完成对抗校验(模型故障/漏答),重跑 generate 会自动补验。</p>` : ''}
    ${follows}
    <p><b>加分回答:</b>${esc(q.加分回答)}</p>
    <p class="wrong"><b>常见错误回答:</b>${esc(q.常见错误回答)}</p>
    ${q.对比 ? `<b>横向对比</b>${comparisonTableHtml(q)}` : ''}
  </div>
  <div class="card-foot">
    <button type="button" class="js-toggle" data-id="${esc(q.id)}">显示/隐藏答案</button>
    <span class="selftest">
      <button type="button" class="ok js-mark" data-id="${esc(q.id)}" data-ok="1">掌握 ✓</button>
      <button type="button" class="no js-mark" data-id="${esc(q.id)}" data-ok="0">没掌握 ✗</button>
    </span>
    <span class="mark-status" data-st="${esc(q.id)}"></span>
  </div>
</article>`;
}

/**
 * 单文件 HTML 报告:筛选/搜索/隐藏答案自测/掌握度统计(localStorage,webview 中自动降级为内存)。
 *
 * 交互安全模型(审计 Q-H1/E-07):
 * - 全文无任何内联事件处理器(onclick/oninput/onchange),统一 data-* 属性 + 事件委托,
 *   HTML 属性 × 内联 JS 双上下文不再需要"转义祈祷";VSCode Webview 的 nonce CSP 可直接生效
 * - localStorage 键含仓库命名空间,跨仓库进度不串扰
 * - 搜索 150ms 防抖;侧栏只在 mark 后增量更新,不再每击键重建
 */
export function renderHtml(data: HtmlData): string {
  const cats = [...new Set(data.questions.map((q) => q.category))];
  const mustCount = data.questions.filter((q) => q.必考).length;
  const dataJson = JSON.stringify({ total: data.questions.length }).replace(/</g, '\\u003c');
  const storeKey = `cip-progress-${data.repoKey ?? 'default'}`;

  const jdHtml = data.jd
    ? `<section class="jd">
  <h2>岗位定制(JD 加权)</h2>
  <div>${(data.jd.关键词 ?? []).map((k) => `<span class="chip kw">${esc(k)}</span>`).join('')}</div>
  <h3>1 分钟开场白(STAR)</h3>
  <p class="star">${esc(data.jd.开场白STAR)}</p>
  ${
    data.jd.复述侧重
      ? `<p><b>多讲:</b>${esc((data.jd.复述侧重.多讲 ?? []).join('、'))}</p><p><b>少讲:</b>${esc((data.jd.复述侧重.少讲 ?? []).join('、'))}</p>`
      : ''
  }
  <p><b>必考题:</b>${data.jd.必考ID.map((id) => `<a href="#${esc(id)}">${esc(id)}</a>`).join('、')}</p>
</section>`
    : '';

  const cards = data.questions.map(questionCard).join('\n');
  const catOptions = cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  const oneLiner = (data.knowledge.一句话定位 ?? '').slice(0, 60); // 先截断再转义,防实体被拦腰截断

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>代码转面试 · 面试材料报告</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1c2330;--muted:#6b7480;--line:#e3e7ec;--blue:#2563eb;--green:#16a34a;--red:#dc2626;--amber:#d97706}
*{box-sizing:border-box}
body{margin:0;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;background:var(--bg);color:var(--ink)}
header{background:#111827;color:#fff;padding:18px 24px}
header h1{margin:0 0 6px;font-size:20px}
.meta{color:#9ca3af;font-size:12px}
.meta b{color:#e5e7eb}
.stats{margin-top:8px;display:flex;gap:8px;flex-wrap:wrap}
.stat{background:#1f2937;border-radius:6px;padding:3px 10px;font-size:12px}
.toolbar{position:sticky;top:0;z-index:9;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 24px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.toolbar input[type=text]{flex:1;min-width:200px;padding:7px 10px;border:1px solid var(--line);border-radius:6px;font-size:14px}
.toolbar select{padding:7px;border:1px solid var(--line);border-radius:6px}
.tbtn{padding:7px 12px;border:1px solid var(--line);background:#fff;border-radius:6px;cursor:pointer;font-size:13px}
.tbtn.active{background:var(--blue);color:#fff;border-color:var(--blue)}
.layout{display:flex;gap:20px;padding:20px 24px;align-items:flex-start}
aside{width:230px;flex-shrink:0;position:sticky;top:64px}
.side-cat{background:var(--card);border:1px solid var(--line);border-radius:8px;margin-bottom:12px;overflow:hidden}
.side-cat button{display:flex;justify-content:space-between;width:100%;padding:8px 12px;border:0;background:none;cursor:pointer;font-size:13px;text-align:left}
.side-cat button:hover{background:#eef2ff}
.side-cat .bar{height:5px;background:#e5e7eb}
.side-cat .bar i{display:block;height:100%;background:var(--green);width:0;transition:width .2s}
main{flex:1;min-width:0}
.jd{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--blue);border-radius:8px;padding:14px 16px;margin-bottom:16px}
.jd .star{white-space:pre-wrap;line-height:1.7}
.chip{display:inline-block;border-radius:999px;padding:1px 9px;font-size:11px;margin-right:4px;vertical-align:middle}
.chip.cat{background:#eef2ff;color:var(--blue)}
.chip.kw{background:#f3f4f6;color:#374151}
.chip.must{background:#fef3c7;color:#92400e}
.chip.d-基础{background:#ecfdf5;color:#065f46}
.chip.d-进阶{background:#eff6ff;color:#1e40af}
.chip.d-刁钻{background:#fef2f2;color:#991b1b}
.badge{font-size:11px;border-radius:4px;padding:1px 6px;margin-right:4px}
.badge.pass{background:#dcfce7;color:#166534}
.badge.fix{background:#fef9c3;color:#854d0e}
.badge.flag{background:#fee2e2;color:#991b1b}
.badge.unv{background:#e5e7eb;color:#374151}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-bottom:12px}
.card-head{display:flex;align-items:center;gap:2px;flex-wrap:wrap}
.qid{font-weight:700;color:var(--muted);margin-right:8px;font-size:13px}
.target{color:var(--muted);font-size:12px;margin-left:6px}
h3.q{margin:8px 0 4px;font-size:15px;line-height:1.5}
.answer{border-top:1px dashed var(--line);margin-top:8px;padding-top:8px;font-size:13.5px;line-height:1.75}
.answer.hidden{display:none}
.answer ol{margin:4px 0 8px;padding-left:22px}
.follow{color:#475569;margin:2px 0}
.wrong{color:#7f1d1d;background:#fef2f2;border-radius:6px;padding:6px 10px}
.warn{color:#991b1b;background:#fee2e2;border-radius:6px;padding:6px 10px}
.card-foot{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}
.card-foot button{padding:5px 10px;border:1px solid var(--line);background:#f9fafb;border-radius:6px;cursor:pointer;font-size:12px}
.selftest .ok:hover{background:#dcfce7}
.selftest .no:hover{background:#fee2e2}
.mark-status{font-size:12px;color:var(--green)}
table.cmp{border-collapse:collapse;width:100%;margin:6px 0;font-size:12.5px}
.cmp th,.cmp td{border:1px solid var(--line);padding:5px 8px;text-align:left}
.cmp th{background:#f3f4f6}
.cmp-conclusion{margin:4px 0 0}
code{background:#f3f4f6;border-radius:4px;padding:1px 5px;font-size:12px;color:#334155}
.empty{text-align:center;color:var(--muted);padding:40px 0}
.empty.hidden{display:none}
footer{color:var(--muted);font-size:12px;padding:10px 24px 30px}
@media print{.toolbar,.selftest,.card-foot button{display:none}.answer.hidden{display:block}.card{break-inside:avoid}}
</style>
</head>
<body>
<header>
  <h1>代码转面试 · 面试材料报告</h1>
  <div class="meta">生成时间 ${esc(data.generatedAt)} · 模型 ${esc(data.model)} · 校验 通过 <b>${data.stats.pass}</b> / 修订 <b>${data.stats.fix}</b> / 标红 <b>${data.stats.flag}</b></div>
  <div class="stats">
    <span class="stat">题库共 ${data.questions.length} 题</span>
    <span class="stat">必考 ${mustCount} 题</span>
    <span class="stat">类别 ${cats.length} 类</span>
    <span class="stat">一句话:${esc(oneLiner)}</span>
  </div>
</header>

<div class="toolbar">
  <input type="text" id="search" placeholder="搜索问题/要点/追问/对比…" autocomplete="off">
  <select id="catSel">
    <option value="">全部类别</option>${catOptions}
  </select>
  <button type="button" class="tbtn diff active" data-d="">全部难度</button>
  <button type="button" class="tbtn diff" data-d="基础">基础</button>
  <button type="button" class="tbtn diff" data-d="进阶">进阶</button>
  <button type="button" class="tbtn diff" data-d="刁钻">刁钻</button>
  <button type="button" class="tbtn" id="mustBtn">只看必考</button>
  <button type="button" class="tbtn" id="expandAll">全部展开</button>
  <button type="button" class="tbtn" id="collapseAll">全部收起</button>
</div>

<div class="layout">
  <aside id="sidebar"></aside>
  <main>
    ${jdHtml}
    <div id="list">${cards}</div>
    <div class="empty hidden" id="empty">没有匹配的题目</div>
  </main>
</div>

<footer>
  自测说明:先点"隐藏答案"通读题目 → 口述作答 → 展开答案对照 → 点"掌握/没掌握"。左侧进度条为各类别掌握率(数据保存在浏览器本地,按仓库隔离)。⚠ 存疑题以 校验报告.md 为准。
</footer>

<script>
var DATA = ${dataJson};
var STORE_KEY = ${JSON.stringify(storeKey)};
var memStore = {};
function loadStore(){ try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch(e){ return memStore; } }
function saveStore(s){ try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch(e){ memStore = s; } }
var store = loadStore();

/* ---- 事件绑定:全部委托,无内联处理器 ---- */
document.getElementById('search').addEventListener('input', debounce(applyFilter, 150));
document.getElementById('catSel').addEventListener('change', applyFilter);
Array.prototype.forEach.call(document.querySelectorAll('.tbtn.diff'), function(b){
  b.addEventListener('click', function(){
    Array.prototype.forEach.call(document.querySelectorAll('.tbtn.diff'), function(x){ x.classList.remove('active'); });
    b.classList.add('active');
    applyFilter();
  });
});
document.getElementById('mustBtn').addEventListener('click', function(){
  this.classList.toggle('active');
  applyFilter();
});
document.getElementById('expandAll').addEventListener('click', function(){ setAllAnswers(true); });
document.getElementById('collapseAll').addEventListener('click', function(){ setAllAnswers(false); });
document.getElementById('list').addEventListener('click', function(ev){
  var t = ev.target;
  var toggle = t.closest ? t.closest('.js-toggle') : null;
  if (toggle) {
    var el = document.getElementById(toggle.getAttribute('data-id'));
    var a = el && el.querySelector('.answer');
    if (a) a.classList.toggle('hidden');
    return;
  }
  var mark = t.closest ? t.closest('.js-mark') : null;
  if (mark) mark(mark.getAttribute('data-id'), mark.getAttribute('data-ok') === '1');
});
document.getElementById('sidebar').addEventListener('click', function(ev){
  var b = ev.target.closest ? ev.target.closest('.side-btn') : null;
  if (!b) return;
  document.getElementById('catSel').value = b.getAttribute('data-cat');
  applyFilter();
});

function debounce(fn, ms){
  var timer = null;
  return function(){
    var args = arguments, self = this;
    clearTimeout(timer);
    timer = setTimeout(function(){ fn.apply(self, args); }, ms);
  };
}
function setAllAnswers(show){
  Array.prototype.forEach.call(document.querySelectorAll('.answer'), function(a){ a.classList.toggle('hidden', !show); });
}
function applyFilter(){
  var kw = document.getElementById('search').value.trim().toLowerCase();
  var cat = document.getElementById('catSel').value;
  var curDiff = (document.querySelector('.tbtn.diff.active') || {}).getAttribute ? document.querySelector('.tbtn.diff.active').getAttribute('data-d') : '';
  var mustOnly = document.getElementById('mustBtn').classList.contains('active');
  var visible = 0;
  Array.prototype.forEach.call(document.querySelectorAll('.card'), function(c){
    var ok = true;
    if (cat && c.getAttribute('data-cat') !== cat) ok = false;
    if (ok && curDiff && c.getAttribute('data-diff') !== curDiff) ok = false;
    if (ok && mustOnly && c.getAttribute('data-must') !== '1') ok = false;
    if (ok && kw && c.getAttribute('data-text').indexOf(kw) === -1) ok = false;
    c.style.display = ok ? '' : 'none';
    if (ok) visible++;
  });
  document.getElementById('empty').classList.toggle('hidden', visible > 0);
}
function mark(qid, ok){
  store[qid] = ok ? 1 : 0;
  saveStore(store);
  updateMarkStatus(qid);
  updateSidebarCat(qid);
}
function updateMarkStatus(qid){
  var el = document.querySelector('[data-st="' + qid + '"]');
  if (!el) return;
  if (store[qid] === 1){ el.textContent = '✓ 已掌握'; el.style.color = '#16a34a'; }
  else if (store[qid] === 0){ el.textContent = '✗ 弱项'; el.style.color = '#dc2626'; }
  else el.textContent = '';
}
/* 侧栏只在 mark 后增量更新对应类别的百分比,不再全量重建 innerHTML */
function renderSidebar(){
  var byCat = {};
  Array.prototype.forEach.call(document.querySelectorAll('.card'), function(c){
    var cat = c.getAttribute('data-cat');
    (byCat[cat] = byCat[cat] || []).push(c);
  });
  var html = '<div class="side-cat"><button type="button" class="side-btn" data-cat=""><b>全部(' + DATA.total + ')</b></button></div>';
  Object.keys(byCat).forEach(function(cat){
    html += '<div class="side-cat" data-sidecat="' + escAttr(cat) + '">' +
      '<button type="button" class="side-btn" data-cat="' + escAttr(cat) + '">' +
      '<span>' + escAttr(cat) + ' (' + byCat[cat].length + ')</span><span class="pct">0%</span></button>' +
      '<div class="bar"><i style="width:0"></i></div></div>';
  });
  document.getElementById('sidebar').innerHTML = html;
  Object.keys(byCat).forEach(updateSidebarCatFor);
}
function updateSidebarCat(qid){
  var card = document.getElementById(qid);
  if (!card) return;
  updateSidebarCatFor(card.getAttribute('data-cat'));
}
function updateSidebarCatFor(cat){
  var box = document.querySelector('[data-sidecat="' + escAttr(cat) + '"]');
  if (!box) return;
  var cards = box.querySelectorAll('.side-btn')[0];
  var graded = 0, mastered = 0;
  Array.prototype.forEach.call(document.querySelectorAll('.card'), function(c){
    if (c.getAttribute('data-cat') !== cat) return;
    var id = c.id;
    if (store[id] === 1){ mastered++; graded++; }
    else if (store[id] === 0){ graded++; }
  });
  var pct = graded ? Math.round(mastered / graded * 100) : 0;
  var pctEl = box.querySelector('.pct');
  if (pctEl) pctEl.textContent = pct + '%';
  var bar = box.querySelector('.bar i');
  if (bar) bar.style.width = pct + '%';
}
function escAttr(s){ return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }
Array.prototype.forEach.call(document.querySelectorAll('.card'), function(c){ updateMarkStatus(c.id); });
renderSidebar();
</script>
</body>
</html>`;
}
