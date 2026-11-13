/*
 * grid.js — เส้นกริดของโดเมนคำนวณ (rectilinear) แบบสม่ำเสมอ หรือแบบปรับความละเอียดอัตโนมัติ (graded)
 *
 * เมชแบบ graded ใช้เซลล์ขนาด h (ค่าที่ผู้ใช้เลือก) เฉพาะบริเวณที่ผลลัพธ์ขึ้นกับความละเอียดจริง ๆ คือ
 * รอบ CDU (หน้าคอยล์ดูดลม ช่องว่างระหว่างเครื่อง และลำลมร้อนเหนือพัดลม) แล้วค่อย ๆ ขยายเซลล์ออกไป
 * ด้วยอัตราคงที่ (เซลล์ถัดไปใหญ่ขึ้นไม่เกิน ~20%) จนถึงขนาดสูงสุดบริเวณขอบโดเมน ซึ่งมีไว้เพียงให้
 * ขอบเปิดอยู่ห่างพอ ผลคือจำนวนเซลล์ลดลงหลายเท่าโดยความละเอียดรอบเครื่องเท่าเดิม
 *
 *   ขนาดเซลล์เป้าหมายที่ตำแหน่ง x ของแต่ละแกน:  s(x) = min_f [ s_f + g · ระยะจาก x ถึงช่วง f ]  (ไม่เกิน sMax)
 *   - CDU (+ ระยะกันชนรอบเครื่อง และเหนือพัดลม)            : s_f = h  — เส้นกริดอยู่บนแลตทิซเดียวกับเมชสม่ำเสมอ
 *   - ขอบวัตถุอื่นที่อยู่ใกล้ CDU (≤ 1 ม.)                   : s_f = h เช่นกัน
 *   - แนวดิ่งเหนือ CDU ที่ถูกล้อมด้วยวัตถุสูงกว่า (≤ 3 ม.)     : s_f = h ถึงยอดวัตถุนั้น (ลมร้อนวนกลับในช่องแคบ)
 *   - ขอบผนัง / louver / อาคาร / แผ่นพื้น                    : s_f = 2h
 *   - ภายในกรอบรวมของวัตถุทั้งหมด (และต่ำกว่ายอดวัตถุสูงสุด)   : s_f = 4h
 *   - ที่เหลือ (ระยะเผื่อถึงขอบโดเมน)                         : โตได้ถึง sMax = min(8h, 1 ม.)
 *
 * เส้นกริดเก็บเป็นพิกัดหน้าเซลล์: xf[0..nx], yf[0..ny], zf[0..nz]  (เซลล์ i ครอบ xf[i-1]..xf[i])
 */

import { unitExtent } from './models.js';

export const GRADE = {
  growth: 0.2,        // g — อัตราขยายขนาดเซลล์ต่อระยะทาง (≈ อัตราส่วนเซลล์ติดกัน 1.2)
  cduPad: 0.6,        // ม. — ระยะรอบ CDU ที่คงขนาด h
  cduTop: 1.2,        // ม. — ระยะเหนือปากพัดลม/ท่อเป่าที่คงขนาด h (แกนลำลมร้อน)
  confineDist: 3.0,   // ม. — วัตถุที่สูงกว่าเครื่องและอยู่ใกล้กว่านี้ถือว่า "ล้อม" ลำลมร้อน: คงขนาด h ในแนวดิ่งถึงยอดวัตถุนั้น
  confineTop: 0.5,    // ม. — ระยะเผื่อเหนือยอดวัตถุที่ล้อม
  near: 1.0,          // ม. — ขอบวัตถุที่อยู่ใกล้เขต CDU กว่านี้ใช้เซลล์ขนาด h ด้วย (ช่องว่างรอบเครื่องต้องคมชัด)
  objFactor: 2,       // ขนาดเซลล์ที่ขอบวัตถุอื่น = objFactor · h
  bboxFactor: 4,      // ขนาดเซลล์สูงสุดภายในกรอบรวมของวัตถุ = bboxFactor · h
  maxFactor: 8,       // ขนาดเซลล์สูงสุดของโดเมน = min(maxFactor · h, maxSize)
  maxSize: 1.0,       // ม.
};

/** กรอบของ CDU ตามแนวแกนโลก (หลังหมุน) รวม Hood / ใบเบี่ยงลม */
const cduBox = unitExtent;

