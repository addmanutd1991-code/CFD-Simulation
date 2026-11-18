/*
 * scene.js — ข้อมูลแบบจำลอง: วัตถุในฉาก ค่าตั้งต้น ขอบเขตโดเมน ตัวอย่างสำเร็จรูป
 *
 * พิกัดโลก (เมตร): +x = ทิศตะวันออก, +z = ทิศใต้, +y = ขึ้น (ทิศเหนือคือ −z)
 * วัตถุมี 4 ชนิด
 *   cdu      {x, z, rot, elev, model, duct, hoodType, hoodDir, deflect, airflow}
 *            — rot เป็นพหุคูณของ 90°, ด้านหน้าเครื่องหันไป +z เมื่อ rot = 0
 *            — duct = Hood: รุ่นเป่าขึ้น (VRV 6A) คือความสูง Hood เหนือเครื่อง, รุ่นเป่าหน้า (VRV IV S / S Hi)
 *              คือความยาว Hood ที่ยื่นจากหน้ากากพัดลม (0 = ไม่มี Hood)
 *            — hoodType 'straight' | 'elbow' (ท่อโค้งหัก 90°), hoodDir 'front'|'back'|'left'|'right' (ทิศปากลมของ Hood หัก)
 *              และ hoodOut = ระยะที่ Hood หักยื่นพ้นตัวเครื่องไปทางปากลม (ม.) — รุ่นเป่าขึ้น
 *            — deflect 'none'|'up'|'down'|'left'|'right' ทิศทางลมร้อนออกจากเครื่อง (ตรง หรือเบี่ยง 45°) — รุ่นเป่าหน้า
 *   wall     {x1, z1, x2, z2, height, thick, louver, gap} — louver = % พื้นที่เปิด (0 = ผนังทึบ)
 *   building {x, z, w, d, h, rot}
 *   slab     {x, z, w, d, y, thick, rot, open}         — แผ่นพื้นยก/หลังคา: y = ระดับผิวบน, open = % ช่องเปิด (0 = ทึบ)
 */

import { L } from './i18n.js';
import { DEFAULT_PERF, unitSize, unitExtent } from './models.js';
import { gradeFeatures, gradedAxis, uniformAxis } from './grid.js';

export const DEFAULTS = {
  site: { ambient: 35, windSpeed: 0, windDir: 0 },
  // grade: 'auto' = เมชปรับความละเอียดอัตโนมัติ (ละเอียดรอบ CDU ขยายออกสู่ขอบโดเมน) · 'uniform' = เซลล์เท่ากันทั้งโดเมน
  sim: { cell: 0.1, tMax: 1800, grade: 'auto' },
  // เกณฑ์สี CDU ตาม T ลมเข้ารายโมดูล (°C) ที่อากาศภายนอก 35 °C: ≤ green เขียว, ≤ red เหลือง, > red แดง
  bands: { green: 40, red: 46 },
  bc: {
    xmin: { type: 'open', dist: 4 }, xmax: { type: 'open', dist: 4 },
    zmin: { type: 'open', dist: 4 }, zmax: { type: 'open', dist: 4 },
    ymax: { type: 'open', dist: 5 }, ymin: { type: 'wall' },
  },
  perf: { ...DEFAULT_PERF },
};

export function newScene() {
  return {
    version: 2,
    name: L('โปรเจกต์ใหม่', 'New project'),
    site: { ...DEFAULTS.site },
    sim: { ...DEFAULTS.sim },
    bc: cloneBC(DEFAULTS.bc),
    bands: { ...DEFAULTS.bands },
    perf: { ...DEFAULTS.perf },
    objects: [],
  };
}

/**
 * ขอบเขตโดเมน (boundary) หกด้าน
 *   type: 'open' = ขอบเปิด ความดันบรรยากาศ · 'wall' = ผนังทึบ (no-slip) · 'symmetry' = สมมาตร (ผนังลื่น)
 *   dist: ระยะจากวัตถุที่อยู่ริมสุดถึงขอบด้านนั้น (ม.) — ด้านพื้น (ymin) ไม่มีระยะ อยู่ที่ y = 0 เสมอ
 */
export const BC_FACES = ['xmin', 'xmax', 'zmin', 'zmax', 'ymax', 'ymin'];
export const BC_TYPES = ['open', 'wall', 'symmetry'];

export function cloneBC(bc) {
  return Object.fromEntries(BC_FACES.map(f => [f, { ...DEFAULTS.bc[f], ...(bc?.[f] || {}) }]));
}

export function nextId(scene) {
  // ข้าม id ที่ไม่ใช่ตัวเลข (ป้องกัน NaN ลามไปทุกวัตถุใหม่จนคลิกเลือกไม่ได้)
  return scene.objects.reduce((m, o) => (Number.isFinite(o.id) ? Math.max(m, o.id) : m), 0) + 1;
}

export function nextName(scene, type) {
  const prefix = type === 'cdu' ? 'CDU-' : type === 'wall' ? L('ผนัง-', 'Wall-') : type === 'slab' ? L('พื้น-', 'Slab-') : L('อาคาร-', 'Building-');
  let n = 1;
  const names = new Set(scene.objects.map(o => o.name));
  while (names.has(prefix + n)) n++;
  return prefix + n;
}

