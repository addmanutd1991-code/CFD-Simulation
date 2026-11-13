/*
 * prep.js — การเตรียมกริดที่ solver ทุกแบบใช้ร่วมกัน (CPU/WebAssembly และ GPU/WebGPU)
 *
 *   axisTables   ตารางระยะและสัมประสิทธิ์หนึ่งมิติของแต่ละแกน (กริดเซลล์กว้างไม่เท่ากัน)
 *   GridPrep     จำแนกหน้าที่ถูกกำหนดความเร็ว (ผนัง ขอบ ลมเข้า พัดลม/คอยล์ของ CDU), รายการหน้า louver,
 *                คู่เซลล์ของขอบสมมาตร, หน้าอิสระและสัมประสิทธิ์ของสมการ Poisson
 *
 * ผลลัพธ์เป็น typed array ธรรมดา — solver แต่ละแบบคัดลอกไปไว้ในหน่วยความจำของตัวเอง
 */

export const FLUID = 0, SOLID = 1, OPEN = 2;

/* ลำดับตารางต้องตรงกับ enum AX_* ใน kernels.c และค่าคงที่ใน gpu-solver.js */
export const AXT = { F: 0, C: 1, D: 2, RD: 3, RDC: 4, WF: 5, PM: 6, PP: 7, FM: 8, FP: 9, R2: 10, Q23: 11, RD2: 12, CB: 13, COUNT: 14 };

/** ตารางระยะและสัมประสิทธิ์ของหนึ่งแกน จากพิกัดหน้าเซลล์ f[0..n] (n เซลล์ภายใน) */
export function axisTables(f) {
  const n = f.length - 1, NA = n + 2, L = NA + 2;
  const t = new Float64Array(AXT.COUNT * L);
  const at = (q, i) => q * L + i;
  const F = i => t[at(AXT.F, i)], d = i => t[at(AXT.D, i)], rd = i => t[at(AXT.RD, i)], C = i => t[at(AXT.C, i)], rdc = i => t[at(AXT.RDC, i)];
  for (let i = 1; i <= n + 1; i++) t[at(AXT.F, i)] = f[i - 1];
  t[at(AXT.F, 0)] = f[0] - (f[1] - f[0]);
  t[at(AXT.F, NA)] = f[n] + (f[n] - f[n - 1]);
  for (let i = 0; i < NA; i++) {
    const w = F(i + 1) - F(i);
    t[at(AXT.D, i)] = w; t[at(AXT.RD, i)] = 1 / w; t[at(AXT.C, i)] = 0.5 * (F(i) + F(i + 1));
    t[at(AXT.Q23, i)] = Math.cbrt(w) ** 2; t[at(AXT.RD2, i)] = 1 / (w * w); t[at(AXT.CB, i)] = Math.cbrt(w);
  }
  t[at(AXT.RDC, 0)] = rd(0); t[at(AXT.RDC, NA)] = rd(NA - 1);
  for (let i = 1; i < NA; i++) t[at(AXT.RDC, i)] = 1 / (C(i) - C(i - 1));
  t[at(AXT.WF, 0)] = 0.5;
  for (let i = 0; i < NA; i++) {
    if (i >= 1) {
      t[at(AXT.WF, i)] = 0.5 * d(i - 1) * rdc(i);
      t[at(AXT.FM, i)] = rdc(i) * rd(i - 1); t[at(AXT.FP, i)] = rdc(i) * rd(i);
    }
    t[at(AXT.PM, i)] = rd(i) * rdc(i); t[at(AXT.PP, i)] = rd(i) * rdc(i + 1);
    if (i >= 1 && i <= NA - 2) t[at(AXT.R2, i)] = 1 / (C(i + 1) - C(i - 1));
  }
  return { t, L, NA };
}

export class GridPrep {
  /** wind = { speed, wx, wz } (m/s) — ความเร็วลมธรรมชาติที่ขอบต้นลม */
  constructor(mesh, wind) {
    Object.assign(this, {
      nx: mesh.nx, ny: mesh.ny, nz: mesh.nz, NX: mesh.NX, NY: mesh.NY, NZ: mesh.NZ, N: mesh.N, sy: mesh.sy, sz: mesh.sz,
    });
    this.type = mesh.type; this.kp = mesh.kp; this.mods = mesh.modules;
    this.windSpeed = wind.speed; this.wx = wind.wx; this.wz = wind.wz;
    this.axes = [mesh.xf, mesh.yf, mesh.zf].map(axisTables);
    this.fx = new Uint8Array(this.N);      // บิต 1/2/4 = หน้า u/v/w ด้านลบของเซลล์ถูกกำหนดความเร็ว
    this.pm = new Uint8Array(this.N);      // บิตของหน้าอิสระหกด้านของเซลล์อากาศ
    this.idg = new Float32Array(this.N);   // 1 / Σ สัมประสิทธิ์ของหน้าอิสระ
    this.classifyFaces();
    this.buildPorous();
    this.buildMirror(mesh.bc);
    this.buildProjection();
  }

