/*
 * devices.js — คลังอุปกรณ์เครื่องปรับอากาศและการแปลงเป็นเงื่อนไขขอบของ CFD
 *
 * ระบบพิกัดเฉพาะตัว (local) ของอุปกรณ์:
 *   +X = ด้านหน้า (ทิศที่ลมจ่ายออก)   +Y = ขึ้น   +Z = ด้านข้าง
 * มุม yaw หมุนรอบแกน Y เป็นขั้นละ 90°
 */

import {
  VRV_HT, VRV_DEP, VRV_DEFAULTS, vrvModules, vrvWidth, vrvCatalogFlow, vrvHeatW,
} from './catalog.js';

const RHO = 1.2, CP = 1005;
const BTU_TO_W = 0.29307;

/* ───────── เครื่องมือช่วยด้านเรขาคณิต ───────── */

function rot(yaw, x, z) {
  const r = yaw * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [x * c + z * s, -x * s + z * c];
}

/** แปลงกล่องพิกัดเฉพาะตัว → กล่องพิกัดโลก (yaw เป็นพหุคูณของ 90° จึงยังเป็น AABB) */
export function toWorldBox(dev, lb) {
  const [ax, az] = rot(dev.yaw, lb.x0, lb.z0);
  const [bx, bz] = rot(dev.yaw, lb.x1, lb.z1);
  const [cx2, cz2] = rot(dev.yaw, lb.x0, lb.z1);
  const [dx2, dz2] = rot(dev.yaw, lb.x1, lb.z0);
  return {
    x0: dev.pos.x + Math.min(ax, bx, cx2, dx2), x1: dev.pos.x + Math.max(ax, bx, cx2, dx2),
    y0: dev.pos.y + lb.y0, y1: dev.pos.y + lb.y1,
    z0: dev.pos.z + Math.min(az, bz, cz2, dz2), z1: dev.pos.z + Math.max(az, bz, cz2, dz2),
  };
}

export function toWorldDir(dev, d) {
  const [x, z] = rot(dev.yaw, d[0], d[2]);
  const len = Math.hypot(x, d[1], z) || 1;
  return [x / len, d[1] / len, z / len];
}

/* ───────── นิยามอุปกรณ์ ───────── */