export function makeObject(scene, type, input = {}) {
  // id/name ที่ไม่ได้ระบุ (รวมถึง undefined ตอนทำสำเนา/วาง) ต้องไม่ทับค่าที่สร้างใหม่
  const { id, name, type: _t, ...props } = input;
  const base = { id: Number.isFinite(id) ? id : nextId(scene), type, name: name || nextName(scene, type) };
  if (type === 'cdu') {
    const o = { ...base, x: 0, z: 0, rot: 0, elev: 0.2, model: 'RXQ16BY1S', duct: 0, hoodType: 'straight', hoodDir: 'front', hoodOut: 0.4, deflect: 'none', airflow: null, ...props };
    o.hoodOut = Math.max(0, Number(o.hoodOut) || 0);
    if (!['straight', 'elbow'].includes(o.hoodType)) o.hoodType = 'straight';
    if (!['front', 'back', 'left', 'right'].includes(o.hoodDir)) o.hoodDir = 'front';
    if (!['none', 'up', 'down', 'left', 'right'].includes(o.deflect)) o.deflect = 'none';
    return o;
  }
  if (type === 'wall') return { ...base, x1: 0, z1: 0, x2: 4, z2: 0, height: 2.4, thick: 0.15, louver: 50, gap: 0, ...props };
  if (type === 'slab') return { ...base, x: 0, z: 0, w: 5, d: 4, y: 3, thick: 0.2, rot: 0, open: 0, ...props };
  return { ...base, x: 0, z: 0, w: 5, d: 4, h: 4.5, rot: 0, ...props };
}

/** ขนาดของ CDU ตามแนวแกนโลก (หลังหมุน) */
export function cduFootprint(o) {
  const s = unitSize(o);
  const swap = o.rot === 90 || o.rot === 270;
  return { sx: swap ? s.d : s.w, sz: swap ? s.w : s.d, h: s.h };
}

/** กรอบสี่เหลี่ยมตามแกน (AABB) ของวัตถุ พร้อมความสูงบนสุด — CDU รวม Hood และใบเบี่ยงลม */
export function objectBounds(o) {
  if (o.type === 'cdu') {
    const e = unitExtent(o);
    return { x0: e.x0, x1: e.x1, z0: e.z0, z1: e.z1, top: e.y1 };
  }
  if (o.type === 'wall') {
    const t = o.thick / 2;
    return {
      x0: Math.min(o.x1, o.x2) - t, x1: Math.max(o.x1, o.x2) + t,
      z0: Math.min(o.z1, o.z2) - t, z1: Math.max(o.z1, o.z2) + t,
      top: o.gap + o.height,
    };
  }
  const r = o.rot * Math.PI / 180, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  const hx = (o.w * c + o.d * s) / 2, hz = (o.w * s + o.d * c) / 2;
  return { x0: o.x - hx, x1: o.x + hx, z0: o.z - hz, z1: o.z + hz, top: o.type === 'slab' ? o.y : o.h };
}

/** ช่วงความสูงของแผ่นพื้น/หลังคา: ผิวบนที่ y หนาลงมา thick (ไม่ต่ำกว่าพื้นดิน) */
export function slabRange(o) {
  const y1 = Math.max(0, o.y), y0 = Math.max(0, y1 - Math.max(0.01, o.thick));
  return { y0, y1 };
}

/** จุด (x, z) อยู่ในรอยเท้าของวัตถุสี่เหลี่ยมหมุนได้ (อาคาร/แผ่นพื้น) หรือไม่ */
export function insideRect(o, x, z) {
  const r = o.rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const dx = x - o.x, dz = z - o.z;
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  return Math.abs(lx) <= o.w / 2 && Math.abs(lz) <= o.d / 2;
}

/**
 * โดเมนคำนวณ: ครอบวัตถุทั้งหมด + ระยะเผื่อรอบด้าน และความสูงเผื่อเหนือวัตถุที่สูงที่สุด
 * คืนเส้นกริด xf/yf/zf (พิกัดหน้าเซลล์) — สม่ำเสมอ หรือปรับความละเอียดอัตโนมัติตาม sim.grade (ดู grid.js)
 * cellsUniform = จำนวนเซลล์ถ้าใช้เซลล์ขนาด h เท่ากันทั้งโดเมน (ไว้เทียบว่าเมช graded ประหยัดไปเท่าใด)
 */
