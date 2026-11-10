/*
 * solver.js — เครื่องคำนวณ CFD สามมิติสำหรับลมร้อนจากคอยล์ร้อน
 *
 * สมการ: Navier–Stokes แบบอัดตัวไม่ได้ + Boussinesq + สมการพลังงาน + สารติดตาม (tracer)
 * กริด: rectilinear แบบ staggered (MAC) เซลล์กว้างไม่เท่ากันได้ (ดู grid.js)
 *       ความเร็วอยู่บนหน้าเซลล์ ความดัน/อุณหภูมิอยู่กลางเซลล์
 *
 *   ความเร็ว     : Semi-Lagrangian (เสถียรที่ CFL > 1) + ความหนืดปั่นป่วน Smagorinsky
 *   ความดัน      : Projection, สมการ Poisson แก้ด้วย Red–Black SOR แบบ warm start
 *   อุณหภูมิ/tracer: Finite volume แบบอนุรักษ์ MUSCL (van Leer) — พลังงานเข้า = ออก ตรงตามจริง
 *   CDU          : หน้าพัดลม/หน้าคอยล์กำหนดความเร็ว, อุณหภูมิลมเป่าคำนวณจากลมเข้า + ความร้อนทิ้ง
 *                  ซึ่งขึ้นกับอุณหภูมิลมเข้าเอง (ป้อนกลับทุกสเต็ป)
 *
 * ลูปหนักทั้งหมด (advection, turbulence, diffusion, projection, transport, residual) อยู่ใน
 * src/kernels.c (WebAssembly, แบ่งงานตามชั้น k ให้หลายเธรดเมื่อใช้ได้) ไฟล์นี้เป็นตัวจัดลำดับงาน
 * เงื่อนไขขอบ และการติดตามผล
 *
 * ไม่มีการอ้างถึง DOM — ใช้ได้ทั้งใน Web Worker และ main thread
 */

import { modulePerf, airRho, AIR_CP, DEFAULT_PERF } from './models.js';
import { createKernels, ALIGN_SLACK } from './kernels.js';

export const FLUID = 0, SOLID = 1, OPEN = 2;
const G = 9.81;
const CS = 0.17;        // ค่าคงที่ Smagorinsky
const NU_MIN = 2e-3;    // m²/s — ความปั่นป่วนพื้นหลังของอากาศภายนอก
const PR_T = 0.85;      // Turbulent Prandtl number
const CFL_VEL = 1.5;    // Semi-Lagrangian ยอม CFL > 1
const CFL_SCALAR = 0.5;    // ต่อผลรวมความเร็วไหลออกของเซลล์ (MUSCL + Euler)
const SAMPLE_DT = 0.5;  // s — ระยะเก็บประวัติผล

/** เกณฑ์ลู่เข้า — ต้องผ่านทุกข้อต่อเนื่องกัน HOLD ครั้ง (ครั้งละ SAMPLE_DT) */
export const CONV = {
  tMin: 60,          // s — เวลาขั้นต่ำก่อนเริ่มตัดสิน (ให้ลมร้อนเดินทางทั่วโดเมน)
  drift: 0.05,       // K — ค่าเฉลี่ย 10 s ล่าสุดของ T ลมเข้าเทียบ 10 s ก่อนหน้า
  balLo: 0.95, balHi: 1.05,
  mass: 0.01,        // RMS(∇·u)·L / u_max หลัง projection (L = ขนาดเซลล์)
  hold: 6,
};

/* ลำดับช่องต้องตรงกับ struct Ctx, enum AX_*, และ enum P_* ใน kernels.c */
const CTX = ['nx', 'ny', 'nz', 'NX', 'NY', 'NZ', 'sy', 'sz', 'N', 'nthreads',
  'u', 'v', 'w', 'u0', 'v0', 'w0', 'T', 'T0', 'C', 'C0', 'phi', 'rhs', 'nut', 'idg',
  'pu', 'pv', 'pw', 'pT', 'type', 'fx', 'pm', 'axx', 'axy', 'axz', 'red', 'scratch', 'par'];
