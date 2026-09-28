/*
 * mesher.js — แปลงวัตถุในฉากเป็นกริดคำนวณ (voxel) และเงื่อนไขขอบของ CDU
 *
 * กริดมีชั้นเซลล์เงา (ghost) ล้อมรอบหนึ่งชั้น: ดัชนี i = 0 และ i = nx+1 เป็นเงา
 *   ชนิดเซลล์: FLUID = อากาศ, SOLID = ของแข็ง, OPEN = ขอบเปิด (อากาศภายนอก)
 * ความเร็วเก็บแบบ staggered (MAC): u[c] คือหน้าด้าน −x ของเซลล์ c,
 *   v[c] หน้าด้าน −y, w[c] หน้าด้าน −z
 *
 * CDU แต่ละโมดูลกลายเป็น
 *   - กล่องทึบ (ตัวเครื่อง + ฐาน + ท่อเป่าลมถ้ามี)
 *   - หน้าพัดลม: หน้า v ด้านบนของเครื่อง ความเร็วขึ้นคงที่ = อัตราลม / พื้นที่หน้าพัดลม
 *   - หน้าคอยล์ดูดลม: หน้าด้านข้างฝั่ง หลัง/ซ้าย/ขวา ในช่วงความสูงของคอยล์ ความเร็วดูดเข้าคงที่
 *   มวลอากาศเข้า = ออก ทุกโมดูล
 */

import { unitModules, unitSize, FAN_AREA } from './models.js';
import { domainOf } from './scene.js';

export const FLUID = 0, SOLID = 1, OPEN = 2;

const COIL_LO = 0.08, COIL_HI = 0.92;   // ช่วงความสูงของคอยล์ (สัดส่วนความสูงเครื่อง)
const LOUVER_CD = 0.6;                   // สัมประสิทธิ์การไหลผ่านช่องใบเกล็ด

/** ค่าสัมประสิทธิ์ความสูญเสียของ louver จาก % พื้นที่เปิด: K = (1/(Cd·φ) − 1)² */
export function louverK(freePct) {
  const phi = Math.max(0.02, Math.min(1, freePct / 100));
  return (1 / (LOUVER_CD * phi) - 1) ** 2;
}

