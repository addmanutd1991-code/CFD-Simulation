/*
 * dxf.js — อ่านไฟล์ DXF (ASCII) เป็นเส้นสองมิติสำหรับใช้เป็นฉากหลัง (underlay) และแปลงเป็นผนัง/อาคาร
 *
 * รองรับ: LINE · LWPOLYLINE / POLYLINE (รวม bulge = ส่วนโค้ง) · ARC · CIRCLE · INSERT (บล็อก ซ้อนกันได้,
 *         สเกล/หมุน/ย้าย) · ตาราง LAYER (สี ACI, ปิด/แช่แข็ง) · $INSUNITS
 * ไม่อ่าน: TEXT/MTEXT, DIMENSION, HATCH, SPLINE, ELLIPSE (ข้ามไป) · ไฟล์ DXF แบบ binary
 *
 * ผลลัพธ์อยู่ในพิกัดของแบบ (หน่วยของไฟล์) — แปลงเป็นเมตรและพิกัดโลกที่ main.js
 */

const ARC_SEG = 24;   // จำนวนช่วงต่อวงกลมเต็มวง

/** ตัวคูณจากหน่วยของไฟล์เป็นเมตร ตาม $INSUNITS */
export const INSUNITS = { 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1, 14: 0.1 };

/** สี ACI พื้นฐาน (index 1–9) — ค่าอื่นใช้สีเทา */
const ACI = { 1: '#e53935', 2: '#d4b106', 3: '#2e9d43', 4: '#0097a7', 5: '#1e5fd6', 6: '#b1359f', 7: '#37474f', 8: '#7d8a94', 9: '#aab4bc' };
export const aciColor = (i) => ACI[Math.abs(i)] || (i > 9 ? `hsl(${(i * 47) % 360} 55% 42%)` : '#37474f');

/** แยกไฟล์เป็นคู่ (รหัสกลุ่ม, ค่า) */
function pairs(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const out = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const c = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(c)) { i -= 1; continue; }   // บรรทัดว่างแทรก — ขยับหนึ่งบรรทัด
    out.push([c, lines[i + 1].trim()]);
  }
  return out;
}

/** อ่านเอนทิตีหนึ่งตัวจากตำแหน่ง i (ชี้ที่รหัส 0) — คืน { type, g: [[code, val]…], next } */
function readEntity(P, i) {
  const type = P[i][1], g = [];
  let j = i + 1;
  while (j < P.length && P[j][0] !== 0) { g.push(P[j]); j++; }
  return { type, g, next: j };
}

const num = (g, code, d = 0) => { const p = g.find(q => q[0] === code); return p ? parseFloat(p[1]) : d; };
const str = (g, code, d = '') => { const p = g.find(q => q[0] === code); return p ? p[1] : d; };

/** จุดบนส่วนโค้งระหว่าง p0 → p1 ตามค่า bulge (ไม่รวมจุดแรก) */
function bulgePts(x0, y0, x1, y1, b) {
  const th = 4 * Math.atan(b), dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
  if (L < 1e-12 || Math.abs(b) < 1e-9) return [[x1, y1]];
  const r = L / (2 * Math.sin(th / 2));
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const h = r * Math.cos(th / 2);   // ระยะจากจุดกึ่งกลางคอร์ดถึงจุดศูนย์กลาง (มีเครื่องหมาย)
  const cx = mx - (dy / L) * h, cy = my + (dx / L) * h;
  const a0 = Math.atan2(y0 - cy, x0 - cx);
  const n = Math.max(2, Math.ceil(Math.abs(th) / (2 * Math.PI) * ARC_SEG));
  const R = Math.abs(r), out = [];
  for (let k = 1; k <= n; k++) {
    const a = a0 + th * k / n;
    out.push(k === n ? [x1, y1] : [cx + R * Math.cos(a), cy + R * Math.sin(a)]);
  }
  return out;
}