/** ช่วงที่ต้องการความละเอียดของแต่ละแกน: { x: [{a, b, s}], y: [...], z: [...] } */
export function gradeFeatures(scene, h) {
  const G = GRADE;
  const sMax = Math.max(h, Math.min(G.maxFactor * h, G.maxSize));
  const sObj = Math.min(sMax, G.objFactor * h), sBox = Math.min(sMax, G.bboxFactor * h);
  const F = { x: [], y: [], z: [] };
  const add = (ax, a, b, s, edge = s === sObj) => F[ax].push({ a: Math.min(a, b), b: Math.max(a, b), s, edge });
  const edges = (ax, a, b, s) => { add(ax, a, a, s); add(ax, b, b, s); };
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, top = 0;
  const grow = (a0, a1, b0, b1, t) => { x0 = Math.min(x0, a0); x1 = Math.max(x1, a1); z0 = Math.min(z0, b0); z1 = Math.max(z1, b1); top = Math.max(top, t); };

  // กรอบและยอดของวัตถุที่ไม่ใช่ CDU — ใช้ตรวจว่าลำลมร้อนของเครื่องใดถูกล้อมด้วยของสูง (ช่องแคบ คอกผนังสูง ใต้หลังคา)
  const tall = [];
  for (const o of scene.objects) {
    if (o.type === 'wall') {
      const t = o.thick / 2;
      tall.push({ x0: Math.min(o.x1, o.x2) - t, x1: Math.max(o.x1, o.x2) + t, z0: Math.min(o.z1, o.z2) - t, z1: Math.max(o.z1, o.z2) + t, top: (o.gap || 0) + o.height });
    } else if (o.type === 'building' || o.type === 'slab') {
      const r = (o.rot || 0) * Math.PI / 180, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
      const hx = (o.w * c + o.d * s) / 2, hz = (o.w * s + o.d * c) / 2;
      tall.push({ x0: o.x - hx, x1: o.x + hx, z0: o.z - hz, z1: o.z + hz, top: o.type === 'slab' ? Math.max(0, o.y) : o.h });
    }
  }
  for (const o of scene.objects) {
    if (o.type === 'cdu') {
      const b = cduBox(o);
      add('x', b.x0 - G.cduPad, b.x1 + G.cduPad, h);
      add('z', b.z0 - G.cduPad, b.z1 + G.cduPad, h);
      let yTop = b.y1 + G.cduTop;
      for (const t of tall) {
        if (t.top <= b.y1) continue;
        const dx = Math.max(0, t.x0 - b.x1, b.x0 - t.x1), dz = Math.max(0, t.z0 - b.z1, b.z0 - t.z1);
        if (Math.hypot(dx, dz) <= G.confineDist) yTop = Math.max(yTop, t.top + G.confineTop);
      }
      add('y', Math.max(0, b.y0 - G.cduPad), yTop, h);
      grow(b.x0, b.x1, b.z0, b.z1, b.y1);
    } else if (o.type === 'wall') {
      const t = o.thick / 2, y0 = o.gap || 0, y1 = y0 + o.height;
      const ax = Math.abs(o.x2 - o.x1), az = Math.abs(o.z2 - o.z1);
      // ผนังขนานแกน: ต้องการความละเอียดในแนวตั้งฉากผนังและที่ปลายผนัง ไม่ใช่ตลอดความยาว
      if (az < 1e-6) { edges('x', o.x1, o.x2, sObj); add('z', o.z1 - t, o.z1 + t, sObj); }
      else if (ax < 1e-6) { edges('z', o.z1, o.z2, sObj); add('x', o.x1 - t, o.x1 + t, sObj); }
      else { add('x', o.x1, o.x2, sObj); add('z', o.z1, o.z2, sObj); }
      edges('y', y0, y1, sObj);
      grow(Math.min(o.x1, o.x2) - t, Math.max(o.x1, o.x2) + t, Math.min(o.z1, o.z2) - t, Math.max(o.z1, o.z2) + t, y1);
    } else if (o.type === 'building' || o.type === 'slab') {
      const r = (o.rot || 0) * Math.PI / 180, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
      const hx = (o.w * c + o.d * s) / 2, hz = (o.w * s + o.d * c) / 2;
      const axisAligned = Math.min(c, s) < 1e-6;
      if (axisAligned) { edges('x', o.x - hx, o.x + hx, sObj); edges('z', o.z - hz, o.z + hz, sObj); }
      else { add('x', o.x - hx, o.x + hx, sObj); add('z', o.z - hz, o.z + hz, sObj); }
      let yTop;
      if (o.type === 'slab') {
        yTop = Math.max(0, o.y);
        add('y', Math.max(0, yTop - Math.max(0.01, o.thick)), yTop, sObj);
      } else { yTop = o.h; add('y', yTop, yTop, sObj); }
      grow(o.x - hx, o.x + hx, o.z - hz, o.z + hz, yTop);
    }
  }
  if (isFinite(x0)) {
    add('x', x0, x1, sBox, false); add('z', z0, z1, sBox, false); add('y', 0, top, sBox, false);
  }
  return { F, sMax };
}

