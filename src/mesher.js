/*
 * mesher.js — แปลงวัตถุในฉากเป็นกริดคำนวณ (voxel) และเงื่อนไขขอบของ CDU
 *
 * กริดเป็น rectilinear (เซลล์กว้างไม่เท่ากันได้ — ดู grid.js) เส้นกริดอยู่ใน xf/yf/zf
 * มีชั้นเซลล์เงา (ghost) ล้อมรอบหนึ่งชั้น: ดัชนี i = 0 และ i = nx+1 เป็นเงา
 *   ชนิดเซลล์: FLUID = อากาศ, SOLID = ของแข็ง, OPEN = ขอบเปิด (อากาศภายนอก)
 * ความเร็วเก็บแบบ staggered (MAC): u[c] คือหน้าด้าน −x ของเซลล์ c,
 *   v[c] หน้าด้าน −y, w[c] หน้าด้าน −z
 *
 * CDU แต่ละโมดูลกลายเป็น
 *   - กล่องทึบ (ตัวเครื่อง + ฐาน + Hood ถ้ามี)
 *   - หน้าพัดลม (ลมออก): หน้าเซลล์ที่กำหนดความเร็วคงที่ = อัตราลม / พื้นที่หน้าลมออก
 *       รุ่นเป่าขึ้น (VRV 6A)      : หน้า v ด้านบนเครื่อง หรือปากท่อ Hood ตรง
 *                                  Hood หัก 90° (ท่อโค้ง): ท่อขึ้นจากเครื่อง โค้งแล้วยื่นแนวนอนพ้นตัวเครื่องตามทิศที่เลือก
 *                                  ลมออกแนวนอนที่ปลายท่อ (หน้าตัดสูงเท่าความลึกเครื่อง ไม่เกินความสูง Hood)
 *       รุ่นเป่าหน้า (VRV IV S / S Hi / Split): หน้า u/w ด้านหน้าเครื่องตรงหน้ากากพัดลม หรือปลาย Hood ที่ยื่นออกไป
 *                                  ทิศทางลมร้อน (ใบเบี่ยงลมที่ติดกับเครื่อง) ไม่มีรูปทรงบนกริด: กำหนดความเร็วตามทิศเบี่ยง (d)
 *                                  ที่หน้าเซลล์ระหว่างเซลล์อากาศชั้นแรกหน้าปากลม ให้เท่ากับความเร็วพุ่ง (n)
 *                                  → ลมออกจากเครื่องมีทิศ (n + d)/√2 คือเอียง 45°
 *   - หน้าคอยล์ดูดลม: หน้าด้านข้างในช่วงความสูงของคอยล์ ความเร็วดูดเข้าคงที่
 *       รุ่นเป่าขึ้น: หลัง/ซ้าย/ขวา · รุ่นเป่าหน้า: หลัง/ซ้าย (ด้านขวาเป็นแผงบริการ)
 *   มวลอากาศเข้า = ออก ทุกโมดูล
 */