const SLOT = Object.fromEntries(CTX.map((n, i) => [n, i]));
const AXT = { F: 0, C: 1, D: 2, RD: 3, RDC: 4, WF: 5, PM: 6, PP: 7, FM: 8, FP: 9, R2: 10, Q23: 11, RD2: 12, CB: 13, COUNT: 14 };
const PAR = Object.fromEntries(['DT', 'KB', 'AMB', 'CS2', 'NUMIN', 'OMEGA', 'KA',
  'MAXU', 'MAXV', 'MAXW', 'RATE', 'OUT', 'E2', 'QOUT', 'DE', 'DU2', 'DT2'].map((n, i) => [n, i]));
const RED = 8;
const SWAP = ['u', 'v', 'w', 'u0', 'v0', 'w0', 'T', 'T0', 'C', 'C0'];
const F32 = ['u', 'v', 'w', 'u0', 'v0', 'w0', 'T', 'T0', 'C', 'C0', 'phi', 'rhs', 'nut', 'idg', 'pu', 'pv', 'pw', 'pT'];

/** ตารางระยะและสัมประสิทธิ์ของหนึ่งแกน จากพิกัดหน้าเซลล์ f[0..n] (n เซลล์ภายใน) */
function axisTables(f) {
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

export class Solver {
  constructor(mesh, params) {
    Object.assign(this, {
      nx: mesh.nx, ny: mesh.ny, nz: mesh.nz, h: mesh.h,
      NX: mesh.NX, NY: mesh.NY, NZ: mesh.NZ, N: mesh.N, sy: mesh.sy, sz: mesh.sz,
      ox: mesh.ox, oz: mesh.oz,
    });
    this.kp = mesh.kp;
    this.mods = mesh.modules;
    this.units = mesh.units;
    this.amb = params.ambient;
    this.perf = { ...DEFAULT_PERF, ...(params.perf || {}) };
    this.windSpeed = params.windSpeed || 0;
    const wr = (params.windDir || 0) * Math.PI / 180;
    // ทิศลมแบบอุตุนิยมวิทยา: "พัดมาจาก" — 0° = จากทิศเหนือ (−z) พัดไปทาง +z
    this.wx = -Math.sin(wr) * this.windSpeed;
    this.wz = Math.cos(wr) * this.windSpeed;
    this.tMax = params.tMax || 1800;   // เพดานกันไม่จบ — ปกติหยุดเมื่อผลลู่เข้า
    this.rho = airRho(this.amb);
    this.cp = AIR_CP;
    this.beta = 1 / (this.amb + 273.15);

    // อาร์เรย์ทั้งหมดอยู่ใน linear memory ของ WebAssembly (params.kernels มาจาก createKernelsAsync ใน
    // engine.js — อาจเป็นแบบหลายเธรด; ถ้าไม่ส่งมาจะสร้างแบบเธรดเดียวที่นี่)
    const N = this.N;
    this.k = params.kernels || createKernels(Solver.memoryBytes(mesh, 1));
    if (!this.k) throw new Error('เบราว์เซอร์นี้ใช้ WebAssembly ไม่ได้ — ไม่สามารถคำนวณได้');
    this.threads = this.k.threads || 1;
    const A = (T, n) => this.k.alloc(T, n);
    for (const n of F32) this[n] = A(Float32Array, N);
    this.type = A(Uint8Array, N); this.type.set(mesh.type);
    this.fx = A(Uint8Array, N);      // บิต 1/2/4 = หน้า u/v/w ด้านลบของเซลล์ถูกกำหนดความเร็ว
    this.pm = A(Uint8Array, N);      // บิตของหน้าอิสระหกด้านของเซลล์อากาศ (ใช้ใน projection)
    this.red = A(Float64Array, this.NZ * RED);
    this.scratch = A(Float64Array, this.threads * (2 * this.NX * this.NY + 2 * this.NX));
    this.par = A(Float64Array, 32);
    this.axes = [mesh.xf, mesh.yf, mesh.zf].map(f => {
      const a = axisTables(f);
      const m = A(Float64Array, a.t.length);
      m.set(a.t);
      return { ...a, t: m };
    });
    this.ctx = new Int32Array(this.k.memory.buffer, this.k.ex.ctx(), CTX.length);
    for (const n of ['nx', 'ny', 'nz', 'NX', 'NY', 'NZ', 'sy', 'sz', 'N']) this.ctx[SLOT[n]] = this[n];
    this.ctx[SLOT.nthreads] = this.threads;
    for (const n of [...F32, 'type', 'fx', 'pm', 'red', 'scratch', 'par']) this.ctx[SLOT[n]] = this[n].byteOffset;
    ['axx', 'axy', 'axz'].forEach((n, a) => { this.ctx[SLOT[n]] = this.axes[a].t.byteOffset; });
    this.par[PAR.AMB] = this.amb; this.par[PAR.CS2] = CS * CS; this.par[PAR.NUMIN] = NU_MIN; this.par[PAR.KA] = 0.5 / PR_T;

    this.#classifyFaces();
    this.#buildPorous();
    this.#buildMirror(mesh.bc);
    this.#buildProjection();
    this.reset();
  }

  /** ขนาดหน่วยความจำ (ไบต์) ที่ต้องจองให้ WebAssembly สำหรับกริดนี้ */
  static memoryBytes(mesh, threads = 1) {
    const N = mesh.N, NX = mesh.nx + 2, NY = mesh.ny + 2, NZ = mesh.nz + 2;
    // 18 Float32 + 3 Uint8 ต่อเซลล์ + ตารางต่อแกน + ผลรวมต่อชั้น + บัฟเฟอร์ฟลักซ์ต่อเธรด
    return N * (F32.length * 4 + 3) + AXT.COUNT * (NX + NY + NZ + 12) * 8 + NZ * RED * 8
      + threads * (2 * NX * NY + 2 * NX) * 8 + 32 * 8 + 40 * ALIGN_SLACK;
  }

  /** ไบต์ต่อเซลล์โดยประมาณ (ใช้ประเมินหน่วยความจำใน UI) */
  static get bytesPerCell() { return F32.length * 4 + 3; }

  dispose() { this.k?.dispose?.(); }

  /* ───────── การเตรียมกริด ───────── */

  windAt(y) {
    // ลมเข้าแบบสม่ำเสมอ: ความเร็วเท่ากันทุกระดับความสูงทั่วทั้งระนาบขอบต้นลม
    return 1;
  }

  /** ตารางของแกน a (0 = x, 1 = y, 2 = z) ชนิด q ที่ดัชนี i */
  #ax(a, q, i) { const A = this.axes[a]; return A.t[q * A.L + i]; }

  #classifyFaces() {
    const { NX, NY, NZ, N, sy, sz, type, nx, nz, fx } = this;
    const fixU = new Uint8Array(N), fixV = new Uint8Array(N), fixW = new Uint8Array(N);
    const uF = new Float32Array(N), vF = new Float32Array(N), wF = new Float32Array(N);
    const wind = this.windSpeed > 0.01;
    for (let k = 0; k < NZ; k++)
      for (let j = 0; j < NY; j++)
        for (let i = 0; i < NX; i++) {
          const c = i + j * sy + k * sz, tc = type[c];
          const prof = this.windAt(this.#ax(1, AXT.C, j));
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
      for (let a = 0; a < m.fanFaces.length; a++) {
        const f = m.fanFaces[a], j = ((f / sy) | 0) % NY;
        fixV[f] = 1; vF[f] = m.fanVel[a];
        fanVmax = Math.max(fanVmax, m.fanVel[a]);
        fanRate = Math.max(fanRate, m.fanVel[a] * this.#ax(1, AXT.RD, j));
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
  #buildPorous() {
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
  #buildMirror(bc) {
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

  #applyMirror() {
    for (const a of ['u', 'v', 'w']) {
      const m = this.mirror[a], f = this[a];
      for (let q = 0; q < m.length; q += 2) f[m[q]] = f[m[q + 1]];
    }
  }

  /** หน้าอิสระของแต่ละเซลล์อากาศ (pm) และส่วนกลับของผลรวมสัมประสิทธิ์ (idg) สำหรับ SOR */
  #buildProjection() {
    const { NX, NY, NZ, type, sy, sz, fx, pm, idg } = this;
    let nFluid = 0;
    for (let k = 1; k < NZ - 1; k++) {
      const zm = this.#ax(2, AXT.PM, k), zp = this.#ax(2, AXT.PP, k);
      for (let j = 1; j < NY - 1; j++) {
        const ym = this.#ax(1, AXT.PM, j), yp = this.#ax(1, AXT.PP, j);
        for (let i = 1; i < NX - 1; i++) {
          const c = i + j * sy + k * sz;
          if (type[c] !== FLUID) continue;
          nFluid++;
          let m = 0, s = 0;
          if (!(fx[c] & 1)) { m |= 1; s += this.#ax(0, AXT.PM, i); }
          if (!(fx[c + 1] & 1)) { m |= 2; s += this.#ax(0, AXT.PP, i); }
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
    this.par[PAR.OMEGA] = this.omega;
    this.pIters = 40;
  }

  /** เขียนตำแหน่งบัฟเฟอร์ที่สลับได้ลงบริบทของ kernel */
  #sync() { for (const n of SWAP) this.ctx[SLOT[n]] = this[n].byteOffset; }

  #swapVel() {
    [this.u, this.u0] = [this.u0, this.u];
    [this.v, this.v0] = [this.v0, this.v];
    [this.w, this.w0] = [this.w0, this.w];
    this.#sync();
  }

  reset() {
    const { N, u, v, w, T, C } = this;
    for (const n of F32) if (n !== 'idg') this[n].fill(0);
    this.#applyFixed();
    // เริ่มจากสนามลมธรรมชาติ ช่วยให้เข้าสู่สภาวะคงตัวเร็วขึ้น
    if (this.windSpeed > 0.01) {
      const fx = this.fx, p = this.windAt(0);
      for (let c = 0; c < N; c++) {
        const f = fx[c];
        if (!(f & 1)) u[c] = this.wx * p;
        if (!(f & 4)) w[c] = this.wz * p;
      }
    }
    void v;
    T.fill(this.amb); C.fill(0);
    this.T0.fill(this.amb); this.C0.fill(0);
    this.#sync();
    this.time = 0; this.steps = 0; this.dt = 0;
    this.vmax = 1; this.rate = 0;
    this.divErr = 0;
    this.hist = { t: [], tin: this.mods.map(() => []), cin: this.mods.map(() => []), bal: [], res: { mass: [], mom: [], energy: [] } };
    this.k.ex.residual();   // เก็บสนามเริ่มต้นไว้เป็นค่าอ้างอิงของ residual
    this.hold = 0;
    this.checks = null;
    this.acc = this.#newAcc();
    this.nextSample = SAMPLE_DT;
    this.modState = this.mods.map(m => ({ Tin: this.amb, TinMax: this.amb, Cin: 0, Tdis: this.amb, capF: 1, qRej: 0 }));
    this.converged = false;
    this.project(80);
  }

  #newAcc() { return { t: 0, qIn: 0, qOut: 0, dE: 0, tin: this.mods.map(() => 0), cin: this.mods.map(() => 0) }; }

  /* ───────── สเต็ปเวลา ───────── */

  step() {
    const h = this.h, par = this.par, ex = this.k.ex;
    // Δt จากอัตรา CFL สูงสุด max(|u|/Δx) — เซลล์ใหญ่ไกลเครื่องไม่จำกัด Δt
    const dt = Math.min(0.25, CFL_VEL / Math.max(0.5 / h, this.rate));
    this.dt = dt;
    par[PAR.DT] = dt;
    this.#swapVel();
    ex.advect();
    par[PAR.KB] = G * this.beta * dt;   // แรงลอยตัว Boussinesq บนหน้า v: g·β·(T − T∞)
    ex.buoyancy();
    ex.turbulence();
    this.#swapVel();
    ex.diffuse();
    this.#porous(dt);
    this.#applyFixed();
    this.#applyMirror();
    const it = this.steps < 20 ? 80 : this.pIters;
    this.project(it);
    this.#adaptIterations();

    // อุณหภูมิและ tracer: แบ่งสเต็ปย่อยให้ผ่านเงื่อนไข CFL ของวิธี explicit
    const cour = this.maxOut * dt;
    // เผื่อ 1% กันเศษทศนิยม: ที่ CFL_VEL = 1.5 อัตราส่วนนี้มักเป็น 3.000x พอดี (ลมจากพัดลมเป็นค่าสูงสุด)
    // ซึ่ง ceil จะปัดเป็น 4 สเต็ปย่อยโดยไม่จำเป็น — CFL จริงต่อสเต็ปย่อยยังไม่เกิน 0.505
    const ns = Math.max(1, Math.ceil(cour / CFL_SCALAR - 0.01));
    for (let s = 0; s < ns; s++) {
      this.#updateUnits();
      this.#transport(dt / ns);
    }
    this.time += dt;
    this.steps++;
    this.#monitor(dt);
  }

  #applyFixed() {
    for (const a of ['u', 'v', 'w']) {
      const f = this[a], { idx, val } = this.fixList[a];
      for (let q = 0; q < idx.length; q++) f[idx[q]] = val[q];
    }
  }

  /** ความต้านทานของ louver: du/dt = −k·|u|·u (แก้แบบ implicit จึงไม่มีวันกลับทิศ) */
  #porous(dt) {
    const { u, v, w } = this;
    const { idx, ku, kv, kw } = this.porous;
    for (let a = 0; a < idx.length; a++) {
      const c = idx[a], ka = ku[a], kb = kv[a], kz = kw[a];
      if (ka > 0) u[c] /= 1 + dt * ka * Math.abs(u[c]);
      if (kb > 0) v[c] /= 1 + dt * kb * Math.abs(v[c]);
      if (kz > 0) w[c] /= 1 + dt * kz * Math.abs(w[c]);
    }
  }

  /**
   * Projection: หา φ จาก Σ_หน้าอิสระ coef·(φc − φnb) = −∇·u แล้ว u ← u − ∇φ
   * หน้าที่ถูกกำหนดความเร็ว (ผนัง พัดลม คอยล์ ลมเข้า) เป็นเงื่อนไข Neumann
   * เซลล์เงาของขอบเปิดมี φ = 0 (ความดันบรรยากาศ)
   */
  project(iters) {
    const o = this.par;
    this.k.ex.project(iters);
    this.maxU = o[PAR.MAXU]; this.maxV = Math.max(o[PAR.MAXV], this.fanVmax); this.maxW = o[PAR.MAXW];
    this.maxOut = o[PAR.OUT];                         // 1/s — อัตราไหลออกรวมสูงสุดของเซลล์
    this.rate = Math.max(o[PAR.RATE], this.fanRate);  // 1/s — max(|u|/Δx)
    this.vmax = Math.max(this.maxU, this.maxV, this.maxW);
    this.divErr = Math.sqrt(o[PAR.E2] / Math.max(1, this.nFluid)) / Math.max(0.5, this.vmax);
  }

  #adaptIterations() {
    // ปรับจำนวนรอบให้ความคลาดเคลื่อนของมวลอยู่ราว 0.2–1% ของความเร็วสูงสุด
    if (this.divErr > 0.01) this.pIters = Math.min(120, this.pIters + 6);
    else if (this.divErr < 0.002) this.pIters = Math.max(12, this.pIters - 2);
  }

  /* ───────── CDU: อุณหภูมิลมเข้า → สมรรถนะ → อุณหภูมิลมเป่า ───────── */

  #updateUnits() {
    const { T, C, rho, cp } = this;
    this.mods.forEach((m, mi) => {
      const st = this.modState[mi];
      if (!m.active) return;
      // T ลมเข้า = ค่าเฉลี่ยถ่วงพื้นที่หน้าคอยล์ (ความเร็วดูดเท่ากันทุกหน้า → เท่ากับถ่วงด้วยอัตราไหล)
      let s = 0, sc = 0, sa = 0, mx = -1e9;
      const cells = m.inCells, area = m.inArea;
      for (let a = 0; a < cells.length; a++) {
        const t = T[cells[a]], w = area[a];
        s += t * w; sc += C[cells[a]] * w; sa += w;
        if (t > mx) mx = t;
      }
      const Tin = s / sa;
      const p = modulePerf(m.kw, m.eer, Tin, this.perf);
      st.Tin = Tin; st.TinMax = mx; st.Cin = sc / sa;
      st.capF = p.capF; st.qRej = p.qRej;
      st.Tdis = Tin + p.qRej / (rho * m.q * cp);
      // เซลล์ทึบใต้หน้าพัดลมเก็บสภาวะลมเป่า — transport ใช้เป็นค่าต้นลมของหน้าพัดลม
      const fc = m.fanCells;
      for (let a = 0; a < fc.length; a++) { T[fc[a]] = st.Tdis; C[fc[a]] = 1; }
    });
  }

  /**
   * สมการการพาอุณหภูมิและ tracer แบบปริมาตรจำกัด (อนุรักษ์)
   *   ∂S/∂t + ∇·(uS) = ∇·(αt∇S)     αt = νt / Prt
   * ค่าที่หน้าเซลล์ใช้ MUSCL + van Leer limiter (ไม่เกิดค่าสั่นเกิน)
   */
  #transport(dt) {
    // สลับบัฟเฟอร์แทนการคัดลอก: ค่าเดิมอยู่ใน T0/C0 เขียนค่าใหม่ลง T/C
    [this.T, this.T0] = [this.T0, this.T];
    [this.C, this.C0] = [this.C0, this.C];
    this.#sync();
    this.par[PAR.DT] = dt;
    this.k.ex.transport();
    // บัญชีพลังงาน (W): ความร้อนจาก CDU, ความร้อนที่ออกทางขอบโดเมน, การสะสมในอากาศ
    const rc = this.rho * this.cp;
    let qIn = 0;
    this.mods.forEach((m, mi) => { if (m.active) qIn += this.modState[mi].qRej; });
    const acc = this.acc;
    acc.t += dt;
    acc.qIn += qIn * dt;
    acc.qOut += rc * this.par[PAR.QOUT] * dt;
    acc.dE += rc * this.par[PAR.DE];
    this.mods.forEach((m, mi) => { acc.tin[mi] += this.modState[mi].Tin * dt; acc.cin[mi] += this.modState[mi].Cin * dt; });
  }

  /* ───────── การติดตามผลและเกณฑ์ลู่เข้า ───────── */

  #monitor() {
    if (this.time < this.nextSample) return;
    this.nextSample += SAMPLE_DT;
    const acc = this.acc, t = Math.max(1e-9, acc.t);
    const H = this.hist;
    H.t.push(this.time);
    this.mods.forEach((m, mi) => { H.tin[mi].push(acc.tin[mi] / t); H.cin[mi].push(acc.cin[mi] / t); });
    H.bal.push({ qIn: acc.qIn / t, qOut: acc.qOut / t, dE: acc.dE / t });
    this.#residuals();
    this.acc = this.#newAcc();
    this.#checkConvergence();
  }

  /**
   * Residual แบบ CFX (ใช้ดูแนวโน้ม): RMS ของการเปลี่ยนแปลงในช่วง SAMPLE_DT ที่ทำให้ไร้มิติ
   *   mass   = RMS(∇·u)·h / u_max
   *   mom    = RMS(Δu) / u_max
   *   energy = RMS(ΔT) / ΔT_ref   (ΔT_ref = อุณหภูมิลมเป่าเกินอากาศภายนอกสูงสุด)
   */
  #residuals() {
    this.#sync();
    this.k.ex.residual();
    const du = this.par[PAR.DU2], dT = this.par[PAR.DT2];
    const n = Math.max(1, this.nFluid);
    let dTref = 1;
    for (const st of this.modState) dTref = Math.max(dTref, st.Tdis - this.amb);
    const R = this.hist.res;
    R.mass.push(this.divErr);
    R.mom.push(Math.sqrt(du / (3 * n)) / Math.max(0.5, this.vmax));
    R.energy.push(Math.sqrt(dT / n) / dTref);
  }

  /** ค่าเฉลี่ยของประวัติในช่วงเวลา [t0, t1] */
  #windowMean(arr, t0, t1) {
    const t = this.hist.t;
    let s = 0, n = 0;
    for (let a = t.length - 1; a >= 0 && t[a] > t0; a--) if (t[a] <= t1) { s += arr[a]; n++; }
    return n ? s / n : NaN;
  }

  energyBalance(win = 10) {
    const H = this.hist, t1 = this.time, t0 = t1 - win;
    let qi = 0, qo = 0, de = 0, n = 0;
    for (let a = H.t.length - 1; a >= 0 && H.t[a] > t0; a--) { qi += H.bal[a].qIn; qo += H.bal[a].qOut; de += H.bal[a].dE; n++; }
    if (!n || qi <= 0) return { ratio: NaN, qIn: 0, qOut: 0, dE: 0 };
    return { ratio: (qo + de) / qi, qIn: qi / n, qOut: qo / n, dE: de / n };
  }

  #checkConvergence() {
    const t = this.time;
    let maxDrift = 0;
    this.mods.forEach((m, mi) => {
      if (!m.active) return;
      const a = this.#windowMean(this.hist.tin[mi], t - 10, t);
      const b = this.#windowMean(this.hist.tin[mi], t - 20, t - 10);
      const d = Math.abs(a - b);
      maxDrift = isFinite(d) && isFinite(maxDrift) ? Math.max(maxDrift, d) : NaN;
    });
    const bal = this.energyBalance(10).ratio;
    this.drift = t >= 20 ? maxDrift : NaN;
    this.checks = {
      time: t >= CONV.tMin,
      drift: this.drift <= CONV.drift,
      balance: bal >= CONV.balLo && bal <= CONV.balHi,
      mass: this.divErr <= CONV.mass,
    };
    const ok = Object.values(this.checks).every(Boolean);
    this.hold = ok ? this.hold + 1 : 0;
    this.converged = this.hold >= CONV.hold;
  }

  /* ───────── ผลลัพธ์ ───────── */

  /** ช่วงเวลาที่ใช้เฉลี่ยผล: 20 วินาทีสุดท้าย (หรือครึ่งหลังของเวลาที่คำนวณถ้าสั้นกว่า) */
  report() {
    const t = this.time;
    const win = Math.min(20, Math.max(SAMPLE_DT, t / 2));
    const mods = this.mods.map((m, mi) => {
      const st = this.modState[mi];
      let Tin = this.#windowMean(this.hist.tin[mi], t - win, t);
      let Cin = this.#windowMean(this.hist.cin[mi], t - win, t);
      if (!isFinite(Tin)) { Tin = st.Tin; Cin = st.Cin; }
      const p = modulePerf(m.kw, m.eer, Tin, this.perf);
      return {
        active: m.active, hp: m.hp, kw: m.kw, q: m.q,
        Tin, Cin, TinNow: st.Tin, TinMax: st.TinMax,
        Tdis: Tin + p.qRej / (this.rho * m.q * this.cp),
        capF: p.capF, qCool: p.qCool, qRej: p.qRej, pIn: p.pIn,
        blockedPct: m.blockedPct, fanAreaGrid: m.fanAreaGrid, fanAreaReal: m.fanAreaReal,
      };
    });
    const bal = this.energyBalance(10);
    return {
      time: t, steps: this.steps, dt: this.dt, tMax: this.tMax,
      checks: this.checks, hold: this.hold, conv: CONV,
      avgWindow: win,
      divErr: this.divErr, pIters: this.pIters, drift: this.drift ?? NaN,
      balance: bal, converged: this.converged,
      vmax: this.vmax, threads: this.threads, cells: this.nx * this.ny * this.nz,
      modules: mods,
      history: decimate(this.hist, 500),
    };
  }

  /** สนามค่าที่กึ่งกลางเซลล์ สำหรับแสดงผล */
  fields() {
    const { nx, ny, nz, sy, sz, u, v, w } = this;
    const uc = new Float32Array(this.N), vc = new Float32Array(this.N), wc = new Float32Array(this.N);
    for (let k = 1; k <= nz; k++)
      for (let j = 1; j <= ny; j++) {
        let c = 1 + j * sy + k * sz;
        for (let i = 1; i <= nx; i++, c++) {
          uc[c] = 0.5 * (u[c] + u[c + 1]);
          vc[c] = 0.5 * (v[c] + v[c + sy]);
          wc[c] = 0.5 * (w[c] + w[c + sz]);
        }
      }
    // ความดันเกจเทียบบรรยากาศ (Pa): projection แก้ u -= ∇φ จึงได้ φ = Δt·p/ρ
    const P = new Float32Array(this.N), kp = this.rho / Math.max(1e-6, this.dt || 0.1);
    for (let c = 0; c < this.N; c++) P[c] = this.type[c] === SOLID ? 0 : this.phi[c] * kp;
    // เซลล์ทึบใต้พัดลมเก็บสภาวะลมเป่าไว้ให้ transport — ไม่ใช่ค่าของอากาศ จึงไม่ส่งไปแสดงผล
    const T = this.T.slice(), C = this.C.slice();
    for (const m of this.mods) for (let a = 0; a < m.fanCells.length; a++) { T[m.fanCells[a]] = this.amb; C[m.fanCells[a]] = 0; }
    return { T, C, u: uc, v: vc, w: wc, P };
  }
}

/** ย่อประวัติให้เหลือไม่เกิน n จุด (ส่งไปวาดกราฟ) — เก็บจุดสุดท้ายเสมอ */
function decimate(H, n) {
  const L = H.t.length, step = Math.max(1, Math.ceil(L / n));
  const idx = [];
  for (let a = (L - 1) % step; a < L; a += step) idx.push(a);
  const pick = arr => idx.map(a => arr[a]);
  return {
    t: pick(H.t), tin: H.tin.map(pick),
    res: { mass: pick(H.res.mass), mom: pick(H.res.mom), energy: pick(H.res.energy) },
  };
}