/**
 * เส้นกริดหนึ่งแกนบนช่วง [lo, hi] (ทั้งสองปลายอยู่บนแลตทิซ lo + m·h — โดเมนเท่ากับเมชสม่ำเสมอพอดี)
 *
 * 1) เขตละเอียด = ช่วงของ CDU (s = h) ปัดออกให้ลงแลตทิซ รวมขอบวัตถุอื่นที่อยู่ใกล้ (≤ GRADE.near)
 *    เส้นกริดในเขตนี้อยู่บนแลตทิซเดียวกับเมชสม่ำเสมอ → รูปทรงของเครื่อง ผนัง และช่องว่างรอบเครื่อง
 *    ถูกแปลงเป็นเซลล์เหมือนเมชสม่ำเสมอทุกประการ
 * 2) ช่วงระหว่างเขตละเอียด และช่วงถึงขอบโดเมน เติมด้วยเซลล์ที่โตตามขนาดเป้าหมาย s(x) แล้วหดส่วนที่เกิน h
 *    ลงเท่า ๆ กันให้ยาวพอดีช่วง (อัตราส่วนเซลล์ติดกันจึงไม่เกิน 1 + g)
 */
export function gradedAxis(lo, hi, h, feats, sMax, g = GRADE.growth) {
  const eps = 1e-9;
  const M = Math.round((hi - lo) / h);                      // จำนวนช่องแลตทิซ
  const snapLo = v => Math.max(0, Math.min(M, Math.floor((v - lo) / h + eps)));
  const snapHi = v => Math.max(0, Math.min(M, Math.ceil((v - lo) / h - eps)));
  // เขตละเอียดเป็นดัชนีแลตทิซ [a, b]
  let fine = feats.filter(f => f.s <= h * (1 + eps)).map(f => [snapLo(f.a), snapHi(f.b)]).filter(f => f[1] > f[0]);
  const merge = (list) => {
    list.sort((p, q) => p[0] - q[0]);
    const out = [];
    for (const f of list) {
      const last = out[out.length - 1];
      if (last && f[0] - last[1] <= 3) last[1] = Math.max(last[1], f[1]);   // ช่องว่างแคบกว่า 3 เซลล์: เติมละเอียดไปเลย
      else out.push([f[0], f[1]]);
    }
    return out;
  };
  fine = merge(fine);
  // ขอบวัตถุ (s > h) ที่อยู่ใกล้เขตละเอียด: ขยายเขตละเอียดไปครอบ (เผื่อข้างละ 2 เซลล์)
  const nearCells = GRADE.near / h;
  for (let pass = 0; pass < 4 && fine.length; pass++) {
    let changed = false;
    for (const f of feats) {
      if (f.s <= h * (1 + eps) || !f.edge) continue;
      const a = snapLo(f.a), b = snapHi(f.b);
      for (const z of fine) {
        const gap = a > z[1] ? a - z[1] : b < z[0] ? z[0] - b : 0;
        if (gap > nearCells) continue;
        const na = Math.max(0, Math.min(z[0], a - 2)), nb = Math.min(M, Math.max(z[1], b + 2));
        if (na !== z[0] || nb !== z[1]) { z[0] = na; z[1] = nb; changed = true; }
        break;
      }
    }
    fine = merge(fine);
    if (!changed) break;
  }
  const X = m => lo + m * h;
  const zones = fine.map(z => ({ a: X(z[0]), b: X(z[1]), s: h }));
  const all = feats.filter(f => f.s > h * (1 + eps)).concat(zones);
  const size = x => {
    let s = sMax;
    for (const f of all) {
      const d = x < f.a ? f.a - x : x > f.b ? x - f.b : 0;
      const v = f.s + g * d;
      if (v < s) s = v;
    }
    return s < h ? h : s;
  };
  /** ขนาดเซลล์ที่เติมช่วง [p, q] (ดัชนีแลตทิซ) พอดี เรียงจาก p ไป q */
  const fill = (p, q) => {
    const len = (q - p) * h, x0 = X(p);
    const sz = [];
    let t = 0;
    while (t < len - eps && sz.length < 100000) {
      const x = x0 + t;
      let step = size(x);
      for (let it = 0; it < 6; it++) step = Math.min(size(x), size(x + step / 2), size(x + step));
      sz.push(step); t += step;
    }
    const over = t - len;
    let E = 0;
    for (const v of sz) E += v - h;
    if (over > eps) {
      if (E <= over + eps) return new Array(q - p).fill(h);   // ช่วงสั้นเกินกว่าจะขยายเซลล์ได้
      const k = 1 - over / E;
      for (let i = 0; i < sz.length; i++) sz[i] = h + k * (sz[i] - h);
    }
    return sz;
  };
  const xs = [lo];
  const pushSizes = (sz, end) => {
    let x = xs[xs.length - 1];
    for (let i = 0; i < sz.length - 1; i++) { x += sz[i]; xs.push(x); }
    if (sz.length) xs.push(end);   // ปลายช่วงลงแลตทิซพอดี ไม่สะสมเศษทศนิยม
  };
  let at = 0;
  for (const z of fine) {
    if (z[0] > at) pushSizes(fill(at, z[0]), X(z[0]));
    for (let m = Math.max(at, z[0]) + 1; m <= z[1]; m++) xs.push(X(m));
    at = z[1];
  }
  if (at < M) pushSizes(fill(at, M), X(M));
  return Float64Array.from(xs);
}