import { unitModules, unitSize, getModel, FAN_AREA, DEFLECT_DIRS, HOOD_DIRS, elbowOpen, elbowDir } from './models.js';
import { domainOf, cloneBC, slabRange, insideRect } from './scene.js';
import { cellIndex } from './grid.js';

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
  const { nx, ny, nz, h, ox, oz, xf, yf, zf } = dom;
  const NX = nx + 2, NY = ny + 2, NZ = nz + 2;
  const sy = NX, sz = NX * NY, N = NX * NY * NZ;
  const type = new Uint8Array(N);
  const kp = new Float32Array(N);                 // ค่าต้านการไหลของ louver ต่อหน่วยความยาว (1/m)
  const owner = new Int32Array(N).fill(-1);       // เซลล์ของแข็งเป็นของโมดูลใด
  const warnings = [];

  const X = i => 0.5 * (xf[i - 1] + xf[i]), Y = j => 0.5 * (yf[j - 1] + yf[j]), Z = k => 0.5 * (zf[k - 1] + zf[k]);
  const I = x => cellIndex(xf, x), J = y => cellIndex(yf, y), K = z => cellIndex(zf, z);
  // ความกว้างเซลล์ (ดัชนี 1..n) และความกว้างสูงสุดของเซลล์ที่ครอบช่วง [a, b] ของแต่ละแกน
  const DX = i => xf[i] - xf[i - 1], DY = j => yf[j] - yf[j - 1], DZ = k => zf[k] - zf[k - 1];
  const maxSize = (f, n, a, b) => {
    const i0 = Math.min(n, Math.max(1, cellIndex(f, a))), i1 = Math.min(n, Math.max(1, cellIndex(f, b)));
    let m = 0;
    for (let i = i0; i <= i1; i++) m = Math.max(m, f[i] - f[i - 1]);
    return m;
  };
  const ci = (a, lo, hi) => a < lo ? lo : a > hi ? hi : a;

  // ชั้นเงาตามชนิดขอบที่เลือก: ขอบเปิด = OPEN, ผนัง/สมมาตร = SOLID
  // (สมมาตรต่างจากผนังตรงที่ solver สะท้อนความเร็วแนวขนานเข้าไปในชั้นเงา → ผนังลื่น)
  const bc = cloneBC(scene.bc);
  const faceOf = (i, j, k) => j === 0 ? 'ymin' : j === NY - 1 ? 'ymax' : i === 0 ? 'xmin' : i === NX - 1 ? 'xmax' : k === 0 ? 'zmin' : 'zmax';
  for (let k = 0; k < NZ; k++)
    for (let j = 0; j < NY; j++)
      for (let i = 0; i < NX; i++) {
        if (i > 0 && i < NX - 1 && j > 0 && j < NY - 1 && k > 0 && k < NZ - 1) continue;
        type[i + j * sy + k * sz] = bc[faceOf(i, j, k)].type === 'open' ? OPEN : SOLID;
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

  // ── แผ่นพื้นยก / หลังคา ──
  // บางกว่าเซลล์ก็ยังได้อย่างน้อยหนึ่งชั้นเซลล์ (กันลมรั่วผ่านแผ่น)
  for (const o of scene.objects) {
    if (o.type !== 'slab') continue;
    const free = o.open ?? 0;
    if (free >= 100) continue;
    const { y0, y1 } = slabRange(o);
    const hl = maxSize(yf, ny, y0, y1);   // ความสูงเซลล์บริเวณแผ่น
    const yc = Math.max((y0 + y1) / 2, 0.5 * hl), hy = Math.max((y1 - y0) / 2, 0.5 * hl);
    const solid = free <= 0;
    const kk = solid ? 0 : louverK(free) / (2 * hy);
    const r = o.rot * Math.PI / 180, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
    const ex = (o.w * c + o.d * s) / 2, ez = (o.w * s + o.d * c) / 2;
    forBox(o.x - ex, o.x + ex, yc - hy, yc + hy, o.z - ez, o.z + ez, (i, j, k, x, y, z, id) => {
      if (y < yc - hy || y > yc + hy || !insideRect(o, x, z)) return;
      if (type[id] === SOLID) return;
      if (solid) { type[id] = SOLID; kp[id] = 0; }
      else kp[id] = Math.max(kp[id], kk);
    });
  }

  // ── ผนัง / louver ──
  for (const o of scene.objects) {
    if (o.type !== 'wall') continue;
    const dx = o.x2 - o.x1, dz = o.z2 - o.z1, L = Math.hypot(dx, dz);
    if (L < 1e-3 || o.height <= 0) continue;
    const tx = dx / L, tz = dz / L;
    // ความหนาอย่างน้อยพอให้ผนังทึบต่อเนื่องบนกริด แม้วางเฉียง (กันลมรั่วระหว่างเซลล์)
    const hn = maxSize(zf, nz, Math.min(o.z1, o.z2), Math.max(o.z1, o.z2)) * Math.abs(tx)
      + maxSize(xf, nx, Math.min(o.x1, o.x2), Math.max(o.x1, o.x2)) * Math.abs(tz);
    const ht = Math.max(o.thick / 2, 0.5 * hn);
    const free = o.louver ?? 0;
    if (free >= 100) continue;
    const solid = free <= 0;
    const k = solid ? 0 : louverK(free) / (2 * Math.max(hn, 2 * ht));
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
    const M = getModel(o.model);
    const front = M.discharge === 'front';
    const L = Math.max(0, o.duct || 0);   // Hood: ความสูง (เป่าขึ้น) หรือความยาวที่ยื่นออกด้านหน้า (เป่าหน้า)
    const rot = ((o.rot % 360) + 360) % 360;
    const r = rot * Math.PI / 180, c = Math.round(Math.cos(r)), s = Math.round(Math.sin(r));
    // local → world: (lx, lz) → (x + lx·c + lz·s, z − lx·s + lz·c)
    const toW = (lx, lz) => [o.x + lx * c + lz * s, o.z - lx * s + lz * c];
    const toL = (dx, dz) => [dx * c - dz * s, dx * s + dz * c];
    // ทิศในแกนเฉพาะ (lx, y, lz) → ทิศของดัชนีกริด (di, dj, dk)
    const dirW = (vx, vy, vz) => [vx * c + vz * s, vy, -vx * s + vz * c];
    const mods = unitModules(o);
    const hw = sz0.w / 2, hd = sz0.d / 2;
    const ex = Math.abs(hw * c) + Math.abs(hd * s), ez = Math.abs(hw * s) + Math.abs(hd * c);
    const yb = o.elev || 0, yt = yb + sz0.h;
    // ฐานเครื่องเริ่มจากผิวแผ่นพื้นที่รองรับ (ถ้าวางบนพื้นยก/หลังคา) ไม่เช่นนั้นเริ่มจากพื้นดิน
    let ySup = 0;
    for (const s of scene.objects)
      if (s.type === 'slab' && s.y <= yb + 1e-6 && insideRect(s, o.x, o.z)) ySup = Math.max(ySup, slabRange(s).y0);
    const gBase = modules.length;
    unitBoxes.push({ ui, gBase, n: mods.length });

    /** วนเซลล์ที่กึ่งกลางอยู่ในกล่องตามแกนเฉพาะของเครื่อง: fn(i, j, k, lx, y, lz, id) */
    const forLocal = (lx0, lx1, y0, y1, lz0, lz1, fn) => {
      const [ax, az] = toW(lx0, lz0), [bx, bz] = toW(lx1, lz1);
      forBox(Math.min(ax, bx), Math.max(ax, bx), y0, y1, Math.min(az, bz), Math.max(az, bz), (i, j, k, x, y, z, id) => {
        if (y < y0 || y > y1) return;
        const [lx, lz] = toL(x - o.x, z - o.z);
        if (lx < lx0 - 1e-9 || lx > lx1 + 1e-9 || lz < lz0 - 1e-9 || lz > lz1 + 1e-9) return;
        fn(i, j, k, lx, y, lz, id);
      });
    };
    /** หน้าเซลล์ลมออกจากเซลล์ทึบ id ไปทิศ (di, dj, dk) → [ดัชนีหน้า, แกน, เครื่องหมายความเร็ว, พื้นที่] */
    const outFace = (id, i, j, k, di, dj, dk) =>
      di === 1 ? [id + 1, 0, 1, DY(j) * DZ(k)] : di === -1 ? [id, 0, -1, DY(j) * DZ(k)]
        : dj === 1 ? [id + sy, 1, 1, DX(i) * DZ(k)] : dj === -1 ? [id, 1, -1, DX(i) * DZ(k)]
          : dk === 1 ? [id + sz, 2, 1, DX(i) * DY(j)] : [id, 2, -1, DX(i) * DY(j)];

    // ฐาน (ทึบ) และตัวเครื่อง — ทั้งชุดทึบรวมช่องว่างระหว่างโมดูล
    forBox(o.x - ex, o.x + ex, ySup, yt, o.z - ez, o.z + ez, (i, j, k, x, y, z, id) => {
      if (y > yt || y < ySup) return;
      const [lx, lz] = toL(x - o.x, z - o.z);
      if (Math.abs(lx) > hw || Math.abs(lz) > hd) return;
      type[id] = SOLID; kp[id] = 0;
      if (y >= yb) {
        let m = 0;
        for (let q = 0; q < mods.length; q++) if (lx >= mods[q].x0 - 0.02) m = q;
        owner[id] = gBase + m;
      }
    });

    // ── Hood: เซลล์ทึบของ Hood (ภายใน Hood แทนด้วยของแข็ง ลมออกที่ปลาย Hood) ──
    const hoodSet = new Set();
    const mark = (set) => (i, j, k, lx, y, lz, id) => {
      if (type[id] === SOLID) return;
      type[id] = SOLID; kp[id] = 0; set.add(id);
    };
    const F = M.fan;
    const dv = front && o.deflect && o.deflect !== 'none' ? DEFLECT_DIRS[o.deflect] : null;
    if (front && L > 0) {
      const fx = F.lx, yc = yb + F.y, hs = F.s / 2;
      forLocal(fx - hs, fx + hs, yc - hs, yc + hs, hd, hd + L, mark(hoodSet));
    }
    let elbow = null;
    if (!front && L > 0 && o.hoodType === 'elbow') {
      if (mods.length > 1 && (o.hoodDir === 'left' || o.hoodDir === 'right'))
        warnings.push(`${o.name}: Hood หัก 90° ไปด้านข้างใช้ได้กับโมดูลเดี่ยว — ใช้ทิศด้านหน้าแทน`);
      const [vx, vz] = HOOD_DIRS[elbowDir(o)];
      const eo = elbowOpen(o), out = Math.max(0, o.hoodOut || 0);
      const half = vx ? hw : hd, R = Math.min(eo, 2 * half), yTop = yt + L;
      // Hood ต่อเนื่องคลุมทั้งชุด แบ่งเขตของแต่ละโมดูลที่กึ่งกลางช่องว่างระหว่างโมดูล
      const sets = mods.map((md, mi) => {
        const set = new Set(), fill = mark(set);
        const a = mi === 0 ? -hw : (mods[mi - 1].x1 + md.x0) / 2, b = mi === mods.length - 1 ? hw : (md.x1 + mods[mi + 1].x0) / 2;
        forLocal(vx < 0 ? a - out : a, vx > 0 ? b + out : b, yt, yTop, vz < 0 ? -hd - out : -hd, vz > 0 ? hd + out : hd, (i, j, k, lx, y, lz, id) => {
          // t = ระยะตามทิศปากลมวัดจากขอบด้านตรงข้ามของตัวเครื่อง
          const t = (vx ? lx * vx : lz * vz) + half;
          if (t > 2 * half) { if (y < yTop - eo) return; }                 // ท่อช่วงแนวนอนที่ยื่นพ้นเครื่อง
          else if (t < R && y > yTop - R && (R - t) ** 2 + (y - (yTop - R)) ** 2 > R * R) return;   // มุมโค้งด้านหลังบน
          fill(i, j, k, lx, y, lz, id);
        });
        return set;
      });
      elbow = { sets, dir: dirW(vx, 0, vz), y0: yTop - eo, y1: yTop, span: vx ? sz0.d : 0, eo };
    }

    const unit = { id: o.id, name: o.name, model: o.model, modules: [] };
    units.push(unit);

    mods.forEach((md, mi) => {
      const g = gBase + mi;
      const q = md.cmm / 60;   // m³/s
      const rec = {
        unit: ui, unitId: o.id, index: mi, hp: md.hp, kw: md.kw, eer: md.eer, q,
        fanFaces: [], fanAxis: [], fanVel: [], fanCells: [], dirFaces: [], dirAxis: [], dirVel: [], inAxis: [], inFaces: [], inVel: [], inCells: [], inArea: [],
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

      /** ใส่รายการหน้าลมออก [{id, f: outFace(...)}] ด้วยความเร็วเท่ากันทุกหน้า ให้อัตราลมรวม = q */
      const setOutflow = (list) => {
        const area = list.reduce((a, e) => a + e.f[3], 0);
        if (!(area > 0)) return;
        const vel = q / area;
        for (const { id, f } of list) {
          rec.fanFaces.push(f[0]); rec.fanAxis.push(f[1]); rec.fanVel.push(f[2] * vel); rec.fanCells.push(id);
        }
        rec.fanAreaGrid += area;
      };

      if (front) {
        // ── พัดลมหน้าเครื่อง (+ Hood) ──
        const fx = F.lx, yc = yb + F.y, hs = F.s / 2, lzE = hd + L, pad = h;
        const nW = dirW(0, 0, 1), nOff = nW[0] + nW[2] * sz;
        const src = id => owner[id] === g || hoodSet.has(id);
        const nCand = [];
        forLocal(fx - hs - pad, fx + hs + pad, yc - hs - pad, yc + hs + pad, -hd, lzE + pad, (i, j, k, lx, y, lz, id) => {
          if (!src(id) || type[id + nOff] !== FLUID) return;
          nCand.push({ id, f: outFace(id, i, j, k, nW[0], 0, nW[2]), du: lx - fx, dv: y - yc });
        });
        nCand.sort((a, b) => Math.hypot(a.du, a.dv) - Math.hypot(b.du, b.dv));
        let nList = L > 0 ? nCand.filter(e => Math.abs(e.du) <= hs + 1e-6 && Math.abs(e.dv) <= hs + 1e-6) : [];
        if (!nList.length) {
          // หน้ากากพัดลมกลม (หรือกริดหยาบกว่าปลาย Hood): เลือกหน้าที่ใกล้ศูนย์กลางจนพื้นที่ใกล้เคียงช่องลมออก
          const want = L > 0 ? F.s * F.s : Math.PI * F.dia * F.dia / 4;
          let a = 0;
          for (const e of nCand) { if (nList.length && a + e.f[3] / 2 > want) break; nList.push(e); a += e.f[3]; }
        }
        setOutflow(nList);
        rec.fanAreaReal = L > 0 ? F.s * F.s : Math.PI * F.dia * F.dia / 4;
        if (!rec.fanFaces.length) {
          rec.active = false;
          warnings.push(`${o.name}: ด้านหน้าพัดลม${L > 0 ? '/ปลาย Hood' : ''}ถูกปิดทึบ — ไม่คำนวณโมดูลนี้`);
        } else if (dv) {
          // ทิศทางลมร้อนเบี่ยง 45°: กำหนดความเร็วตามทิศเบี่ยง = ความเร็วพุ่ง ที่หน้าเซลล์ระหว่างเซลล์อากาศชั้นแรกหน้าปากลม
          const dW = dirW(dv[0], dv[1], 0), dOff = dW[0] + dW[1] * sy + dW[2] * sz;
          const ax = dW[0] ? 0 : dW[1] ? 1 : 2, sign = dW[0] + dW[1] + dW[2];
          const vel = Math.abs(rec.fanVel[0]);
          const layer = new Set(nList.map(e => e.id + nOff));
          for (const c of layer) {
            const c2 = c + dOff;
            if (!layer.has(c2) || type[c2] !== FLUID) continue;
            rec.dirFaces.push(sign > 0 ? c2 : c); rec.dirAxis.push(ax); rec.dirVel.push(sign * vel);
          }
          if (!rec.dirFaces.length) warnings.push(`${o.name}: ปากลมกว้างเพียงเซลล์เดียว — กำหนดทิศทางลมร้อนไม่ได้ ลมออกตรง (ลดขนาดเซลล์)`);
        }
      } else if (elbow) {
        // ── Hood หัก 90°: ลมออกแนวนอนจากช่วงบนสุดของ Hood ──
        const [di, , dk] = elbow.dir, list = [];
        for (const id of elbow.sets[mi]) {
          const j = ((id / sy) | 0) % NY, y = Y(j);
          if (y < elbow.y0 || y > elbow.y1) continue;
          if (type[id + di + dk * sz] !== FLUID) continue;
          const i = id % sy, k = (id / sz) | 0;
          list.push({ id, f: outFace(id, i, j, k, di, 0, dk) });
        }
        setOutflow(list);
        rec.fanAreaReal = (elbow.span || md.w) * elbow.eo;
        if (!rec.fanFaces.length) {
          rec.active = false;
          warnings.push(`${o.name}: ปากลม Hood หัก 90° ถูกปิดทึบหรือเล็กกว่าเซลล์ — ไม่คำนวณโมดูลนี้`);
        }
      } else {
        // ── พัดลมด้านบน ──
        const aCol = DX(Math.min(nx, Math.max(1, I(o.x)))) * DZ(Math.min(nz, Math.max(1, K(o.z))));   // พื้นที่หน้าเซลล์บริเวณเครื่อง
        const nWant = Math.max(1, Math.round(FAN_AREA / aCol));
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
          let area = 0;
          for (const cc of pick) {
            used.add(cc.i + cc.k * 100000);
            let jt = cc.j;
            // Hood ตรง (ท่อเป่าลม): ต่อเซลล์ทึบขึ้นไปจนถึงปากท่อ แล้วย้ายหน้าพัดลมไปไว้ที่ปากท่อ
            if (L > 0) {
              const top = yt + L;
              while (jt + 1 <= ny && Y(jt + 1) <= top) { jt++; type[cc.i + jt * sy + cc.k * sz] = SOLID; }
            }
            const above = cc.i + (jt + 1) * sy + cc.k * sz;
            if (jt + 1 > ny || type[above] === SOLID) continue;
            faces.push(above);   // v[above] = หน้าด้านล่างของเซลล์เหนือพัดลม
            area += DX(cc.i) * DZ(cc.k);
          }
          if (!faces.length) continue;
          const vel = qFan / area;
          // fanCells = เซลล์ทึบใต้หน้าพัดลม: solver เก็บอุณหภูมิลมเป่าไว้ที่นี่ (ค่าต้นลมของหน้าพัดลม)
          for (const f of faces) { rec.fanFaces.push(f); rec.fanAxis.push(1); rec.fanVel.push(vel); rec.fanCells.push(f - sy); }
          rec.fanAreaGrid += area;
          rec.fanQ = (rec.fanQ || 0) + vel * area;
        }
        if (!rec.fanFaces.length) {
          rec.active = false;
          warnings.push(`${o.name}: ด้านบนพัดลมถูกปิดทึบ — ไม่คำนวณโมดูลนี้`);
        }
        // ถ้าบางใบพัดหาหน้าไม่ได้ ให้อัตราลมรวมยังถูกต้อง
        const fanQ = rec.fanQ || 0;
        delete rec.fanQ;
        if (fanQ > 0 && Math.abs(fanQ - q) > 1e-6) rec.fanVel = rec.fanVel.map(v => v * q / fanQ);
      }

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
            out.push({ id, nb, di, dk, area: DY(j) * (di ? DZ(k) : DX(i)) });
          }
        });
        return out;
      };
      const SIDES = front ? ['back', 'left'] : ['back', 'left', 'right'];
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
      const coilArea = faces.reduce((a, f) => a + f.area, 0);
      const vin = q / coilArea;
      for (const f of faces) {
        // ความเร็วบวกตามแกน = ไหลไปทาง +x/+z
        if (f.di === 1) { rec.inAxis.push(0); rec.inFaces.push(f.id + 1); rec.inVel.push(-vin); }
        else if (f.di === -1) { rec.inAxis.push(0); rec.inFaces.push(f.id); rec.inVel.push(vin); }
        else if (f.dk === 1) { rec.inAxis.push(2); rec.inFaces.push(f.id + sz); rec.inVel.push(-vin); }
        else { rec.inAxis.push(2); rec.inFaces.push(f.id); rec.inVel.push(vin); }
        rec.inCells.push(f.nb);
        rec.inArea.push(f.area);
      }
      rec.coilAreaGrid = coilArea;
      modules.push(rec);
      unit.modules.push(rec);
    });
  });

  // พลังงานของผนังทึบ/หน้ากริลต้องไม่ซ้อนกัน: หน้าคอยล์ที่ติดเซลล์ louver ยังใช้ได้ (อากาศผ่านได้)
  let fluid = 0, porous = 0;
  for (let id = 0; id < N; id++) if (type[id] === FLUID) { fluid++; if (kp[id] > 0) porous++; }

  const pack = modules.map(m => ({
    ...m,
    fanFaces: Int32Array.from(m.fanFaces), fanAxis: Uint8Array.from(m.fanAxis), fanVel: Float32Array.from(m.fanVel),
    dirFaces: Int32Array.from(m.dirFaces), dirAxis: Uint8Array.from(m.dirAxis), dirVel: Float32Array.from(m.dirVel),
    inAxis: Uint8Array.from(m.inAxis), inFaces: Int32Array.from(m.inFaces),
    inVel: Float32Array.from(m.inVel), inCells: Int32Array.from(m.inCells),
    fanCells: Int32Array.from(m.fanCells), inArea: Float32Array.from(m.inArea),
  }));

  return {
    dom, nx, ny, nz, h, ox, oz, NX, NY, NZ, N, sy, sz, bc,
    xf, yf, zf, graded: dom.graded, hMax: dom.hMax,
    type, kp, modules: pack,
    units: units.map(u => ({ id: u.id, name: u.name, model: u.model, modules: u.modules.map(m => modules.indexOf(m)) })),
    stats: { fluid, porous, solid: nx * ny * nz - fluid },
    warnings,
  };
}