  windAt(y) {
    // ลมเข้าแบบสม่ำเสมอ: ความเร็วเท่ากันทุกระดับความสูงทั่วทั้งระนาบขอบต้นลม
    return 1;
  }

  /** ตารางของแกน a (0 = x, 1 = y, 2 = z) ชนิด q ที่ดัชนี i */
  ax(a, q, i) { const A = this.axes[a]; return A.t[q * A.L + i]; }

  classifyFaces() {
    const { NX, NY, NZ, N, sy, sz, type, nx, nz, fx } = this;
    const fixU = new Uint8Array(N), fixV = new Uint8Array(N), fixW = new Uint8Array(N);
    const uF = new Float32Array(N), vF = new Float32Array(N), wF = new Float32Array(N);
    const wind = this.windSpeed > 0.01;
    for (let k = 0; k < NZ; k++)
      for (let j = 0; j < NY; j++)
        for (let i = 0; i < NX; i++) {
          const c = i + j * sy + k * sz, tc = type[c];
          const prof = this.windAt(this.ax(1, AXT.C, j));
          // หน้า u (ระหว่าง c-1 กับ c)
          if (i === 0) fixU[c] = 1;
          else {
            const ta = type[c - 1];
            if (ta === SOLID || tc === SOLID) { fixU[c] = 1; uF[c] = 0; }
            else if (ta === OPEN && tc === OPEN) { fixU[c] = 1; uF[c] = wind ? this.wx * prof : 0; }
            else if (wind && ((i === 1 && this.wx > 0) || (i === nx + 1 && this.wx < 0))) { fixU[c] = 1; uF[c] = this.wx * prof; }
          }
          // หน้า v
          if (j === 0) fixV[c] = 1;
          else {
            const ta = type[c - sy];
            if (ta === SOLID || tc === SOLID) { fixV[c] = 1; vF[c] = 0; }
            else if (ta === OPEN && tc === OPEN) { fixV[c] = 1; vF[c] = 0; }
          }
          // หน้า w
          if (k === 0) fixW[c] = 1;
          else {
            const ta = type[c - sz];
            if (ta === SOLID || tc === SOLID) { fixW[c] = 1; wF[c] = 0; }
            else if (ta === OPEN && tc === OPEN) { fixW[c] = 1; wF[c] = wind ? this.wz * prof : 0; }
            else if (wind && ((k === 1 && this.wz > 0) || (k === nz + 1 && this.wz < 0))) { fixW[c] = 1; wF[c] = this.wz * prof; }
          }
        }

    // หน้าพัดลมและหน้าคอยล์ของ CDU
    let fanRate = 0, fanVmax = 0;
    for (const m of this.mods) {
      if (!m.active) continue;
      // หน้าลมออก: แกน 1 = หน้า v (เป่าขึ้น/ลง), 0 = หน้า u, 2 = หน้า w (เป่าออกด้านข้าง / Hood หัก 90°)
      for (let a = 0; a < m.fanFaces.length; a++) {
        const f = m.fanFaces[a], ax = m.fanAxis ? m.fanAxis[a] : 1, vel = m.fanVel[a], sp = Math.abs(vel);
        const idx = ax === 0 ? f % sy : ax === 1 ? ((f / sy) | 0) % NY : (f / sz) | 0;
        if (ax === 0) { fixU[f] = 1; uF[f] = vel; }
        else if (ax === 1) { fixV[f] = 1; vF[f] = vel; }
        else { fixW[f] = 1; wF[f] = vel; }
        fanVmax = Math.max(fanVmax, sp);
        fanRate = Math.max(fanRate, sp * this.ax(ax, AXT.RD, idx));
      }
      // ทิศทางลมร้อนของรุ่นเป่าหน้า: ความเร็วตามทิศเบี่ยงที่หน้าเซลล์ระหว่างเซลล์อากาศชั้นแรกหน้าปากลม
      for (let a = 0; a < (m.dirFaces ? m.dirFaces.length : 0); a++) {
        const f = m.dirFaces[a], ax = m.dirAxis[a], vel = m.dirVel[a];
        if (ax === 0) { fixU[f] = 1; uF[f] = vel; }
        else if (ax === 1) { fixV[f] = 1; vF[f] = vel; }
        else { fixW[f] = 1; wF[f] = vel; }
      }
      for (let a = 0; a < m.inFaces.length; a++) {
        const f = m.inFaces[a];
        if (m.inAxis[a] === 0) { fixU[f] = 1; uF[f] = m.inVel[a]; }
        else { fixW[f] = 1; wF[f] = m.inVel[a]; }
      }
    }
    this.fanRate = fanRate; this.fanVmax = fanVmax;

    // รายการหน้าที่ถูกกำหนดความเร็ว (ดัชนี + ค่า) — ไม่ต้องเก็บอาร์เรย์เต็มกริดและไม่ต้องไล่ทั้งกริดทุกสเต็ป
    const list = (fix, val) => {
      let n = 0;
      for (let c = 0; c < N; c++) n += fix[c];
      const idx = new Int32Array(n), v = new Float32Array(n);
      n = 0;
      for (let c = 0; c < N; c++) if (fix[c]) { idx[n] = c; v[n++] = val[c]; }
      return { idx, val: v };
    };
    this.fixList = { u: list(fixU, uF), v: list(fixV, vF), w: list(fixW, wF) };
    for (let c = 0; c < N; c++) fx[c] = fixU[c] | (fixV[c] << 1) | (fixW[c] << 2);
  }