export function domainOf(scene) {
  const { cell } = scene.sim;
  const bc = scene.bc || DEFAULTS.bc;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, ymax = 0;
  for (const o of scene.objects) {
    const b = objectBounds(o);
    x0 = Math.min(x0, b.x0); x1 = Math.max(x1, b.x1);
    z0 = Math.min(z0, b.z0); z1 = Math.max(z1, b.z1);
    ymax = Math.max(ymax, b.top);
  }
  if (!isFinite(x0)) { x0 = 0; x1 = 10; z0 = 0; z1 = 10; }
  const snap = v => Math.round(v / cell) * cell;
  const ox = snap(x0 - bc.xmin.dist), oz = snap(z0 - bc.zmin.dist);
  const W = Math.min(150, Math.ceil((x1 + bc.xmax.dist - ox) / cell) * cell);
  const D = Math.min(150, Math.ceil((z1 + bc.zmax.dist - oz) / cell) * cell);
  const H = Math.min(60, Math.ceil(Math.max(3, ymax + bc.ymax.dist) / cell) * cell);
  const nx = Math.round(W / cell), ny = Math.round(H / cell), nz = Math.round(D / cell);
  const cellsUniform = nx * ny * nz;
  if (scene.sim.grade === 'uniform') {
    return {
      ox, oz, W, H, D, h: cell, nx, ny, nz, cells: cellsUniform, cellsUniform, graded: false, hMax: cell,
      xf: uniformAxis(ox, nx, cell), yf: uniformAxis(0, ny, cell), zf: uniformAxis(oz, nz, cell),
    };
  }
  // โดเมนเท่ากับของเมชสม่ำเสมอพอดี ต่างกันแค่การแบ่งเซลล์ภายใน
  const { F, sMax } = gradeFeatures(scene, cell);
  const xf = gradedAxis(ox, ox + nx * cell, cell, F.x, sMax);
  const yf = gradedAxis(0, ny * cell, cell, F.y, sMax);
  const zf = gradedAxis(oz, oz + nz * cell, cell, F.z, sMax);
  const gx = xf.length - 1, gy = yf.length - 1, gz = zf.length - 1;
  let hMax = cell;
  for (const a of [xf, yf, zf]) for (let i = 1; i < a.length; i++) hMax = Math.max(hMax, a[i] - a[i - 1]);
  return {
    ox, oz, W, H, D, h: cell, nx: gx, ny: gy, nz: gz,
    cells: gx * gy * gz, cellsUniform, graded: true, hMax, xf, yf, zf,
  };
}

/* ───────── ตัวอย่างสำเร็จรูป ───────── */

function withIds(objs) {
  return objs.map((o, i) => ({ id: i + 1, ...o }));
}

const cdu = (name, x, z, rot, model, extra = {}) =>
  ({ type: 'cdu', name, x, z, rot, elev: 0.2, model, duct: 0, airflow: null, ...extra });
const wall = (name, x1, z1, x2, z2, height, louver, extra = {}) =>
  ({ type: 'wall', name, x1, z1, x2, z2, height, thick: 0.15, louver, gap: 0, ...extra });
const bldg = (name, x, z, w, d, h, rot = 0) => ({ type: 'building', name, x, z, w, d, h, rot });

