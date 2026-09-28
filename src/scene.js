/*
 * scene.js — ข้อมูลแบบจำลอง: วัตถุในฉาก ค่าตั้งต้น ขอบเขตโดเมน ตัวอย่างสำเร็จรูป
 *
 * พิกัดโลก (เมตร): +x = ทิศตะวันออก, +z = ทิศใต้, +y = ขึ้น (ทิศเหนือคือ −z)
 * วัตถุมี 3 ชนิด
 *   cdu      {x, z, rot, elev, model, duct, airflow}   — rot เป็นพหุคูณของ 90°, ด้านหน้าเครื่องหันไป +z เมื่อ rot = 0
 *   wall     {x1, z1, x2, z2, height, thick, louver, gap} — louver = % พื้นที่เปิด (0 = ผนังทึบ)
 *   building {x, z, w, d, h, rot}
 */

import { DEFAULT_PERF, unitSize } from './models.js';

export const DEFAULTS = {
  site: { ambient: 35, windSpeed: 0, windDir: 0 },
  sim: { cell: 0.25, tEnd: 180, margin: 4, top: 5 },
  perf: { ...DEFAULT_PERF },
};

export function newScene() {
  return {
    version: 2,
    name: 'โปรเจกต์ใหม่',
    site: { ...DEFAULTS.site },
    sim: { ...DEFAULTS.sim },
    perf: { ...DEFAULTS.perf },
    objects: [],
  };
}

export function nextId(scene) {
  return scene.objects.reduce((m, o) => Math.max(m, o.id), 0) + 1;
}

export function nextName(scene, type) {
  const prefix = type === 'cdu' ? 'CDU-' : type === 'wall' ? 'ผนัง-' : 'อาคาร-';
  let n = 1;
  const names = new Set(scene.objects.map(o => o.name));
  while (names.has(prefix + n)) n++;
  return prefix + n;
}

export function makeObject(scene, type, props = {}) {
  const base = { id: nextId(scene), type, name: nextName(scene, type) };
  if (type === 'cdu') return { ...base, x: 0, z: 0, rot: 0, elev: 0.2, model: 'RXQ16BY1S', duct: 0, airflow: null, ...props };
  if (type === 'wall') return { ...base, x1: 0, z1: 0, x2: 4, z2: 0, height: 2.4, thick: 0.15, louver: 50, gap: 0, ...props };
  return { ...base, x: 0, z: 0, w: 5, d: 4, h: 4.5, rot: 0, ...props };
}

/** ขนาดของ CDU ตามแนวแกนโลก (หลังหมุน) */
export function cduFootprint(o) {
  const s = unitSize(o);
  const swap = o.rot === 90 || o.rot === 270;
  return { sx: swap ? s.d : s.w, sz: swap ? s.w : s.d, h: s.h };
}