export const TYPES = {
  wall: {
    label: 'แอร์ติดผนัง', short: 'Wall Type', icon: '🌬️', color: 0xf2f4f8, kind: 'ac',
    size: { x: 0.22, y: 0.30, z: 1.05 },
    defaults: { btu: 12000, vane: 20, mountY: 2.20 },
    flowPerKBtu: 50,
    regions(dev) {
      const v = dev.vane * Math.PI / 180;
      return [
        { role: 'supply', box: { x0: 0.02, x1: 0.11, y0: -0.15, y1: -0.04, z0: -0.48, z1: 0.48 },
          n: [1, 0, 0], dir: [Math.cos(v), -Math.sin(v), 0], share: 1, area: 0.055 },
        // กริลลมกลับอยู่ด้านบนเครื่องเหมือนแอร์ติดผนังจริง — ห่างจากช่องจ่ายลม
        // เพื่อลดการดูดลมเย็นกลับเข้าเครื่องทันที (short-circuit)
        { role: 'return', box: { x0: -0.10, x1: 0.10, y0: 0.05, y1: 0.15, z0: -0.48, z1: 0.48 },
          n: [0, 1, 0], dir: [0, -1, 0], share: 1, area: 0.20 },
      ];
    },
  },

  cassette: {
    label: 'แอร์ฝังฝ้า 4 ทิศทาง', short: '4-Way Cassette', icon: '✳️', color: 0xf2f4f8, kind: 'ac',
    size: { x: 0.84, y: 0.26, z: 0.84 },
    defaults: { btu: 24000, vane: 35, mountY: null },  // mountY = null → ติดชิดฝ้า
    flowPerKBtu: 48,
    regions(dev) {
      const v = dev.vane * Math.PI / 180, c = Math.cos(v), s = Math.sin(v);
      const yb = { y0: -0.13, y1: -0.04 };
      return [
        { role: 'supply', box: { x0: 0.28, x1: 0.42, z0: -0.42, z1: 0.42, ...yb }, n: [0, -1, 0], dir: [c, -s, 0], share: 0.25, area: 0.048 },
        { role: 'supply', box: { x0: -0.42, x1: -0.28, z0: -0.42, z1: 0.42, ...yb }, n: [0, -1, 0], dir: [-c, -s, 0], share: 0.25, area: 0.048 },
        { role: 'supply', box: { x0: -0.42, x1: 0.42, z0: 0.28, z1: 0.42, ...yb }, n: [0, -1, 0], dir: [0, -s, c], share: 0.25, area: 0.048 },
        { role: 'supply', box: { x0: -0.42, x1: 0.42, z0: -0.42, z1: -0.28, ...yb }, n: [0, -1, 0], dir: [0, -s, -c], share: 0.25, area: 0.048 },
        { role: 'return', box: { x0: -0.20, x1: 0.20, z0: -0.20, z1: 0.20, ...yb }, n: [0, -1, 0], dir: [0, 1, 0], share: 1, area: 0.20 },
      ];
    },
  },

  floor: {
    label: 'แอร์ตั้งพื้น', short: 'Floor Standing', icon: '🗄️', color: 0xeef1f6, kind: 'ac',
    size: { x: 0.35, y: 1.75, z: 0.50 },
    defaults: { btu: 36000, vane: 15, mountY: null },  // mountY = null → วางบนพื้น
    flowPerKBtu: 45,
    regions(dev) {
      const v = dev.vane * Math.PI / 180;
      return [
        { role: 'supply', box: { x0: 0.06, x1: 0.18, y0: 0.50, y1: 0.85, z0: -0.24, z1: 0.24 },
          n: [1, 0, 0], dir: [Math.cos(v), Math.sin(v), 0], share: 1, area: 0.11 },
        { role: 'return', box: { x0: 0.06, x1: 0.18, y0: -0.86, y1: -0.40, z0: -0.24, z1: 0.24 },
          n: [1, 0, 0], dir: [-1, 0, 0], share: 1, area: 0.27 },
      ];
    },
  },

  outdoor: {
    label: 'คอยล์ร้อน (คอนเดนซิ่ง)', short: 'Condensing Unit', icon: '🔥', color: 0xd9dee8, kind: 'cdu',
    size: { x: 0.40, y: 0.75, z: 0.95 },
    defaults: { btu: 24000, discharge: 'front', mountY: null },
    flowPerKBtu: 145,
    regions(dev) {
      const top = dev.discharge === 'top';
      const supply = top
        ? { box: { x0: -0.18, x1: 0.18, y0: 0.28, y1: 0.375, z0: -0.42, z1: 0.42 }, n: [0, 1, 0], dir: [0, 1, 0], area: 0.20 }
        : { box: { x0: 0.09, x1: 0.20, y0: -0.30, y1: 0.30, z0: -0.42, z1: 0.42 }, n: [1, 0, 0], dir: [1, 0, 0], area: 0.20 };
      return [
        { role: 'supply', ...supply, share: 1 },
        { role: 'return', box: { x0: -0.20, x1: -0.09, y0: -0.34, y1: 0.34, z0: -0.44, z1: 0.44 },
          n: [-1, 0, 0], dir: [1, 0, 0], share: 1, area: 0.60 },
      ];
    },
  },

  vrv: {
    label: 'คอยล์ร้อน VRV 6A (Daikin RXQ-BY1S)', short: 'VRV', icon: '🏭', color: 0xe4e7ec, kind: 'cdu',
    size: { x: VRV_DEP, y: VRV_HT, z: vrvWidth('RXQ20BY1S') },
    defaults: { model: 'RXQ20BY1S', ...VRV_DEFAULTS, mountY: null },
    // ลมเข้าด้านหลังและด้านข้างทั้งสอง ลมออกพัดลมด้านบน ตาม catalog
    // พัดลมแต่ละตัวเป็นหน้าจ่ายลมของตัวเอง แบ่งลมตามปริมาณลมของโมดูลนั้น
    regions(dev) {
      const mods = vrvModules(dev.model);
      const air = mods.reduce((a, m) => a + m.air, 0);
      const hx = dev.size.x / 2, hy = dev.size.y / 2, hz = dev.size.z / 2;
      const out = [];
      for (const m of mods) {
        for (const f of m.fans) {
          const s = f.r * Math.sqrt(Math.PI) / 2;   // สี่เหลี่ยมที่มีพื้นที่เท่าวงใบพัด
          out.push({ role: 'supply', box: { x0: -s, x1: s, y0: hy - 0.10, y1: hy, z0: f.z - s, z1: f.z + s },
            n: [0, 1, 0], dir: [0, 1, 0], share: m.air / air / m.fans.length, area: Math.PI * f.r * f.r });
        }
      }
      const yb = { y0: -hy + 0.10, y1: hy - 0.20 }, hIn = yb.y1 - yb.y0;
      const aBack = dev.size.z * hIn, aSide = dev.size.x * hIn, aTot = aBack + 2 * aSide;
      out.push({ role: 'return', box: { x0: -hx, x1: -hx + 0.10, ...yb, z0: -hz, z1: hz },
        n: [-1, 0, 0], dir: [1, 0, 0], share: aBack / aTot, area: aBack });
      out.push({ role: 'return', box: { x0: -hx, x1: hx, ...yb, z0: hz - 0.10, z1: hz },
        n: [0, 0, 1], dir: [0, 0, -1], share: aSide / aTot, area: aSide });
      out.push({ role: 'return', box: { x0: -hx, x1: hx, ...yb, z0: -hz, z1: -hz + 0.10 },
        n: [0, 0, -1], dir: [0, 0, 1], share: aSide / aTot, area: aSide });
      return out;
    },
  },

  louver: {
    label: 'Louver / ผนังบังตาโปร่ง', short: 'Louver', icon: '🟫', color: 0x9aa3b2, kind: 'solid', opacity: 0.45,
    size: { x: 4.0, y: 2.4, z: 0.10 },
    defaults: { free: 50, mountY: null },
    resizable: true,
    regions() { return []; },
  },

  box: {
    label: 'สิ่งกีดขวาง', short: 'Obstacle', icon: '📦', color: 0x8a94a8, kind: 'solid',
    size: { x: 0.80, y: 0.80, z: 0.80 },
    defaults: { mountY: null },
    resizable: true,
    regions() { return []; },
  },

  heat: {
    label: 'แหล่งความร้อน', short: 'Heat Source', icon: '♨️', color: 0xe8703a, kind: 'heat',
    size: { x: 0.45, y: 1.20, z: 0.45 },
    defaults: { watts: 120, solidBody: false, mountY: null },
    resizable: true,
    regions() { return []; },
  },
};