export const PRESETS = [
  {
    key: 'rooftop',
    label: 'ดาดฟ้า — CDU 6 ชุดในคอก louver 50%', labelEn: 'Rooftop — 6 CDUs in a 50% louver enclosure',
    build() {
      return {
        name: L('ดาดฟ้า CDU 6 ชุด', 'Rooftop, 6 CDUs'),
        site: { ambient: 35, windSpeed: 0, windDir: 0 },
        objects: withIds([
          bldg(L('ห้องเครื่อง / ช่องบันได', 'Plant room / stair core'), 3.0, 5.25, 5.0, 6.5, 4.5),
          wall(L('Louver ด้านเหนือ', 'North louver'), 7.0, 1.0, 19.5, 1.0, 2.4, 50),
          wall(L('Louver ด้านตะวันออก', 'East louver'), 19.5, 1.0, 19.5, 9.5, 2.4, 50),
          wall(L('Louver ด้านใต้', 'South louver'), 19.5, 9.5, 7.0, 9.5, 2.4, 50),
          wall(L('Louver ด้านตะวันตก', 'West louver'), 7.0, 9.5, 7.0, 1.0, 2.4, 50),
          cdu('CDU-1', 9.2, 3.1, 0, 'RXQ20BY1S'),
          cdu('CDU-2', 12.6, 3.1, 0, 'RXQ28BY1S'),
          cdu('CDU-3', 16.6, 3.1, 0, 'RXQ20BY1S'),
          cdu('CDU-4', 9.2, 7.4, 180, 'RXQ16BY1S'),
          cdu('CDU-5', 12.6, 7.4, 180, 'RXQ28BY1S'),
          cdu('CDU-6', 16.6, 7.4, 180, 'RXQ16BY1S'),
        ]),
      };
    },
  },
  {
    key: 'rooftop-duct',
    label: 'ดาดฟ้าเดิม + ท่อเป่าลม 1 ม. และ louver 70%', labelEn: 'Same rooftop + 1 m discharge hoods and 70% louvers',
    build() {
      const s = PRESETS[0].build();
      s.name = L('ดาดฟ้า CDU 6 ชุด — แก้ไขด้วยท่อเป่าลม', 'Rooftop, 6 CDUs — fixed with discharge hoods');
      for (const o of s.objects) {
        if (o.type === 'cdu') o.duct = 1.0;
        if (o.type === 'wall') o.louver = 70;
      }
      return s;
    },
  },
  {
    key: 'lightwell',
    label: 'ช่องแคบระหว่างอาคาร (ผนังทึบสูง)', labelEn: 'Narrow gap between buildings (tall solid walls)',
    build() {
      return {
        name: L('CDU ในช่องแคบระหว่างอาคาร', 'CDUs in a gap between buildings'),
        site: { ambient: 35, windSpeed: 0, windDir: 0 },
        objects: withIds([
          bldg(L('อาคาร A', 'Building A'), 6.0, 2.0, 12.0, 4.0, 9.0),
          bldg(L('อาคาร B', 'Building B'), 6.0, 8.0, 12.0, 4.0, 9.0),
          wall(L('ผนังปิดท้าย', 'End wall'), 0.1, 4.0, 0.1, 6.0, 9.0, 0),
          cdu('CDU-1', 2.2, 4.75, 0, 'RXQ12BY1S'),
          cdu('CDU-2', 4.6, 4.75, 0, 'RXQ12BY1S'),
          cdu('CDU-3', 7.0, 4.75, 0, 'RXQ14BY1S'),
          cdu('CDU-4', 9.4, 4.75, 0, 'RXQ14BY1S'),
        ]),
      };
    },
  },
  {
    key: 'ground-wind',
    label: 'ลานพื้นดิน 4 ชุด + ลม 2 m/s จากทิศเหนือ', labelEn: 'Ground yard, 4 CDUs + 2 m/s north wind',
    build() {
      return {
        name: L('ลานพื้นดิน มีลมพัด', 'Ground yard with wind'),
        site: { ambient: 35, windSpeed: 2, windDir: 0 },
        objects: withIds([
          bldg(L('อาคารหลัก', 'Main building'), 8.0, 1.5, 16.0, 3.0, 7.0),
          cdu('CDU-1', 3.0, 4.6, 0, 'RXQ20BY1S'),
          cdu('CDU-2', 6.0, 4.6, 0, 'RXQ20BY1S'),
          cdu('CDU-3', 9.0, 4.6, 0, 'RXQ18BY1S'),
          cdu('CDU-4', 12.0, 4.6, 0, 'RXQ18BY1S'),
          wall(L('รั้วบังตา', 'Screen fence'), 1.5, 7.0, 13.5, 7.0, 2.0, 30),
        ]),
      };
    },
  },
  {
    key: 'canopy-elbow',
    label: 'VRV 6A ใต้หลังคา + Hood ท่อโค้ง 90° ยื่นหน้า', labelEn: 'VRV 6A under a canopy + 90° elbow hoods to the front',
    build() {
      const hood = { duct: 1.2, hoodType: 'elbow', hoodDir: 'front', hoodOut: 0.5 };
      return {
        name: L('VRV 6A ใต้หลังคา — Hood หัก 90°', 'VRV 6A under canopy — 90° elbow hood'),
        site: { ambient: 35, windSpeed: 0, windDir: 0 },
        objects: withIds([
          bldg(L('อาคาร', 'Building'), 4.0, 1.0, 10.0, 2.0, 6.0),
          { type: 'slab', name: L('หลังคาคลุม', 'Canopy roof'), x: 4.0, z: 3.5, w: 10.0, d: 3.0, y: 4.0, thick: 0.2, rot: 0, open: 0 },
          cdu('CDU-1', 2.5, 3.0, 0, 'RXQ12BY1S', hood),
          cdu('CDU-2', 4.0, 3.0, 0, 'RXQ12BY1S', hood),
          cdu('CDU-3', 5.5, 3.0, 0, 'RXQ12BY1S', hood),
        ]),
      };
    },
  },
  {
    key: 'side-deflect',
    label: 'VRV S Hi / IV S เป่าหน้าชิดรั้ว — ลมร้อนเบี่ยงขึ้น 45°', labelEn: 'VRV S Hi / IV S front discharge near a fence — deflected 45° up',
    build() {
      const hood = { deflect: 'up' };
      return {
        name: L('VRV S Hi / IV S เป่าหน้า — ลมร้อนเบี่ยงขึ้น', 'VRV S Hi / IV S front discharge — deflected up'),
        site: { ambient: 35, windSpeed: 0, windDir: 0 },
        objects: withIds([
          bldg(L('อาคาร', 'Building'), 5.0, 0.5, 12.0, 1.0, 6.0),
          wall(L('รั้วทึบ', 'Solid fence'), -1.0, 3.0, 11.0, 3.0, 2.0, 0),
          cdu('CDU-1', 1.5, 1.5, 0, 'RSUQ9AYM', hood),
          cdu('CDU-2', 3.5, 1.5, 0, 'RSUQ8AYM', hood),
          cdu('CDU-3', 5.5, 1.4, 0, 'RXMQ6BVM', hood),
          cdu('CDU-4', 7.5, 1.4, 0, 'RXMQ5BVM', { duct: 0, deflect: 'none' }),
        ]),
      };
    },
  },
  {
    key: 'split-balcony',
    label: 'Split FTKB 2 ชุดในระเบียง — ลมร้อนเบี่ยงออกนอกระเบียง', labelEn: 'Two Split FTKB units on a balcony — deflected outward',
    build() {
      // ระเบียงกว้าง 1.6 ม. ลึก 1.2 ม. เปิดด้านใต้ (ราวกันตก) เครื่องวางซ้อนสองชั้นเป่าขนานผนังเข้าหาผนังข้าง
      return {
        name: L('Split FTKB ในระเบียง — เบี่ยงลมออกนอก', 'Split FTKB on a balcony — deflected outward'),
        site: { ambient: 35, windSpeed: 0, windDir: 0 },
        objects: withIds([
          bldg(L('ผนังห้อง', 'Room wall'), 0.8, -0.5, 4.0, 1.0, 6.0),
          wall(L('ผนังข้างซ้าย', 'Left side wall'), 0.0, 0.0, 0.0, 1.2, 3.0, 0),
          wall(L('ผนังข้างขวา', 'Right side wall'), 1.6, 0.0, 1.6, 1.2, 3.0, 0),
          wall(L('ราวกันตก', 'Balustrade'), 0.0, 1.2, 1.6, 1.2, 1.0, 60, { thick: 0.05 }),
          { type: 'slab', name: L('เพดานระเบียง', 'Balcony ceiling'), x: 0.8, z: 0.6, w: 1.6, d: 1.2, y: 3.0, thick: 0.15, rot: 0, open: 0 },
          cdu('CDU-1', 0.35, 0.6, 90, 'RKB12AV2S', { elev: 0.3, deflect: 'left' }),
          cdu('CDU-2', 0.35, 0.6, 90, 'RKB12AV2S', { elev: 1.1, deflect: 'left' }),
        ]),
      };
    },
  },
];