  /** หน้าที่อยู่ใน louver (k > 0) พร้อมสัมประสิทธิ์ของแต่ละแกน */
  buildPorous() {
    const { N, sy, sz, kp } = this;
    const idx = [], ku = [], kv = [], kw = [];
    for (let c = sz; c < N; c++) {
      const kc = kp[c];
      const ka = 0.5 * (kc + kp[c - 1]), kb = 0.5 * (kc + kp[c - sy]), kz = 0.5 * (kc + kp[c - sz]);
      if (ka > 0 || kb > 0 || kz > 0) { idx.push(c); ku.push(ka); kv.push(kb); kw.push(kz); }
    }
    this.porous = { idx: Int32Array.from(idx), ku: Float64Array.from(ku), kv: Float64Array.from(kv), kw: Float64Array.from(kw) };
  }

  /**
   * ขอบสมมาตร (ผนังลื่น): ความเร็วตั้งฉากเป็นศูนย์ (หน้าติดเซลล์ทึบอยู่แล้ว) และความเร็วแนวขนาน
   * ในชั้นเงาเท่ากับชั้นในสุด — ไม่มีแรงเฉือนที่ขอบ ต่างจากผนังซึ่งชั้นเงามีความเร็วศูนย์
   */
  buildMirror(bc) {
    const { NX, NY, NZ, sy, sz } = this;
    const pairs = { u: [], v: [], w: [] };
    const add = (arrs, ghost, inner) => { for (const a of arrs) pairs[a].push(ghost, inner); };
    const sym = f => bc && bc[f] && bc[f].type === 'symmetry';
    for (let k = 0; k < NZ; k++)
      for (let j = 0; j < NY; j++) {
        if (sym('xmin')) add(['v', 'w'], j * sy + k * sz, 1 + j * sy + k * sz);
        if (sym('xmax')) add(['v', 'w'], NX - 1 + j * sy + k * sz, NX - 2 + j * sy + k * sz);
      }
    for (let j = 0; j < NY; j++)
      for (let i = 0; i < NX; i++) {
        if (sym('zmin')) add(['u', 'v'], i + j * sy, i + j * sy + sz);
        if (sym('zmax')) add(['u', 'v'], i + j * sy + (NZ - 1) * sz, i + j * sy + (NZ - 2) * sz);
      }
    for (let k = 0; k < NZ; k++)
      for (let i = 0; i < NX; i++) {
        if (sym('ymin')) add(['u', 'w'], i + k * sz, i + sy + k * sz);
        if (sym('ymax')) add(['u', 'w'], i + (NY - 1) * sy + k * sz, i + (NY - 2) * sy + k * sz);
      }
    this.mirror = { u: Int32Array.from(pairs.u), v: Int32Array.from(pairs.v), w: Int32Array.from(pairs.w) };
  }

  /** หน้าอิสระของแต่ละเซลล์อากาศ (pm) และส่วนกลับของผลรวมสัมประสิทธิ์ (idg) สำหรับ SOR */
  buildProjection() {
    const { NX, NY, NZ, type, sy, sz, fx, pm, idg } = this;
    let nFluid = 0;
    for (let k = 1; k < NZ - 1; k++) {
      const zm = this.ax(2, AXT.PM, k), zp = this.ax(2, AXT.PP, k);
      for (let j = 1; j < NY - 1; j++) {
        const ym = this.ax(1, AXT.PM, j), yp = this.ax(1, AXT.PP, j);
        for (let i = 1; i < NX - 1; i++) {
          const c = i + j * sy + k * sz;
          if (type[c] !== FLUID) continue;
          nFluid++;
          let m = 0, s = 0;
          if (!(fx[c] & 1)) { m |= 1; s += this.ax(0, AXT.PM, i); }
          if (!(fx[c + 1] & 1)) { m |= 2; s += this.ax(0, AXT.PP, i); }
          if (!(fx[c] & 2)) { m |= 4; s += ym; }
          if (!(fx[c + sy] & 2)) { m |= 8; s += yp; }
          if (!(fx[c] & 4)) { m |= 16; s += zm; }
          if (!(fx[c + sz] & 4)) { m |= 32; s += zp; }
          pm[c] = m;
          idg[c] = m ? 1 / s : 0;
        }
      }
    }
    this.nFluid = nFluid;
    const L = Math.max(this.nx, this.ny, this.nz);
    this.omega = Math.min(1.92, Math.max(1.6, 2 / (1 + Math.sin(Math.PI / L))));
  }
}