let _seq = 0;

export function createDevice(type, pos, roomH) {
  const def = TYPES[type];
  const d = {
    id: ++_seq,
    type,
    name: `${def.short} ${_seq}`,
    pos: { x: pos.x, y: 0, z: pos.z },
    yaw: 0,
    size: { ...def.size },
    on: true,
    ...def.defaults,
  };
  // แอร์ติดผนังต้องเว้นช่องเหนือเครื่องไว้ให้กริลลมกลับด้านบนดูดอากาศได้
  if (type === 'wall') d.mountY = Math.max(d.size.y / 2, roomH - 0.35 - d.size.y / 2);
  if (def.kind === 'ac' || def.kind === 'cdu') {
    d.flow = Math.round(def.flowPerKBtu * d.btu / 1000 / 10) * 10;
    d.mode = 'auto';
    d.supplyT = type === 'outdoor' ? 45 : 15;
    d.setpoint = 25;
    d.running = true;   // สถานะคอมเพรสเซอร์ (ควบคุมโดยเทอร์โมสตัท)
  }
  if (type === 'vrv') syncVrv(d, true);
  placeY(d, roomH);
  return d;
}

/** ปรับขนาดตัวเครื่องตามรุ่น VRV — resetFlow = true ใช้ปริมาณลมตาม catalog */
export function syncVrv(d, resetFlow) {
  d.size = { x: VRV_DEP, y: VRV_HT, z: vrvWidth(d.model) };
  if (resetFlow || !(d.flow > 0)) d.flow = vrvCatalogFlow(d.model);
  for (const k of Object.keys(VRV_DEFAULTS)) if (!(d[k] > 0)) d[k] = VRV_DEFAULTS[k];
}