/* ───────── กรณีศึกษาจากคู่มือ "CFD Simulation Standard — Outdoor unit layout guide" (Siam Daikin, Rev.1) ─────────
 * แต่ละกรณีมีคู่ "แบบเดิม" (ลมร้อนวนกลับ) และ "แบบแก้ไข" ตามที่คู่มือแนะนำ — เปิดได้จากเมนู ไฟล์ → กรณีศึกษา
 * ขนาดฉากประมาณจากภาพในคู่มือ · ระแนง/แผ่นปิดใช้ % พื้นที่เปิดแทนรูปทรงจริง
 *   ระแนงตัว Z ≈ 35% · เหล็กฉีก / Perforate รู Ø30 ระยะ 60 × 45 มม. ≈ 26% · ระแนงใบตรงตามคู่มือ ≥ 70% (ใช้ 75%)
 */
const slab = (name, x, z, w, d, y, extra = {}) => ({ type: 'slab', name, x, z, w, d, y, thick: 0.2, rot: 0, open: 0, ...extra });

/** 1 — ระเบียง 1.6 × 1.2 ม. Split 2 ชุดซ้อนกัน เป่าลมเข้าผนังข้างระเบียง */
function guideBalcony(fix) {
  const d = fix ? 'left' : 'none';
  return [
    bldg(L('ผนังห้อง', 'Room wall'), 0.8, -0.5, 4.0, 1.0, 6.0),
    wall(L('ผนังข้างซ้าย', 'Left side wall'), 0.0, 0.0, 0.0, 1.2, 3.0, 0),
    wall(L('ผนังข้างขวา', 'Right side wall'), 1.6, 0.0, 1.6, 1.2, 3.0, 0),
    wall(L('ราวกันตก', 'Balustrade'), 0.0, 1.2, 1.6, 1.2, 1.0, 60, { thick: 0.05 }),
    slab(L('เพดานระเบียง', 'Balcony ceiling'), 0.8, 0.6, 1.6, 1.2, 3.0, { thick: 0.15 }),
    cdu('CDU-1', 0.35, 0.6, 90, 'RKB12AV2S', { elev: 0.3, deflect: d }),
    cdu('CDU-2', 0.35, 0.6, 90, 'RKB12AV2S', { elev: 1.1, deflect: d }),
  ];
}

/**
 * 2 — ช่องวางคอยล์ร้อนกว้าง 1.5 ม. ลึก 1.0 ม. ผนังทึบ 3 ด้าน เปิดด้านหน้าด้วยระแนงตั้ง 50%
 *     ข้างช่องเป็นระเบียงที่มีประตูทึบกั้น · mode: 'before' | 'side' (เปิดด้านข้างเป็นระแนง 70%) | 'vrv' (Split 3 ชุด → VRV 1 ชุด)
 */
function guideNiche(mode) {
  const objs = [
    bldg(L('อาคาร', 'Building'), 1.75, -0.5, 4.5, 1.0, 6.0),
    wall(L('ผนังทึบด้านซ้าย', 'Solid left wall'), 0.0, 0.0, 0.0, 1.0, 3.6, 0),
    wall(mode === 'side' ? L('ผนังข้าง → ระแนง 70%', 'Side wall → 70% louver') : L('ประตูทึบกั้นระเบียง', 'Solid door to balcony'),
      1.5, 0.0, 1.5, 1.0, 3.6, mode === 'side' ? 70 : 0),
    wall(L('ระแนงตั้งด้านหน้า', 'Front vertical louver'), 0.0, 1.0, 1.5, 1.0, 3.6, 50, { thick: 0.08 }),
    wall(L('ผนังข้างระเบียง', 'Balcony end wall'), 3.5, 0.0, 3.5, 1.0, 3.6, 0),
    wall(L('ราวกันตกระเบียง', 'Balcony balustrade'), 1.5, 1.0, 3.5, 1.0, 1.0, 60, { thick: 0.05 }),
    slab(L('พื้นชั้นบน', 'Floor slab above'), 1.75, 0.5, 3.5, 1.0, 3.6),
  ];
  if (mode === 'vrv') objs.push(cdu('CDU-1', 0.85, 0.5, 0, 'RSUQ8AYM', { elev: 2.4 }));
  else objs.push(
    cdu('CDU-1', 0.75, 0.5, 0, 'RKC24ZV2S', { elev: 0.3 }),
    cdu('CDU-2', 0.75, 0.5, 0, 'RKC24ZV2S', { elev: 1.4 }),
    cdu('CDU-3', 0.75, 0.5, 0, 'RKC24ZV2S', { elev: 2.5 }),
  );
  return objs;
}