/** กรอบสี่เหลี่ยมตามแกน (AABB) ของวัตถุ พร้อมความสูงบนสุด */
export function objectBounds(o) {
  if (o.type === 'cdu') {
    const f = cduFootprint(o);
    return { x0: o.x - f.sx / 2, x1: o.x + f.sx / 2, z0: o.z - f.sz / 2, z1: o.z + f.sz / 2, top: o.elev + f.h + (o.duct || 0) };
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
  return { x0: o.x - hx, x1: o.x + hx, z0: o.z - hz, z1: o.z + hz, top: o.h };
}

/**
 * โดเมนคำนวณ: ครอบวัตถุทั้งหมด + ระยะเผื่อรอบด้าน และความสูงเผื่อเหนือวัตถุที่สูงที่สุด
 * ปัดขนาดให้ลงตัวกับขนาดเซลล์
 */
export function domainOf(scene) {
  const { cell, margin, top } = scene.sim;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, ymax = 0;
  for (const o of scene.objects) {
    const b = objectBounds(o);
    x0 = Math.min(x0, b.x0); x1 = Math.max(x1, b.x1);
    z0 = Math.min(z0, b.z0); z1 = Math.max(z1, b.z1);
    ymax = Math.max(ymax, b.top);
  }
  if (!isFinite(x0)) { x0 = 0; x1 = 10; z0 = 0; z1 = 10; }
  const snap = v => Math.round(v / cell) * cell;
  const ox = snap(x0 - margin), oz = snap(z0 - margin);
  const W = Math.min(150, Math.ceil((x1 + margin - ox) / cell) * cell);
  const D = Math.min(150, Math.ceil((z1 + margin - oz) / cell) * cell);
  const H = Math.min(60, Math.ceil(Math.max(6, ymax + top) / cell) * cell);
  const nx = Math.round(W / cell), ny = Math.round(H / cell), nz = Math.round(D / cell);
  return { ox, oz, W, H, D, h: cell, nx, ny, nz, cells: nx * ny * nz };
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
    label: 'ดาดฟ้า — CDU 6 ชุดในคอก louver 50%',
    build() {
      return {
        name: 'ดาดฟ้า CDU 6 ชุด',
        site: { ambient: 35, windSpeed: 0, windDir: 0 },
        objects: withIds([
          bldg('ห้องเครื่อง / ช่องบันได', 3.0, 5.25, 5.0, 6.5, 4.5),
          wall('Louver ด้านเหนือ', 7.0, 1.0, 19.5, 1.0, 2.4, 50),
          wall('Louver ด้านตะวันออก', 19.5, 1.0, 19.5, 9.5, 2.4, 50),
          wall('Louver ด้านใต้', 19.5, 9.5, 7.0, 9.5, 2.4, 50),
          wall('Louver ด้านตะวันตก', 7.0, 9.5, 7.0, 1.0, 2.4, 50),
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
    label: 'ดาดฟ้าเดิม + ท่อเป่าลม 1 ม. และ louver 70%',
    build() {
      const s = PRESETS[0].build();
      s.name = 'ดาดฟ้า CDU 6 ชุด — แก้ไขด้วยท่อเป่าลม';
      for (const o of s.objects) {
        if (o.type === 'cdu') o.duct = 1.0;
        if (o.type === 'wall') o.louver = 70;
      }
      return s;
    },
  },
  {
    key: 'lightwell',
    label: 'ช่องแคบระหว่างอาคาร (ผนังทึบสูง)',
    build() {
      return {
        name: 'CDU ในช่องแคบระหว่างอาคาร',
        site: { ambient: 35, windSpeed: 0, windDir: 0 },
        objects: withIds([
          bldg('อาคาร A', 6.0, 2.0, 12.0, 4.0, 9.0),
          bldg('อาคาร B', 6.0, 8.0, 12.0, 4.0, 9.0),
          wall('ผนังปิดท้าย', 0.1, 4.0, 0.1, 6.0, 9.0, 0),
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
    label: 'ลานพื้นดิน 4 ชุด + ลม 2 m/s จากทิศเหนือ',
    build() {
      return {
        name: 'ลานพื้นดิน มีลมพัด',
        site: { ambient: 35, windSpeed: 2, windDir: 0 },
        objects: withIds([
          bldg('อาคารหลัก', 8.0, 1.5, 16.0, 3.0, 7.0),
          cdu('CDU-1', 3.0, 4.6, 0, 'RXQ20BY1S'),
          cdu('CDU-2', 6.0, 4.6, 0, 'RXQ20BY1S'),
          cdu('CDU-3', 9.0, 4.6, 0, 'RXQ18BY1S'),
          cdu('CDU-4', 12.0, 4.6, 0, 'RXQ18BY1S'),
          wall('รั้วบังตา', 1.5, 7.0, 13.5, 7.0, 2.0, 30),
        ]),
      };
    },
  },
];

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
  Object.assign(s.perf, raw.perf || {});
  const objs = Array.isArray(raw.objects) ? raw.objects : [];
  let id = 1;
  for (const o of objs) {
    if (!o || !['cdu', 'wall', 'building'].includes(o.type)) continue;
    const t = makeObject({ objects: s.objects }, o.type, o);
    t.id = id++;
    s.objects.push(t);
  }
  return s;
}