export function buildMesh(scene) {
  const dom = domainOf(scene);
  const { nx, ny, nz, h, ox, oz } = dom;
  const NX = nx + 2, NY = ny + 2, NZ = nz + 2;
  const sy = NX, sz = NX * NY, N = NX * NY * NZ;
  const type = new Uint8Array(N);
  const kp = new Float32Array(N);                 // ค่าต้านการไหลของ louver ต่อหน่วยความยาว (1/m)
  const owner = new Int32Array(N).fill(-1);       // เซลล์ของแข็งเป็นของโมดูลใด
  const warnings = [];

  const X = i => ox + (i - 0.5) * h, Y = j => (j - 0.5) * h, Z = k => oz + (k - 0.5) * h;
  const I = x => Math.floor((x - ox) / h) + 1, J = y => Math.floor(y / h) + 1, K = z => Math.floor((z - oz) / h) + 1;
  const ci = (a, lo, hi) => a < lo ? lo : a > hi ? hi : a;

  // ชั้นเงา: พื้นเป็นของแข็ง ด้านข้างและด้านบนเป็นขอบเปิด
  for (let k = 0; k < NZ; k++)
    for (let j = 0; j < NY; j++)
      for (let i = 0; i < NX; i++) {
        if (i > 0 && i < NX - 1 && j > 0 && j < NY - 1 && k > 0 && k < NZ - 1) continue;
        type[i + j * sy + k * sz] = j === 0 ? SOLID : OPEN;
      }

  /** วนเซลล์ภายในที่กึ่งกลางอยู่ในกรอบ AABB ที่กำหนด */
  const forBox = (x0, x1, y0, y1, z0, z1, fn) => {
    const i0 = ci(I(x0), 1, nx), i1 = ci(I(x1), 1, nx);
    const j0 = ci(J(y0), 1, ny), j1 = ci(J(y1), 1, ny);
    const k0 = ci(K(z0), 1, nz), k1 = ci(K(z1), 1, nz);
    for (let k = k0; k <= k1; k++) {
      const z = Z(k);
      for (let j = j0; j <= j1; j++) {
        const y = Y(j);
        for (let i = i0; i <= i1; i++) fn(i, j, k, X(i), y, z, i + j * sy + k * sz);
      }
    }
  };

  // ── อาคาร ──
  for (const o of scene.objects) {
    if (o.type !== 'building') continue;
    const r = o.rot * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    const ex = (Math.abs(o.w * c) + Math.abs(o.d * s)) / 2, ez = (Math.abs(o.w * s) + Math.abs(o.d * c)) / 2;
    forBox(o.x - ex, o.x + ex, 0, o.h, o.z - ez, o.z + ez, (i, j, k, x, y, z, id) => {
      if (y > o.h) return;
      const dx = x - o.x, dz = z - o.z;
      // หมุนแบบเดียวกับ three.js (rotation.y = rot): world = R·local → local = Rᵀ·world
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.abs(lx) <= o.w / 2 && Math.abs(lz) <= o.d / 2) { type[id] = SOLID; kp[id] = 0; }
    });
  }

  // ── ผนัง / louver ──
  for (const o of scene.objects) {
    if (o.type !== 'wall') continue;
    const dx = o.x2 - o.x1, dz = o.z2 - o.z1, L = Math.hypot(dx, dz);
    if (L < 1e-3 || o.height <= 0) continue;
    const tx = dx / L, tz = dz / L;
    // ความหนาอย่างน้อยพอให้ผนังทึบต่อเนื่องบนกริด แม้วางเฉียง (กันลมรั่วระหว่างเซลล์)
    const ht = Math.max(o.thick / 2, 0.5 * h * (Math.abs(tx) + Math.abs(tz)));
    const free = o.louver ?? 0;
    if (free >= 100) continue;
    const solid = free <= 0;
    const k = solid ? 0 : louverK(free) / (2 * Math.max(h, 2 * ht));
    const y0 = o.gap || 0, y1 = y0 + o.height;
    forBox(Math.min(o.x1, o.x2) - ht, Math.max(o.x1, o.x2) + ht, y0, y1,
      Math.min(o.z1, o.z2) - ht, Math.max(o.z1, o.z2) + ht, (i, j, kk, x, y, z, id) => {
        if (y < y0 || y > y1) return;
        const px = x - o.x1, pz = z - o.z1;
        const t = px * tx + pz * tz;
        if (t < -ht || t > L + ht) return;
        if (Math.abs(px * tz - pz * tx) > ht) return;
        if (type[id] === SOLID) return;
        if (solid) { type[id] = SOLID; kp[id] = 0; }
        else kp[id] = Math.max(kp[id], k);
      });
  }

  // ── CDU ──
  const modules = [];
  const units = [];
  const cdus = scene.objects.filter(o => o.type === 'cdu');
  const unitBoxes = [];

  cdus.forEach((o, ui) => {
    const sz0 = unitSize(o);
    const rot = ((o.rot % 360) + 360) % 360;
    const r = rot * Math.PI / 180, c = Math.round(Math.cos(r)), s = Math.round(Math.sin(r));
    // local → world: (lx, lz) → (x + lx·c + lz·s, z − lx·s + lz·c)
    const toW = (lx, lz) => [o.x + lx * c + lz * s, o.z - lx * s + lz * c];
    const toL = (dx, dz) => [dx * c - dz * s, dx * s + dz * c];
    const mods = unitModules(o);
    const hw = sz0.w / 2, hd = sz0.d / 2;
    const ex = Math.abs(hw * c) + Math.abs(hd * s), ez = Math.abs(hw * s) + Math.abs(hd * c);
    const yb = o.elev || 0, yt = yb + sz0.h;
    const gBase = modules.length;
    unitBoxes.push({ ui, gBase, n: mods.length });

    // ฐาน (ทึบ) และตัวเครื่อง — ทั้งชุดทึบรวมช่องว่างระหว่างโมดูล
    forBox(o.x - ex, o.x + ex, 0, yt, o.z - ez, o.z + ez, (i, j, k, x, y, z, id) => {
      if (y > yt) return;
      const [lx, lz] = toL(x - o.x, z - o.z);
      if (Math.abs(lx) > hw || Math.abs(lz) > hd) return;
      type[id] = SOLID; kp[id] = 0;
      if (y >= yb) {
        let m = 0;
        for (let q = 0; q < mods.length; q++) if (lx >= mods[q].x0 - 0.02) m = q;
        owner[id] = gBase + m;
      }
    });

    const unit = { id: o.id, name: o.name, model: o.model, modules: [] };
    units.push(unit);

    mods.forEach((md, mi) => {
      const g = gBase + mi;
      const q = md.cmm / 60;   // m³/s
      const rec = {
        unit: ui, unitId: o.id, index: mi, hp: md.hp, kw: md.kw, eer: md.eer, q,
        fanFaces: [], fanVel: [], inAxis: [], inFaces: [], inVel: [], inCells: [],
        blockedPct: 0, fanAreaGrid: 0, fanAreaReal: md.fans * FAN_AREA, active: true,
      };

      // คอลัมน์ของโมดูลนี้และระดับบนสุดของเซลล์ทึบ
      const cols = new Map();
      const mx0 = md.x0, mx1 = md.x1;
      forBox(o.x - ex, o.x + ex, yb, yt, o.z - ez, o.z + ez, (i, j, k, x, y, z, id) => {
        if (owner[id] !== g) return;
        const key = i + k * 100000;
        const cur = cols.get(key);
        if (!cur || j > cur.j) cols.set(key, { i, k, j, x, z });
      });
      if (!cols.size) {
        rec.active = false;
        warnings.push(`${o.name}: โมดูล ${md.hp}HP เล็กกว่าเซลล์ — ลดขนาดเซลล์`);
        modules.push(rec); unit.modules.push(rec);
        return;
      }

      // ── พัดลม ──
      const nWant = Math.max(1, Math.round(FAN_AREA / (h * h)));
      const used = new Set();
      const fanCenters = [];
      for (let f = 0; f < md.fans; f++) {
        const fx = mx0 + (mx1 - mx0) * (f + 0.5) / md.fans;
        fanCenters.push(toW(fx, 0));
      }
      const qFan = q / md.fans;
      for (const [fx, fz] of fanCenters) {
        const cand = [...cols.values()].filter(cc => !used.has(cc.i + cc.k * 100000))
          .sort((a, b) => Math.hypot(a.x - fx, a.z - fz) - Math.hypot(b.x - fx, b.z - fz));
        const pick = cand.slice(0, nWant);
        if (!pick.length) continue;
        const faces = [];
        for (const cc of pick) {
          used.add(cc.i + cc.k * 100000);
          let jt = cc.j;
          // ท่อเป่าลม: ต่อเซลล์ทึบขึ้นไปจนถึงปากท่อ แล้วย้ายหน้าพัดลมไปไว้ที่ปากท่อ
          if (o.duct > 0) {
            const top = yt + o.duct;
            while (jt + 1 <= ny && Y(jt + 1) <= top) { jt++; type[cc.i + jt * sy + cc.k * sz] = SOLID; }
          }
          const above = cc.i + (jt + 1) * sy + cc.k * sz;
          if (jt + 1 > ny || type[above] === SOLID) continue;
          faces.push(above);   // v[above] = หน้าด้านล่างของเซลล์เหนือพัดลม
        }
        if (!faces.length) continue;
        const vel = qFan / (faces.length * h * h);
        for (const f of faces) { rec.fanFaces.push(f); rec.fanVel.push(vel); }
        rec.fanAreaGrid += faces.length * h * h;
      }
      if (!rec.fanFaces.length) {
        rec.active = false;
        warnings.push(`${o.name}: ด้านบนพัดลมถูกปิดทึบ — ไม่คำนวณโมดูลนี้`);
      }
      // ถ้าบางใบพัดหาหน้าไม่ได้ ให้อัตราลมรวมยังถูกต้อง
      const fanQ = rec.fanVel.reduce((s2, v) => s2 + v * h * h, 0);
      if (fanQ > 0 && Math.abs(fanQ - q) > 1e-6) rec.fanVel = rec.fanVel.map(v => v * q / fanQ);

      // ── คอยล์ดูดลม ──
      const cy0 = yb + COIL_LO * sz0.h, cy1 = yb + COIL_HI * sz0.h;
      const dirs = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
      let potential = 0;
      const collect = (sides) => {
        const out = [];
        forBox(o.x - ex, o.x + ex, cy0, cy1, o.z - ez, o.z + ez, (i, j, k, x, y, z, id) => {
          if (owner[id] !== g || y < cy0 || y > cy1) return;
          for (const [di, , dk] of dirs) {
            const [lx, lz] = toL(di, dk);
            const side = lz < -0.5 ? 'back' : lz > 0.5 ? 'front' : lx < -0.5 ? 'left' : 'right';
            if (!sides.includes(side)) continue;
            const nb = id + di + dk * sz;
            const ob = owner[nb];
            if (ob >= gBase && ob < gBase + mods.length) continue;       // ติดกับโมดูลในชุดเดียวกัน
            if (sides === SIDES) potential++;
            if (type[nb] !== FLUID) continue;                             // ถูกผนัง/วัตถุอื่นบัง
            out.push({ id, nb, di, dk });
          }
        });
        return out;
      };
      const SIDES = ['back', 'left', 'right'];
      let faces = collect(SIDES);
      if (!faces.length) {
        faces = collect(['front']);
        if (faces.length) warnings.push(`${o.name}: คอยล์ด้านหลัง/ข้างถูกบังทั้งหมด — ใช้ช่องด้านหน้าแทน`);
      }
      rec.blockedPct = potential ? 100 * (1 - Math.min(potential, faces.length) / potential) : 100;
      if (!faces.length) {
        rec.active = false;
        warnings.push(`${o.name}: คอยล์ถูกบังทั้งหมด — ไม่คำนวณโมดูลนี้`);
      } else if (rec.blockedPct > 25) {
        warnings.push(`${o.name}: หน้าคอยล์ถูกบัง ${rec.blockedPct.toFixed(0)}%`);
      }
      const vin = q / (faces.length * h * h);
      for (const f of faces) {
        // ความเร็วบวกตามแกน = ไหลไปทาง +x/+z
        if (f.di === 1) { rec.inAxis.push(0); rec.inFaces.push(f.id + 1); rec.inVel.push(-vin); }
        else if (f.di === -1) { rec.inAxis.push(0); rec.inFaces.push(f.id); rec.inVel.push(vin); }
        else if (f.dk === 1) { rec.inAxis.push(2); rec.inFaces.push(f.id + sz); rec.inVel.push(-vin); }
        else { rec.inAxis.push(2); rec.inFaces.push(f.id); rec.inVel.push(vin); }
        rec.inCells.push(f.nb);
      }
      rec.coilAreaGrid = faces.length * h * h;
      modules.push(rec);
      unit.modules.push(rec);
    });
  });

  // พลังงานของผนังทึบ/หน้ากริลต้องไม่ซ้อนกัน: หน้าคอยล์ที่ติดเซลล์ louver ยังใช้ได้ (อากาศผ่านได้)
  let fluid = 0, porous = 0;
  for (let id = 0; id < N; id++) if (type[id] === FLUID) { fluid++; if (kp[id] > 0) porous++; }

  const pack = modules.map(m => ({
    ...m,
    fanFaces: Int32Array.from(m.fanFaces), fanVel: Float32Array.from(m.fanVel),
    inAxis: Uint8Array.from(m.inAxis), inFaces: Int32Array.from(m.inFaces),
    inVel: Float32Array.from(m.inVel), inCells: Int32Array.from(m.inCells),
  }));

  return {
    dom, nx, ny, nz, h, ox, oz, NX, NY, NZ, N, sy, sz,
    type, kp, modules: pack,
    units: units.map(u => ({ id: u.id, name: u.name, model: u.model, modules: u.modules.map(m => modules.indexOf(m)) })),
    stats: { fluid, porous, solid: nx * ny * nz - fluid },
    warnings,
  };
}