/** 3 — ช่องยาวใต้หลังคา Split 4 ชุดเป่าออกด้านหน้าชนขอบปูนสูง 0.6 ม. · mode: 'before' | 'deflect' (ใบปรับทิศขึ้น) | 'raise' (ยกเครื่องพ้นขอบปูน) */
function guideCurb(mode) {
  const ex = mode === 'deflect' ? { deflect: 'up' } : mode === 'raise' ? { elev: 0.7 } : {};
  return [
    bldg(L('อาคาร', 'Building'), 3.0, -0.5, 6.4, 1.0, 6.0),
    wall(L('ผนังปลายซ้าย', 'Left end wall'), 0.0, 0.0, 0.0, 1.0, 2.8, 0),
    wall(L('ผนังปลายขวา', 'Right end wall'), 6.0, 0.0, 6.0, 1.0, 2.8, 0),
    wall(L('ขอบปูน', 'Concrete upstand'), 0.0, 1.0, 6.0, 1.0, 0.6, 0, { thick: 0.2 }),
    slab(L('หลังคา', 'Roof'), 3.0, 0.5, 6.0, 1.0, 2.8),
    ...[1.2, 2.4, 3.6, 4.8].map((x, i) => cdu(`CDU-${i + 1}`, x, 0.45, 0, 'RKC18ZV2S', { elev: 0.05, ...ex })),
  ];
}

/** 4 — ดาดฟ้า 10 × 6 ม. ล้อมด้วยผนังอิฐทึบสูง 2.6 ม. · fix: ผนัง → ระแนง 70%, VRV 6A ต่อ Hood ตรง 1 ม. พ้นผนัง, รุ่นเป่าหน้าปรับทิศขึ้น */
function guideEnclosure(fix) {
  const lv = fix ? 70 : 0, name = fix ? L('ระแนง', 'Louver') : L('ผนังอิฐ', 'Brick wall');
  const top = fix ? { duct: 1.0 } : {}, side = fix ? { deflect: 'up' } : {};
  return [
    wall(`${name} ${L('เหนือ', 'N')}`, 0, 0, 10, 0, 2.6, lv),
    wall(`${name} ${L('ตะวันออก', 'E')}`, 10, 0, 10, 6, 2.6, lv),
    wall(`${name} ${L('ใต้', 'S')}`, 10, 6, 0, 6, 2.6, lv),
    wall(`${name} ${L('ตะวันตก', 'W')}`, 0, 6, 0, 0, 2.6, lv),
    cdu('CDU-1', 4.8, 2.3, 180, 'RXQ20BY1S', top),
    cdu('CDU-2', 4.8, 3.7, 0, 'RXQ20BY1S', top),
    cdu('CDU-3', 7.4, 2.3, 180, 'RXQ16BY1S', top),
    cdu('CDU-4', 7.4, 3.7, 0, 'RXQ16BY1S', top),
    cdu('CDU-5', 1.6, 1.6, 90, 'RXMQ6BVM', side),
    cdu('CDU-6', 1.6, 3.0, 90, 'RXMQ6BVM', side),
    cdu('CDU-7', 1.6, 4.4, 90, 'RXMQ6BVM', side),
  ];
}

/** 5 — ช่องวางเครื่องกว้าง 3.2 ม. ลึก 1.0 ม. VRV IV S 2 ชุดเป่าออกผ่านระแนงหน้าอาคาร (% พื้นที่เปิด = open) */
function guideScreen(open, label) {
  return [
    bldg(L('อาคาร', 'Building'), 1.6, -0.5, 4.2, 1.0, 6.0),
    wall(L('ผนังข้างซ้าย', 'Left side wall'), 0.0, 0.0, 0.0, 1.0, 3.0, 0),
    wall(L('ผนังข้างขวา', 'Right side wall'), 3.2, 0.0, 3.2, 1.0, 3.0, 0),
    wall(label, 0.0, 1.0, 3.2, 1.0, 3.0, open, { thick: 0.08 }),
    slab(L('พื้นชั้นบน', 'Floor slab above'), 1.6, 0.5, 3.2, 1.0, 3.0),
    cdu('CDU-1', 0.9, 0.45, 0, 'RXMQ6BVM'),
    cdu('CDU-2', 2.3, 0.45, 0, 'RXMQ6BVM'),
  ];
}