/** จัดความสูงตามชนิดอุปกรณ์: ติดฝ้า / วางพื้น / ระบุเอง */
export function placeY(d, roomH) {
  const half = d.size.y / 2;
  if (d.type === 'cassette') d.pos.y = roomH - half - 0.01;
  else if (d.mountY != null) d.pos.y = Math.min(roomH - half, d.mountY);
  else d.pos.y = half;
  d.pos.y = Math.max(half, d.pos.y);
}

export function bodyBox(dev) {
  return toWorldBox(dev, {
    x0: -dev.size.x / 2, x1: dev.size.x / 2,
    y0: -dev.size.y / 2, y1: dev.size.y / 2,
    z0: -dev.size.z / 2, z1: dev.size.z / 2,
  });
}

/** ขนาดตามแกนโลกหลัง yaw (ใช้จำกัดตำแหน่งตอนลาก) */
export function worldFootprint(dev) {
  const swap = dev.yaw === 90 || dev.yaw === 270;
  return { x: swap ? dev.size.z : dev.size.x, z: swap ? dev.size.x : dev.size.z };
}

/* ───────── การแปลงเป็นเงื่อนไขขอบของ solver ───────── */

/**
 * สร้างโดเมนจากรายการอุปกรณ์
 * คืนค่า map: deviceId → { supplies:[region], ret:region }
 */
export function buildDomain(solver, devices, openSides) {
  solver.beginBuild(openSides);
  const bound = new Map();

  // 1) วัตถุทึบก่อน เพื่อให้หน้ากริลที่เพิ่มทีหลังทับได้
  for (const d of devices) {
    const def = TYPES[d.type];
    if (def.kind === 'heat' && !d.solidBody) continue;
    if (d.type === 'louver') addLouver(solver, d);
    else solver.addSolidBox(bodyBox(d));
  }

  // 2) แหล่งความร้อน
  for (const d of devices) {
    if (TYPES[d.type].kind !== 'heat') continue;
    solver.addHeatBox(bodyBox(d), d.watts);
  }

  // 3) หน้าจ่ายลมและหน้าลมกลับ
  for (const d of devices) {
    const def = TYPES[d.type];
    if (def.kind !== 'ac' && def.kind !== 'cdu') continue;
    if (!d.on) continue;
    const flowM3s = d.flow / 3600;
    const entry = { supplies: [], rets: [], dev: d, machine: solver.addMachine() };
    for (const r of def.regions(d)) {
      const box = toWorldBox(d, r.box);
      const dir = toWorldDir(d, r.dir);
      const n = toWorldDir(d, r.n);
      const reg = solver.addFlowRegion(box, dir, n, flowM3s * r.share, r.area);
      reg.role = r.role;
      if (r.role === 'supply') {
        // หน้ากริลคือ inlet boundary: กำหนดอุณหภูมิลมจ่าย ทำให้ลำลมเย็นถูกต้อง
        reg.inlet = solver.addInlet(reg.cells);
        entry.supplies.push(reg);
      } else entry.rets.push(reg);
    }
    bound.set(d.id, entry);
  }

  solver.endBuild();
  return bound;
}

/**
 * Louver บนกริดหยาบ: ใบบังเป็นแถบทึบแนวนอนสูงหนึ่งเซลล์ สลับกับแถบโล่ง
 * จำนวนแถบโล่งเท่าสัดส่วนพื้นที่เปิด (free area) ที่ตั้งไว้
 */
function addLouver(solver, d) {
  const b = bodyBox(d), h = solver.h;
  const j0 = solver.cellJ(b.y0 + 1e-6), j1 = solver.cellJ(b.y1 - 1e-6);
  const rows = j1 - j0 + 1;
  const closed = 1 - Math.max(0, Math.min(100, d.free ?? 50)) / 100;
  for (let r = 0; r < rows; r++) {
    // กระจายแถบทึบให้ทั่วความสูง: แถวที่ r ทึบเมื่อผลรวมสะสมข้ามจำนวนเต็ม
    if (Math.floor((r + 1) * closed + 1e-9) === Math.floor(r * closed + 1e-9)) continue;
    const y0 = (j0 + r - 1) * h;
    solver.addSolidBox({ ...b, y0, y1: y0 + h });
  }
}