function arcPts(cx, cy, r, a0, a1) {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += 2 * Math.PI;
  const n = Math.max(2, Math.ceil(sweep / (2 * Math.PI) * ARC_SEG));
  const out = [];
  for (let k = 0; k <= n; k++) { const a = a0 + sweep * k / n; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return out;
}

/** เอนทิตีเรขาคณิตเป็นเส้นหลายจุด { layer, pts:[[x,y]…], closed } (พิกัดของบล็อก/แบบ ยังไม่แปลง) */
function entityPolys(e, P) {
  const { type, g } = e, layer = str(g, 8, '0');
  if (type === 'LINE') return [{ layer, pts: [[num(g, 10), num(g, 20)], [num(g, 11), num(g, 21)]], closed: false }];
  if (type === 'LWPOLYLINE') {
    const closed = (num(g, 70) & 1) === 1;
    const v = [];
    for (const [c, val] of g) {
      if (c === 10) v.push({ x: parseFloat(val), y: 0, b: 0 });
      else if (c === 20 && v.length) v[v.length - 1].y = parseFloat(val);
      else if (c === 42 && v.length) v[v.length - 1].b = parseFloat(val);
    }
    return v.length ? [{ layer, pts: expandBulges(v, closed), closed }] : [];
  }
  if (type === 'ARC') {
    const d2r = Math.PI / 180;
    return [{ layer, pts: arcPts(num(g, 10), num(g, 20), num(g, 40), num(g, 50) * d2r, num(g, 51) * d2r), closed: false }];
  }
  if (type === 'CIRCLE') {
    const pts = arcPts(num(g, 10), num(g, 20), num(g, 40), 0, 2 * Math.PI);
    pts.pop();
    return [{ layer, pts, closed: true }];
  }
  void P;
  return [];
}

function expandBulges(v, closed) {
  const pts = [[v[0].x, v[0].y]];
  const n = v.length, last = closed ? n : n - 1;
  for (let k = 0; k < last; k++) {
    const a = v[k], b = v[(k + 1) % n];
    const seg = bulgePts(a.x, a.y, b.x, b.y, a.b);
    if (closed && k === n - 1) seg.pop();   // จุดปิดซ้ำกับจุดแรก
    pts.push(...seg);
  }
  return pts;
}

/** อ่านรายการเอนทิตีตั้งแต่ i จนถึงตัวจบ (ENDSEC / ENDBLK) — POLYLINE+VERTEX รวมเป็นตัวเดียว */
function readEntities(P, i, endTypes) {
  const list = [];
  while (i < P.length) {
    if (P[i][0] !== 0) { i++; continue; }
    const t = P[i][1];
    if (endTypes.includes(t)) break;
    const e = readEntity(P, i);
    i = e.next;
    if (t === 'POLYLINE') {
      const v = [];
      while (i < P.length && P[i][0] === 0 && P[i][1] === 'VERTEX') {
        const ve = readEntity(P, i);
        i = ve.next;
        if (num(ve.g, 70) & 16) continue;   // จุดควบคุม spline
        v.push({ x: num(ve.g, 10), y: num(ve.g, 20), b: num(ve.g, 42) });
      }
      if (i < P.length && P[i][1] === 'SEQEND') i = readEntity(P, i).next;
      e.type = 'LWPOLYLINE_V'; e.verts = v;
    }
    list.push(e);
  }
  return { list, next: i };
}

/**
 * อ่านข้อความ DXF → { units (ตัวคูณเป็นเมตร หรือ 0 ถ้าไม่ระบุ), layers: Map(name → {color, off}), polys: [{layer, pts, closed}], bbox, skipped }
 */
export function parseDXF(text) {
  if (/^AutoCAD Binary DXF/.test(text.slice(0, 22))) throw new Error('Binary DXF');
  const P = pairs(text);
  let units = 0;
  const layers = new Map(), blocks = new Map();
  let entities = [];
  let i = 0;
  while (i < P.length) {
    if (P[i][0] === 0 && P[i][1] === 'SECTION') {
      const name = P[i + 1]?.[1];
      i += 2;
      if (name === 'HEADER') {
        for (; i < P.length && !(P[i][0] === 0 && P[i][1] === 'ENDSEC'); i++) {
          if (P[i][0] === 9 && P[i][1] === '$INSUNITS') { const u = parseInt(P[i + 1]?.[1], 10); units = INSUNITS[u] || 0; }
        }
      } else if (name === 'TABLES') {
        for (; i < P.length && !(P[i][0] === 0 && P[i][1] === 'ENDSEC');) {
          if (P[i][0] === 0 && P[i][1] === 'LAYER') {
            const e = readEntity(P, i);
            i = e.next;
            const nm = str(e.g, 2);
            if (nm) {
              const col = num(e.g, 62, 7), fl = num(e.g, 70);
              layers.set(nm, { color: aciColor(col), off: col < 0 || (fl & 1) === 1 });
            }
          } else i++;
        }
      } else if (name === 'BLOCKS') {
        while (i < P.length && !(P[i][0] === 0 && P[i][1] === 'ENDSEC')) {
          if (P[i][0] === 0 && P[i][1] === 'BLOCK') {
            const b = readEntity(P, i);
            const r = readEntities(P, b.next, ['ENDBLK']);
            blocks.set(str(b.g, 2), { bx: num(b.g, 10), by: num(b.g, 20), list: r.list });
            i = r.next + 1;
          } else i++;
        }
      } else if (name === 'ENTITIES') {
        const r = readEntities(P, i, ['ENDSEC']);
        entities = r.list;
        i = r.next;
      }
    }
    i++;
  }

  const polys = [];
  let skipped = 0;
  // แปลงเอนทิตี (รวมบล็อกที่ INSERT) ด้วยเมทริกซ์ affine [a b c d e f]: x' = a·x + b·y + e, y' = c·x + d·y + f
  const emit = (list, M, inheritLayer, depth) => {
    for (const e of list) {
      const layerOf = (l) => (l === '0' && inheritLayer ? inheritLayer : l);
      if (e.type === 'INSERT') {
        if (depth > 8) continue;
        const blk = blocks.get(str(e.g, 2));
        if (!blk) continue;
        const sx = num(e.g, 41, 1), sy = num(e.g, 42, 1), rot = num(e.g, 50) * Math.PI / 180;
        const cs = Math.cos(rot), sn = Math.sin(rot);
        const tx = num(e.g, 10), ty = num(e.g, 20);
        // local: (x - bx)·s → หมุน → + insert point
        const L = [cs * sx, -sn * sy, sn * sx, cs * sy, 0, 0];
        L[4] = tx - (L[0] * blk.bx + L[1] * blk.by);
        L[5] = ty - (L[2] * blk.bx + L[3] * blk.by);
        const N = [
          M[0] * L[0] + M[1] * L[2], M[0] * L[1] + M[1] * L[3],
          M[2] * L[0] + M[3] * L[2], M[2] * L[1] + M[3] * L[3],
          M[0] * L[4] + M[1] * L[5] + M[4], M[2] * L[4] + M[3] * L[5] + M[5],
        ];
        emit(blk.list, N, layerOf(str(e.g, 8, '0')), depth + 1);
        continue;
      }
      let ps;
      if (e.type === 'LWPOLYLINE_V') {
        const closed = (num(e.g, 70) & 1) === 1;
        ps = e.verts.length ? [{ layer: str(e.g, 8, '0'), pts: expandBulges(e.verts, closed), closed }] : [];
      } else ps = entityPolys(e, P);
      if (!ps.length && !['TEXT', 'MTEXT', 'ATTDEF', 'ATTRIB', 'POINT', 'SOLID', 'VIEWPORT'].includes(e.type)) skipped++;
      for (const p of ps) {
        p.layer = layerOf(p.layer);
        p.pts = p.pts.map(([x, y]) => [M[0] * x + M[1] * y + M[4], M[2] * x + M[3] * y + M[5]]);
        if (p.pts.every(q => isFinite(q[0]) && isFinite(q[1]))) polys.push(p);
      }
    }
  };
  emit(entities, [1, 0, 0, 1, 0, 0], null, 0);

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) for (const [x, y] of p.pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  for (const p of polys) if (!layers.has(p.layer)) layers.set(p.layer, { color: aciColor(7), off: false });
  return { units, layers, polys, bbox: { x0, y0, x1, y1 }, skipped };
}

/** เดาหน่วยเมื่อไฟล์ไม่ระบุ: แบบที่กว้างเกิน 2,000 หน่วยน่าจะเป็นมิลลิเมตร */
export function guessUnits(bbox) {
  const span = Math.max(bbox.x1 - bbox.x0, bbox.y1 - bbox.y0);
  return span > 2000 ? 0.001 : span > 300 ? 0.01 : 1;
}

/** ตัดจุดเรียงที่เกือบอยู่ในแนวเดียวกันออก (รวมช่วงตรงที่ต่อกัน) — pts เป็นเมตร */
export function simplifyCollinear(pts, closed, tol = 0.01) {
  if (pts.length < 3) return pts.slice();
  const out = [pts[0]];
  for (let k = 1; k < pts.length - 1; k++) {
    const a = out[out.length - 1], b = pts[k], c = pts[k + 1];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const L = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
    if (Math.abs(cross) / L > tol) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  void closed;
  return out;
}

/** สี่เหลี่ยมผืนผ้าจากเส้นปิด 4 จุด (เมตร) → { cx, cy, w, d, ang } หรือ null */
export function rectOf(pts) {
  let q = pts;
  if (q.length === 5 && Math.hypot(q[0][0] - q[4][0], q[0][1] - q[4][1]) < 1e-6) q = q.slice(0, 4);
  if (q.length !== 4) return null;
  const v = (a, b) => [b[0] - a[0], b[1] - a[1]];
  const e = [v(q[0], q[1]), v(q[1], q[2]), v(q[2], q[3]), v(q[3], q[0])];
  const len = e.map(u => Math.hypot(u[0], u[1]));
  if (len.some(l => l < 0.05)) return null;
  for (let k = 0; k < 4; k++) {
    const a = e[k], b = e[(k + 1) % 4];
    if (Math.abs(a[0] * b[0] + a[1] * b[1]) / (len[k] * len[(k + 1) % 4]) > 0.02) return null;   // มุมไม่ตั้งฉาก
  }
  const cx = (q[0][0] + q[2][0]) / 2, cy = (q[0][1] + q[2][1]) / 2;
  return { cx, cy, w: len[0], d: len[1], ang: Math.atan2(e[0][1], e[0][0]) };
}