/** 6 — ห้องเครื่องลึก 2.5 ม. VRV 6A 3 ชุดต่อ Hood หัก 90° เป่าออกหน้าอาคารผ่านแผงปิด (% พื้นที่เปิด = open) */
function guideHoodScreen(open, label) {
  const hood = { duct: 0.8, hoodType: 'elbow', hoodDir: 'front', hoodOut: 1.0 };
  return [
    bldg(L('อาคาร', 'Building'), 2.5, -0.5, 5.4, 1.0, 6.0),
    wall(L('ผนังข้างซ้าย', 'Left side wall'), 0.0, 0.0, 0.0, 2.5, 3.4, 0),
    wall(L('ผนังข้างขวา', 'Right side wall'), 5.0, 0.0, 5.0, 2.5, 3.4, 0),
    wall(label, 0.0, 2.5, 5.0, 2.5, 3.4, open, { thick: 0.08 }),
    slab(L('พื้นชั้นบน', 'Floor slab above'), 2.5, 1.25, 5.0, 2.5, 3.4),
    cdu('CDU-1', 1.2, 1.0, 0, 'RXQ12BY1S', hood),
    cdu('CDU-2', 2.5, 1.0, 0, 'RXQ12BY1S', hood),
    cdu('CDU-3', 3.8, 1.0, 0, 'RXQ12BY1S', hood),
  ];
}

/** 7 — VRV 6A 3 ชุดใต้สแลบ (ช่องว่างเหนือเครื่อง ~0.6 ม.) · fix: Hood หัก 90° ยื่นพ้นขอบสแลบ */
function guideUnderSlab(fix) {
  const hood = fix ? { duct: 0.6, hoodType: 'elbow', hoodDir: 'front', hoodOut: 1.0 } : {};
  return [
    bldg(L('อาคาร', 'Building'), 3.0, -0.5, 6.4, 1.0, 6.0),
    wall(L('ผนังข้างซ้าย', 'Left side wall'), 0.0, 0.0, 0.0, 2.2, 2.9, 0),
    wall(L('ผนังข้างขวา', 'Right side wall'), 6.0, 0.0, 6.0, 2.2, 2.9, 0),
    slab(L('สแลบ / ฝ้าเพดาน', 'Slab / ceiling'), 3.0, 1.1, 6.0, 2.2, 2.9),
    ...[1.6, 3.0, 4.4].map((x, i) => cdu(`CDU-${i + 1}`, x, 0.88, 0, 'RXQ12BY1S', hood)),
  ];
}

/** [เลขกรณี, หัวข้อ (ไทย, อังกฤษ), รายการแบบ: [variant, ชื่อปุ่ม (ไทย, อังกฤษ), คำอธิบายฉาก (ไทย, อังกฤษ), build objects]] */
const GUIDE = [
  ['1', 'คอยล์ร้อนเป่าลมร้อนใส่ระเบียง', 'Hot air blown into a balcony', [
    ['before', 'เป่าเข้าผนังระเบียง', 'blowing at the balcony wall', () => guideBalcony(false)],
    ['after', 'ใบปรับทิศลมออกนอกระเบียง', 'deflector louver aimed out of the balcony', () => guideBalcony(true)],
  ]],
  ['2.1', 'ผนังทึบ 3 ด้าน — เพิ่มพื้นที่เปิดด้านข้าง', 'Solid walls on 3 sides — open the side', [
    ['before', 'ระแนงหน้าด้านเดียว ประตูทึบ', 'front louver only, solid door', () => guideNiche('before')],
    ['after', 'เปิดผนังข้างเป็นระแนง 70%', 'side wall opened as a 70% louver', () => guideNiche('side')],
  ]],
  ['2.2', 'ผนังทึบ 3 ด้าน — เปลี่ยนเป็น VRV', 'Solid walls on 3 sides — switch to VRV', [
    ['before', 'Split 3 ชุดซ้อนกัน', '3 stacked Split units', () => guideNiche('before')],
    ['after', 'VRV S Hi 1 ชุดด้านบน', 'one VRV S Hi unit at the top', () => guideNiche('vrv')],
  ]],
  ['3.1', 'ลมร้อนปะทะขอบปูน — ใบปรับทิศ', 'Hot air hits an upstand — deflector', [
    ['before', 'เป่าชนขอบปูน', 'blowing into the upstand', () => guideCurb('before')],
    ['after', 'ใบปรับทิศลมขึ้น 45°', 'deflector 45° up', () => guideCurb('deflect')],
  ]],
  ['3.2', 'ลมร้อนปะทะขอบปูน — ยกเครื่องสูงขึ้น', 'Hot air hits an upstand — raise the units', [
    ['before', 'เป่าชนขอบปูน', 'blowing into the upstand', () => guideCurb('before')],
    ['after', 'ยกเครื่องพ้นขอบปูน', 'units raised above the upstand', () => guideCurb('raise')],
  ]],
  ['4', 'ผนังทึบล้อมรอบที่วางคอยล์ร้อน', 'Solid walls around the units', [
    ['before', 'ผนังอิฐทึบสูง 2.6 ม.', '2.6 m solid brick walls', () => guideEnclosure(false)],
    ['after', 'ระแนง 70% + Hood + ใบปรับทิศ', '70% louvers + hoods + deflectors', () => guideEnclosure(true)],
  ]],
  ['5.1', 'ระแนงไม่เหมาะกับการระบายอากาศ — ระแนงตัว Z', 'Unsuitable screen — Z-louver', [
    ['before', 'ระแนงตัว Z (เปิด ~35%)', 'Z-louver (~35% open)', () => guideScreen(35, L('ระแนงตัว Z ~35%', 'Z-louver ~35%'))],
    ['after', 'ระแนงใบตรง 75%', 'straight louver 75%', () => guideScreen(75, L('ระแนงใบตรง 75%', 'Straight louver 75%'))],
  ]],
  ['5.2', 'ระแนงไม่เหมาะกับการระบายอากาศ — เหล็กฉีก / Perforate', 'Unsuitable screen — expanded / perforated metal', [
    ['before', 'แผ่น Perforate (เปิด ~26%)', 'perforated sheet (~26% open)', () => guideScreen(26, L('เหล็กฉีก / Perforate ~26%', 'Expanded / perforated ~26%'))],
    ['after', 'ระแนงใบตรง 75%', 'straight louver 75%', () => guideScreen(75, L('ระแนงใบตรง 75%', 'Straight louver 75%'))],
  ]],
  ['6', 'การอั้นลมร้อนภายใน Hood', 'Hot air trapped inside the hood', [
    ['before', 'ปาก Hood ชนแผ่น Perforate ~26%', 'hood outlet behind ~26% perforated sheet', () => guideHoodScreen(26, L('แผ่น Perforate ~26%', 'Perforated sheet ~26%'))],
    ['after', 'ระแนงใบตรง 75%', 'straight louver 75%', () => guideHoodScreen(75, L('ระแนงใบตรง 75%', 'Straight louver 75%'))],
  ]],
  ['7', 'ลมร้อนปะทะฝ้าเพดานหรือสแลบหลังคา', 'Hot air hits a ceiling or slab', [
    ['before', 'ไม่มี Hood', 'no hood', () => guideUnderSlab(false)],
    ['after', 'Hood หัก 90° ยื่นพ้นสแลบ', '90° elbow hood past the slab edge', () => guideUnderSlab(true)],
  ]],
];