/**
 * ปรับกำลังของคอยล์ทุกเครื่องตามอุณหภูมิลมกลับที่วัดได้จริง แล้วอ่านค่ากลับมารายงาน
 * เรียกก่อนทุกสเต็ปการคำนวณ — เป็นวงจรป้อนกลับระหว่างเครื่องกับสภาวะในห้องจริง
 *
 * ใช้วิธี "แหล่งรับ/คายความร้อนที่คอยล์" แทนการบังคับอุณหภูมิลมจ่ายตายตัว
 * เพื่อให้สมดุลพลังงานของโดเมนถูกต้อง: ห้องเย็นลงตามกำลังทำความเย็นจริง
 * ส่วนอุณหภูมิลมจ่ายจะเป็นผลลัพธ์ที่เกิดขึ้นเอง
 */
export function updateSupplyTemps(solver, devices, bound, ambient) {
  for (const d of devices) {
    const e = bound.get(d.id);
    if (!e || !e.rets.length || !e.supplies.length) continue;
    const def = TYPES[d.type];
    // อุณหภูมิลมกลับ = อุณหภูมิอากาศที่กำลังถูกดูดเข้าเครื่อง ถ่วงตามปริมาณลมของแต่ละหน้า
    let sT = 0, sQ = 0;
    for (const r of e.rets) { sT += solver.avgT(r.cells) * r.flow; sQ += r.flow; }
    const Tret = sQ > 0 ? sT / sQ : ambient;
    const mdot = RHO * d.flow / 3600;               // kg/s
    let Ts, watts;

    if (def.kind === 'cdu') {
      // คอยล์ร้อน: ระบายความร้อนทิ้ง ≈ ความสามารถทำความเย็น × 1.25 (รวมงานคอมเพรสเซอร์)
      // VRV ใช้ capacity ตาม catalog × (1 + 1/EER)
      watts = d.type === 'vrv' ? vrvHeatW(d.model, d.eer) : d.btu * BTU_TO_W * 1.25;
      const dT = Math.min(25, watts / (mdot * CP));
      Ts = Math.min(75, Tret + dT);
      d._intakeT = Tret;
      d._scDelta = Tret - ambient;                  // อากาศร้อนวนกลับเข้าคอยล์
      d._dTcoil = dT;
      d._recirc = Math.max(0, d._scDelta) / dT;    // สัดส่วนลมร้อนที่วนกลับ
    } else {
      // เทอร์โมสตัทอ่านอุณหภูมิห้องโดยรวม ไม่ใช่ที่หน้ากริลลมกลับ เพราะบริเวณนั้น
      // อาจมีลมเย็นของตัวเองวนกลับ ทำให้ตัดการทำงานทั้งที่ห้องยังร้อนอยู่
      const roomT = solver.avgTemp ?? ambient;
      d._roomT = roomT;
      if (d.running && roomT < d.setpoint - 0.5) d.running = false;
      else if (!d.running && roomT > d.setpoint + 0.5) d.running = true;

      if (!d.running) {
        watts = 0;                                   // พัดลมหมุนอย่างเดียว
        Ts = Tret;
      } else if (d.mode === 'auto') {
        watts = -d.btu * BTU_TO_W * 0.75;            // ความร้อนสัมผัส ~75% ของขนาดเครื่อง
        Ts = Tret - Math.min(20, -watts / (mdot * CP));
      } else {
        Ts = d.supplyT;
        watts = -Math.max(0, (Tret - Ts) * mdot * CP);
      }
      Ts = Math.max(8, Math.min(40, Ts));            // ไม่ต่ำกว่าจุดที่คอยล์จะเป็นน้ำแข็ง
      d._returnT = Tret;
    }

    // หน้ากริลจ่ายลมที่อุณหภูมิ Ts (รูปแบบการกระจายลมเย็น)
    // ส่วนกำลังของเครื่องบอกให้ solver รักษาสมดุลพลังงานรวมของห้องให้ถูกต้อง
    for (const s of e.supplies) s.inlet.T = Ts;
    e.machine.watts = watts;
    d._supplyT = Ts;
    d._load = Math.abs(watts);
  }
}

export function autoFlow(type, btu) {
  return Math.round(TYPES[type].flowPerKBtu * btu / 1000 / 10) * 10;
}

export const BTU_OPTIONS = [9000, 12000, 18000, 24000, 30000, 36000, 48000, 60000];
