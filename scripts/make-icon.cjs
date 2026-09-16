/*
 * 生成商店图标 media/icon128.png(128×128,零依赖:手写 PNG 编码器 + 几何绘制)。
 * 设计:深色圆角底 + 白色代码书尖括号 + 琥珀色斜杠("</>" 的几何抽象)。
 * 运行:node scripts/make-icon.cjs(产物确定性,可重复生成比对)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 128, H = 128;
const px = new Uint8Array(W * H * 4); // RGBA

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** 点到线段距离 */
function distToSeg(px0, py0, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = clamp01(((px0 - ax) * abx + (py0 - ay) * aby) / (abx * abx + aby * aby));
  const dx = px0 - (ax + t * abx), dy = py0 - (ay + t * aby);
  return Math.hypot(dx, dy);
}

function hex(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }

const BG_TOP = hex('#1E293B'), BG_BOT = hex('#0B1220');
const WHITE = hex('#E2E8F0'), AMBER = hex('#F59E0B');
const TH = 7.5; // 线宽(半径)

const segs = [
  { a: [46, 32], b: [26, 64], c: WHITE }, // < 上
  { a: [26, 64], b: [46, 96], c: WHITE }, // < 下
  { a: [82, 32], b: [102, 64], c: WHITE }, // > 上
  { a: [102, 64], b: [82, 96], c: WHITE }, // > 下
  { a: [74, 26], b: [56, 102], c: AMBER }, // /
];

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    // 垂直渐变背景
    const t = y / (H - 1);
    let r = BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t;
    let g = BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t;
    let b = BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t;
    let a = 255;
    // 圆角蒙版(半径 22):四角外透明
    const cr = 22;
    const cx = Math.max(cr - x, 0, x - (W - 1 - cr));
    const cy = Math.max(cr - y, 0, y - (H - 1 - cr));
    const cornerD = Math.hypot(cx, cy);
    if (cornerD > cr) { a = 0; }
    else if (cornerD > cr - 1.5) { a = Math.round(255 * (cr - cornerD) / 1.5); } // 边缘抗锯齿
    // 前景笔画(圆帽):距离 < 半径,1.5px 抗锯齿
    for (const s of segs) {
      const d = distToSeg(x + 0.5, y + 0.5, s.a[0], s.a[1], s.b[0], s.b[1]);
      if (d < TH) {
        const fg = s.c;
        const mix = d > TH - 1.5 ? (TH - d) / 1.5 : 1;
        r = r + (fg[0] - r) * mix;
        g = g + (fg[1] - g) * mix;
        b = b + (fg[2] - b) * mix;
      }
    }
    px[i] = Math.round(r); px[i + 1] = Math.round(g); px[i + 2] = Math.round(b); px[i + 3] = a;
  }
}

/* ---- 最小 PNG 编码器 ---- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0; // filter: none
  Buffer.from(px.buffer, y * W * 4, W * 4).copy(raw, y * (1 + W * 4) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.resolve(__dirname, '../vscode/media/icon128.png');
fs.writeFileSync(out, png);
console.log(`✓ 商店图标已生成:${out}(${png.length} 字节,128×128 RGBA)`);