for (const [no, th, en, variants] of GUIDE) {
  for (const [variant, vth, ven, objs] of variants) {
    const tag = variant === 'before' ? ['แบบเดิม', 'Original'] : ['แบบแก้ไข', 'Fixed'];
    PRESETS.push({
      key: `guide-${no}-${variant}`, group: 'guide', caseNo: no, variant,
      caseTitle: th, caseTitleEn: en, btn: tag[0], btnEn: tag[1],
      label: `กรณีศึกษา ${no} ${tag[0]} — ${th}: ${vth}`,
      labelEn: `Case ${no} ${tag[1]} — ${en}: ${ven}`,
      build() {
        return {
          name: L(`กรณีศึกษา ${no} ${tag[0]} — ${th}: ${vth}`, `Case ${no} ${tag[1]} — ${en}: ${ven}`),
          site: { ambient: 35, windSpeed: 0, windDir: 0 },
          objects: withIds(objs()),
        };
      },
    });
  }
}

export function presetScene(key) {
  const p = PRESETS.find(q => q.key === key) || PRESETS[0];
  const s = newScene();
  const b = p.build();
  s.name = b.name;
  Object.assign(s.site, b.site || {});
  s.objects = b.objects;
  return s;
}

/** ตรวจและเติมค่าที่หายไปของไฟล์โปรเจกต์ที่เปิดเข้ามา */
export function normalizeScene(raw) {
  const s = newScene();
  if (!raw || typeof raw !== 'object') return s;
  s.name = String(raw.name || s.name);
  Object.assign(s.site, raw.site || {});
  Object.assign(s.sim, raw.sim || {});
  // ไฟล์รุ่นก่อนมี margin/top ร่วมกันทุกด้าน และมีเวลาจำลองสูงสุดแบบตายตัว
  if (raw.sim?.margin != null) for (const f of ['xmin', 'xmax', 'zmin', 'zmax']) s.bc[f].dist = raw.sim.margin;
  if (raw.sim?.top != null) s.bc.ymax.dist = raw.sim.top;
  delete s.sim.margin; delete s.sim.top; delete s.sim.tEnd;
  if (s.sim.grade !== 'uniform') s.sim.grade = 'auto';
  if (raw.bc) s.bc = cloneBC(raw.bc);
  Object.assign(s.bands, raw.bands || {});
  if (!(s.bands.red > s.bands.green)) s.bands = { ...DEFAULTS.bands };
  for (const f of BC_FACES) {
    if (!BC_TYPES.includes(s.bc[f].type) || (f === 'ymin' && s.bc[f].type === 'open')) s.bc[f].type = DEFAULTS.bc[f].type;
    if (f !== 'ymin') s.bc[f].dist = Math.max(0.5, Number(s.bc[f].dist) || DEFAULTS.bc[f].dist);
  }
  Object.assign(s.perf, raw.perf || {});
  const objs = Array.isArray(raw.objects) ? raw.objects : [];
  let id = 1;
  for (const o of objs) {
    if (!o || !['cdu', 'wall', 'building', 'slab'].includes(o.type)) continue;
    const t = makeObject({ objects: s.objects }, o.type, o);
    t.id = id++;
    s.objects.push(t);
  }
  return s;
}