/** เส้นกริดสม่ำเสมอ n เซลล์ขนาด h เริ่มที่ lo */
export function uniformAxis(lo, n, h) {
  const xs = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) xs[i] = lo + i * h;
  return xs;
}

/** ดัชนีเซลล์ (1..n) ที่ครอบพิกัด x — คืน 0 หรือ n+1 ถ้าอยู่นอกโดเมน (เหมือน floor ของกริดสม่ำเสมอ) */
export function cellIndex(xf, x) {
  const n = xf.length - 1;
  if (x < xf[0]) return 0;
  if (x >= xf[n]) return n + 1;
  let lo = 0, hi = n;   // xf[lo] <= x < xf[hi]
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (x >= xf[m]) lo = m; else hi = m; }
  return lo + 1;
}

/** พิกัดกึ่งกลางเซลล์รวมชั้นเงา: ดัชนี 0..n+1 (เซลล์เงากว้างเท่าเซลล์ริม) */
export function cellCenters(xf) {
  const n = xf.length - 1, c = new Float64Array(n + 2);
  for (let i = 1; i <= n; i++) c[i] = 0.5 * (xf[i - 1] + xf[i]);
  c[0] = xf[0] - 0.5 * (xf[1] - xf[0]);
  c[n + 1] = xf[n] + 0.5 * (xf[n] - xf[n - 1]);
  return c;
}

/**
 * ตำแหน่งในพิกัดดัชนีกึ่งกลางเซลล์ (จำนวนจริง): ค่า fi ที่ทำให้ค่ากลางเซลล์ i0 = floor(fi) และ i0+1
 * ถ่วงน้ำหนักด้วย fi − i0 — ใช้แทรกค่าแบบเชิงเส้นบนกริดไม่สม่ำเสมอ
 */
export function centerCoord(cc, x) {
  const n = cc.length;
  if (x <= cc[0]) return 0;
  if (x >= cc[n - 1]) return n - 1;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (x >= cc[m]) lo = m; else hi = m; }
  return lo + (x - cc[lo]) / (cc[lo + 1] - cc[lo]);
}

/**
 * ตัวหาตำแหน่งแบบเร็วสำหรับการแสดงผล (เรียกถี่มากจากอนุภาคลม/streamline): ตารางค้นหาความละเอียดเท่าเซลล์
 * เล็กสุด แล้วเดินต่ออีกไม่กี่ก้าว
 *   cell(x)  → ดัชนีเซลล์รวมชั้นเงา 0..n+1
 *   coord(x) → พิกัดดัชนีกึ่งกลางเซลล์ (จำนวนจริง 0..n+1) สำหรับแทรกค่าเชิงเส้น
 */
export function axisLocator(xf) {
  const n = xf.length - 1, cc = cellCenters(xf), lo = xf[0], hi = xf[n];
  let hmin = Infinity;
  for (let i = 1; i <= n; i++) hmin = Math.min(hmin, xf[i] - xf[i - 1]);
  const bins = Math.max(1, Math.min(1 << 16, Math.ceil((hi - lo) / hmin)));
  const inv = bins / (hi - lo);
  const lut = new Int32Array(bins + 1);   // ดัชนีเซลล์ (1..n) ที่ครอบจุดเริ่มของแต่ละช่อง
  for (let b = 0, i = 1; b <= bins; b++) {
    const x = lo + b / inv;
    while (i < n && xf[i] <= x) i++;
    lut[b] = i;
  }
  const cell = x => {
    if (x < lo) return 0;
    if (x >= hi) return n + 1;
    let i = lut[((x - lo) * inv) | 0];
    while (i < n && xf[i] <= x) i++;
    while (i > 1 && xf[i - 1] > x) i--;
    return i;
  };
  const coord = x => {
    if (x <= cc[0]) return 0;
    if (x >= cc[n + 1]) return n + 1;
    let i = cell(x);
    if (x < cc[i]) i--;
    return i + (x - cc[i]) / (cc[i + 1] - cc[i]);
  };
  return { cell, coord, cc, n };
}
