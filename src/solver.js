/*
 * solver.js — เครื่องคำนวณ CFD สามมิติสำหรับลมร้อนจากคอยล์ร้อน
 *
 * สมการ: Navier–Stokes แบบอัดตัวไม่ได้ + Boussinesq + สมการพลังงาน + สารติดตาม (tracer)
 * กริด: สม่ำเสมอ แบบ staggered (MAC) ความเร็วอยู่บนหน้าเซลล์ ความดัน/อุณหภูมิอยู่กลางเซลล์
 *
 *   ความเร็ว     : Semi-Lagrangian (เสถียรที่ CFL > 1) + ความหนืดปั่นป่วน Smagorinsky
 *   ความดัน      : Projection, สมการ Poisson แก้ด้วย Red–Black SOR แบบ warm start
 *   อุณหภูมิ/tracer: Finite volume แบบอนุรักษ์ MUSCL (van Leer) — พลังงานเข้า = ออก ตรงตามจริง
 *   CDU          : หน้าพัดลม/หน้าคอยล์กำหนดความเร็ว, อุณหภูมิลมเป่าคำนวณจากลมเข้า + ความร้อนทิ้ง
 *                  ซึ่งขึ้นกับอุณหภูมิลมเข้าเอง (ป้อนกลับทุกสเต็ป)
 *
 * ความเร็ว: ลูปหนัก (advection, turbulence, diffusion, projection, transport) มีสองชุดที่ให้ผลตรงกัน
 * ทุกบิต — WebAssembly (src/kernels.c, เร็วกว่าราว 1.7 เท่า) และ JavaScript ในไฟล์นี้ (ใช้เมื่อโหลด
 * WebAssembly ไม่ได้)
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
  mass: 0.01,        // RMS(∇·u)·h / u_max หลัง projection
  hold: 6,
};

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

    // อาร์เรย์ทั้งหมดอยู่ใน linear memory ของ WebAssembly ถ้าใช้ได้ (params.kernels มาจาก
    // createKernelsAsync ใน engine.js) ไม่เช่นนั้นเป็น typed array ธรรมดา
    const N = this.N;
    this.k = params.kernels === undefined ? createKernels(Solver.memoryBytes(mesh)) : params.kernels;
    const A = this.k ? (T, n) => this.k.alloc(T, n) : (T, n) => new T(n);
    this.alloc = A;
    const F = () => A(Float32Array, N);
    this.type = A(Uint8Array, N); this.type.set(mesh.type);
    this.u = F(); this.v = F(); this.w = F();
    this.u0 = F(); this.v0 = F(); this.w0 = F();
    this.T = F(); this.T0 = F(); this.C = F(); this.C0 = F();
    // ตัวสะสมฟลักซ์เป็น double — ไม่ปัดเศษเป็น float ระหว่างรวมฟลักซ์จากหกหน้า
    this.dT = A(Float64Array, N); this.dC = A(Float64Array, N);
    this.phi = F(); this.rhs = F(); this.dv = F();
    this.nut = F();
    this.uc = F(); this.vc = F(); this.wc = F();
    this.fixU = A(Uint8Array, N); this.fixV = A(Uint8Array, N); this.fixW = A(Uint8Array, N);
    this.uF = F(); this.vF = F(); this.wF = F();
    this.fanOf = A(Int16Array, N);   // หน้า v ที่เป็นพัดลม → ดัชนีโมดูล + 1
    this.pm = A(Uint8Array, N); this.nf = A(Uint8Array, N);
    this.tdis = A(Float64Array, Math.max(1, this.mods.length));   // T ลมเป่าของแต่ละโมดูล
    this.kout = A(Float64Array, 8);                                 // ผลลัพธ์สเกลาร์จาก kernel

    this.#classifyFaces();
    this.#buildFixedLists();
    this.#buildPorous();
    this.#buildMirror(mesh.bc);
    this.#buildProjection();
    this.reset();
  }

  /** ขนาดหน่วยความจำ (ไบต์) ที่ต้องจองให้ WebAssembly สำหรับกริดนี้ */
  static memoryBytes(mesh) {
    const N = mesh.N;
    // 20 Float32 + 2 Float64 + 6 Uint8 + 1 Int16 + รายการเซลล์ (red+black ≤ N, fluid ≤ N) เป็น Int32
    return N * (20 * 4 + 2 * 8 + 6 + 2 + 2 * 4) + (mesh.modules.length + 9) * 8 + 40 * ALIGN_SLACK;
  }

  /* ───────── การเตรียมกริด ───────── */

  windAt(y) {
    // โปรไฟล์ลมแบบ power law อ้างอิงความเร็วที่ความสูง 10 ม.
    return Math.pow(Math.max(0.3, y) / 10, 0.2);
  }

  #classifyFaces() {
    const { NX, NY, NZ, sy, sz, type, h, nx, nz } = this;
    const { fixU, fixV, fixW, uF, vF, wF } = this;
    const wind = this.windSpeed > 0.01;
    for (let k = 0; k < NZ; k++)
      for (let j = 0; j < NY; j++)
        for (let i = 0; i < NX; i++) {
          const c = i + j * sy + k * sz, tc = type[c];
          const y = (j - 0.5) * h, prof = this.windAt(y);
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
    this.mods.forEach((m, mi) => {
      if (!m.active) return;
      for (let a = 0; a < m.fanFaces.length; a++) {
        const f = m.fanFaces[a];
        fixV[f] = 1; vF[f] = m.fanVel[a]; this.fanOf[f] = mi + 1;
      }
      for (let a = 0; a < m.inFaces.length; a++) {
        const f = m.inFaces[a];
        if (m.inAxis[a] === 0) { fixU[f] = 1; uF[f] = m.inVel[a]; }
        else { fixW[f] = 1; wF[f] = m.inVel[a]; }
      }
    });
  }

  /** รายการหน้าที่ถูกกำหนดความเร็ว — ไม่ต้องไล่ตรวจทั้งกริดทุกสเต็ป */
  #buildFixedLists() {
    const { N, fixU, fixV, fixW } = this;
    const list = fix => { const a = []; for (let c = 0; c < N; c++) if (fix[c]) a.push(c); return Int32Array.from(a); };
    this.fixList = { u: list(fixU), v: list(fixV), w: list(fixW) };
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

  #buildProjection() {
    const { N, type, sy, sz, fixU, fixV, fixW } = this;
    const red = [], black = [], fluid = [];
    for (let c = 0; c < N; c++) {
      if (type[c] !== FLUID) continue;
      let m = 0, n = 0;
      if (!fixU[c]) { m |= 1; n++; }
      if (!fixU[c + 1]) { m |= 2; n++; }
      if (!fixV[c]) { m |= 4; n++; }
      if (!fixV[c + sy]) { m |= 8; n++; }
      if (!fixW[c]) { m |= 16; n++; }
      if (!fixW[c + sz]) { m |= 32; n++; }
      this.pm[c] = m; this.nf[c] = n;
      fluid.push(c);
      if (!n) continue;
      const i = c % this.NX, j = ((c / sy) | 0) % this.NY, k = (c / sz) | 0;
      ((i + j + k) & 1 ? black : red).push(c);
    }
    const list = a => { const r = this.alloc(Int32Array, a.length); r.set(a); return r; };
    this.red = list(red);
    this.black = list(black);
    this.fluid = list(fluid);
    const L = Math.max(this.nx, this.ny, this.nz);
    this.omega = Math.min(1.92, Math.max(1.6, 2 / (1 + Math.sin(Math.PI / L))));
    this.pIters = 40;
  }

  reset() {
    const { N, u, v, w, T, C, uF, vF, wF, fixU, fixV, fixW } = this;
    for (let c = 0; c < N; c++) {
      u[c] = fixU[c] ? uF[c] : 0; v[c] = fixV[c] ? vF[c] : 0; w[c] = fixW[c] ? wF[c] : 0;
    }
    // เริ่มจากสนามลมธรรมชาติ ช่วยให้เข้าสู่สภาวะคงตัวเร็วขึ้น
    if (this.windSpeed > 0.01) {
      const { NX, NY, NZ, sy, sz, h } = this;
      for (let k = 0; k < NZ; k++)
        for (let j = 0; j < NY; j++)
          for (let i = 0; i < NX; i++) {
            const c = i + j * sy + k * sz, p = this.windAt((j - 0.5) * h);
            if (!fixU[c]) u[c] = this.wx * p;
            if (!fixW[c]) w[c] = this.wz * p;
          }
    }
    T.fill(this.amb); C.fill(0);
    this.T0.fill(this.amb); this.C0.fill(0); this.dT.fill(0); this.dC.fill(0);
    this.phi.fill(0);
    this.time = 0; this.steps = 0; this.dt = 0;
    this.vmax = 1;
    this.divErr = 0;
    this.hist = { t: [], tin: this.mods.map(() => []), cin: this.mods.map(() => []), bal: [], res: { mass: [], mom: [], energy: [] } };
    this.prev = { u: this.u.slice(), v: this.v.slice(), w: this.w.slice(), T: this.T.slice() };
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
    const h = this.h;
    const dt = Math.min(0.25, CFL_VEL * h / Math.max(0.5, this.vmax));
    this.dt = dt;
    this.#advectVelocity(dt);
    this.#buoyancy(dt);
    this.#turbulence(dt);
    this.#diffuseVelocity(dt);
    this.#porous(dt);
    this.#applyFixed();
    this.#applyMirror();
    const it = this.steps < 20 ? 80 : this.pIters;
    this.project(it);
    this.#adaptIterations();

    // อุณหภูมิและ tracer: แบ่งสเต็ปย่อยให้ผ่านเงื่อนไข CFL ของวิธี explicit
    const cour = this.maxOut * dt / h;
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
    const { u, v, w, uF, vF, wF, fixList } = this;
    let L = fixList.u;
    for (let a = 0; a < L.length; a++) { const c = L[a]; u[c] = uF[c]; }
    L = fixList.v;
    for (let a = 0; a < L.length; a++) { const c = L[a]; v[c] = vF[c]; }
    L = fixList.w;
    for (let a = 0; a < L.length; a++) { const c = L[a]; w[c] = wF[c]; }
  }

  #advectVelocity(dt) {
    const { nx, ny, nz, NX, NY, NZ, sy, sz, h, u, v, w, u0, v0, w0, fixU, fixV, fixW } = this;
    u0.set(u); v0.set(v); w0.set(w);
    const r = dt / h;
    if (this.k) {
      this.k.ex.advect(nx, ny, nz, NX, NY, NZ, sy, sz, r, u.byteOffset, v.byteOffset, w.byteOffset,
        u0.byteOffset, v0.byteOffset, w0.byteOffset, fixU.byteOffset, fixV.byteOffset, fixW.byteOffset);
      return;
    }
    const xm = NX - 1.001, ym = NY - 1.001, zm = NZ - 1.001;
    // ย้อนรอยตามลม (backtrace) แล้วอ่านค่าแบบ trilinear ในพิกัดดัชนีของอาร์เรย์นั้น
    const sample = (a, fi, fj, fk) => {
      if (fi < 0) fi = 0; else if (fi > xm) fi = xm;
      if (fj < 0) fj = 0; else if (fj > ym) fj = ym;
      if (fk < 0) fk = 0; else if (fk > zm) fk = zm;
      const i0 = fi | 0, j0 = fj | 0, k0 = fk | 0;
      const s1 = fi - i0, t1 = fj - j0, r1 = fk - k0;
      const b = i0 + j0 * sy + k0 * sz;
      const a00 = a[b] + s1 * (a[b + 1] - a[b]);
      const a10 = a[b + sy] + s1 * (a[b + sy + 1] - a[b + sy]);
      const a01 = a[b + sz] + s1 * (a[b + sz + 1] - a[b + sz]);
      const a11 = a[b + sz + sy] + s1 * (a[b + sz + sy + 1] - a[b + sz + sy]);
      const a0 = a00 + t1 * (a10 - a00), a1 = a01 + t1 * (a11 - a01);
      return a0 + r1 * (a1 - a0);
    };
    for (let k = 1; k <= nz; k++)
      for (let j = 1; j <= ny; j++) {
        let c = 1 + j * sy + k * sz;
        for (let i = 1; i <= nx + 1; i++, c++) {
          if (fixU[c]) continue;
          const uu = u0[c];
          const vv = 0.25 * (v0[c - 1] + v0[c] + v0[c - 1 + sy] + v0[c + sy]);
          const ww = 0.25 * (w0[c - 1] + w0[c] + w0[c - 1 + sz] + w0[c + sz]);
          u[c] = sample(u0, i - r * uu, j - r * vv, k - r * ww);
        }
      }
    for (let k = 1; k <= nz; k++)
      for (let j = 1; j <= ny + 1; j++) {
        let c = 1 + j * sy + k * sz;
        for (let i = 1; i <= nx; i++, c++) {
          if (fixV[c]) continue;
          const uu = 0.25 * (u0[c] + u0[c + 1] + u0[c - sy] + u0[c + 1 - sy]);
          const vv = v0[c];
          const ww = 0.25 * (w0[c] + w0[c + sz] + w0[c - sy] + w0[c - sy + sz]);
          v[c] = sample(v0, i - r * uu, j - r * vv, k - r * ww);
        }
      }
    for (let k = 1; k <= nz + 1; k++)
      for (let j = 1; j <= ny; j++) {
        let c = 1 + j * sy + k * sz;
        for (let i = 1; i <= nx; i++, c++) {
          if (fixW[c]) continue;
          const uu = 0.25 * (u0[c] + u0[c + 1] + u0[c - sz] + u0[c + 1 - sz]);
          const vv = 0.25 * (v0[c] + v0[c + sy] + v0[c - sz] + v0[c + sy - sz]);
          const ww = w0[c];
          w[c] = sample(w0, i - r * uu, j - r * vv, k - r * ww);
        }
      }
  }

  /** แรงลอยตัว Boussinesq บนหน้า v: g·β·(T − T∞) */
  #buoyancy(dt) {
    const { nx, ny, nz, sy, sz, v, T, fixV } = this;
    const kb = G * this.beta * dt, amb = this.amb;
    if (this.k) {
      this.k.ex.buoyancy(nx, ny, nz, sy, sz, kb, amb, v.byteOffset, T.byteOffset, fixV.byteOffset);
      return;
    }
    for (let k = 1; k <= nz; k++)
      for (let j = 2; j <= ny + 1; j++) {
        let c = 1 + j * sy + k * sz;
        for (let i = 1; i <= nx; i++, c++) {
          if (fixV[c]) continue;
          v[c] += kb * (0.5 * (T[c] + T[c - sy]) - amb);
        }
      }
  }

  /** ความหนืดปั่นป่วนแบบ Smagorinsky: νt = (Cs·Δ)²·|S| */
  #turbulence(dt) {
    const { nx, ny, nz, sy, sz, h, u, v, w, uc, vc, wc, nut, type } = this;
    if (this.k) {
      this.k.ex.turbulence(nx, ny, nz, sy, sz, (CS * h) ** 2, 1 / h, 0.5 / h, 0.14 * h * h / dt, NU_MIN,
        u.byteOffset, v.byteOffset, w.byteOffset, uc.byteOffset, vc.byteOffset, wc.byteOffset, nut.byteOffset, type.byteOffset);
      return;
    }
    for (let k = 1; k <= nz; k++)
      for (let j = 1; j <= ny; j++) {
        let c = 1 + j * sy + k * sz;
        for (let i = 1; i <= nx; i++, c++) {
          uc[c] = 0.5 * (u[c] + u[c + 1]);
          vc[c] = 0.5 * (v[c] + v[c + sy]);
          wc[c] = 0.5 * (w[c] + w[c + sz]);
        }
      }
    const l2 = (CS * h) ** 2, inv = 1 / h, i2 = 0.5 / h;
    const cap = 0.14 * h * h / dt;
    for (let k = 1; k <= nz; k++)
      for (let j = 1; j <= ny; j++) {
        let c = 1 + j * sy + k * sz;
        for (let i = 1; i <= nx; i++, c++) {
          if (type[c] !== FLUID) { nut[c] = 0; continue; }
          const dudx = (u[c + 1] - u[c]) * inv, dvdy = (v[c + sy] - v[c]) * inv, dwdz = (w[c + sz] - w[c]) * inv;
          const dudy = (uc[c + sy] - uc[c - sy]) * i2, dudz = (uc[c + sz] - uc[c - sz]) * i2;
          const dvdx = (vc[c + 1] - vc[c - 1]) * i2, dvdz = (vc[c + sz] - vc[c - sz]) * i2;
          const dwdx = (wc[c + 1] - wc[c - 1]) * i2, dwdy = (wc[c + sy] - wc[c - sy]) * i2;
          const a = dudy + dvdx, b = dudz + dwdx, e = dvdz + dwdy;
          const S = Math.sqrt(2 * (dudx * dudx + dvdy * dvdy + dwdz * dwdz) + a * a + b * b + e * e);
          const nu = NU_MIN + l2 * S;
          nut[c] = nu < cap ? nu : cap;
        }
      }
  }

  #diffuseVelocity(dt) {
    const { nx, ny, nz, sy, sz, h, u, v, w, u0, v0, w0, nut, fixU, fixV, fixW } = this;
    u0.set(u); v0.set(v); w0.set(w);
    const q = dt / (h * h);
    if (this.k) {
      this.k.ex.diffuse(nx, ny, nz, sy, sz, q, u.byteOffset, v.byteOffset, w.byteOffset,
        u0.byteOffset, v0.byteOffset, w0.byteOffset, nut.byteOffset, fixU.byteOffset, fixV.byteOffset, fixW.byteOffset);
      return;
    }
    for (let k = 2; k <= nz - 1; k++)
      for (let j = 2; j <= ny - 1; j++) {
        let c = 2 + j * sy + k * sz;
        for (let i = 2; i <= nx - 1; i++, c++) {
          if (!fixU[c]) {
            const a = q * 0.5 * (nut[c] + nut[c - 1]);
            u[c] = u0[c] + a * (u0[c - 1] + u0[c + 1] + u0[c - sy] + u0[c + sy] + u0[c - sz] + u0[c + sz] - 6 * u0[c]);
          }
          if (!fixV[c]) {
            const a = q * 0.5 * (nut[c] + nut[c - sy]);
            v[c] = v0[c] + a * (v0[c - 1] + v0[c + 1] + v0[c - sy] + v0[c + sy] + v0[c - sz] + v0[c + sz] - 6 * v0[c]);
          }
          if (!fixW[c]) {
            const a = q * 0.5 * (nut[c] + nut[c - sz]);
            w[c] = w0[c] + a * (w0[c - 1] + w0[c + 1] + w0[c - sy] + w0[c + sy] + w0[c - sz] + w0[c + sz] - 6 * w0[c]);
          }
        }
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
   * Projection: หา φ จาก Σ_หน้าอิสระ (φc − φnb) = −h·Σ u_out แล้ว u ← u − ∇φ
   * หน้าที่ถูกกำหนดความเร็ว (ผนัง พัดลม คอยล์ ลมเข้า) เป็นเงื่อนไข Neumann
   * เซลล์เงาของขอบเปิดมี φ = 0 (ความดันบรรยากาศ)
   */
  project(iters) {
    const { sy, sz, h, u, v, w, phi, rhs, pm, nf, red, black, fluid } = this;
    if (this.k) {
      const o = this.kout;
      this.k.ex.project(sy, sz, h, iters, this.omega, u.byteOffset, v.byteOffset, w.byteOffset,
        phi.byteOffset, rhs.byteOffset, this.dv.byteOffset, pm.byteOffset, nf.byteOffset, this.type.byteOffset,
        red.byteOffset, red.length, black.byteOffset, black.length, fluid.byteOffset, fluid.length, o.byteOffset);
      this.#projectStats(o[0], o[1], o[2], o[3], o[4]);
      return;
    }
    for (let a = 0; a < fluid.length; a++) {
      const c = fluid[a];
      rhs[c] = h * (u[c + 1] - u[c] + v[c + sy] - v[c] + w[c + sz] - w[c]);
    }
    const om = this.omega;
    for (let it = 0; it < iters; it++) {
      for (let pass = 0; pass < 2; pass++) {
        const list = pass ? black : red;
        for (let a = 0; a < list.length; a++) {
          const c = list[a], m = pm[c];
          if (m === 63) {
            // เซลล์ภายในทั่วไป: หน้าอิสระครบหกด้าน
            const p = phi[c];
            phi[c] = p + om * ((phi[c - 1] + phi[c + 1] + phi[c - sy] + phi[c + sy] + phi[c - sz] + phi[c + sz] - rhs[c]) / 6 - p);
            continue;
          }
          let s = 0;
          if (m & 1) s += phi[c - 1];
          if (m & 2) s += phi[c + 1];
          if (m & 4) s += phi[c - sy];
          if (m & 8) s += phi[c + sy];
          if (m & 16) s += phi[c - sz];
          if (m & 32) s += phi[c + sz];
          const p = phi[c];
          phi[c] = p + om * ((s - rhs[c]) / nf[c] - p);
        }
      }
    }
    const inv = 1 / h;
    let mu = 0, mv = 0, mw = 0;
    for (let a = 0; a < fluid.length; a++) {
      const c = fluid[a], m = pm[c], p = phi[c];
      // ปรับหน้าด้านลบของเซลล์ (หน้าด้านบวกเป็นหน้าด้านลบของเซลล์ถัดไป หรือหน้าขอบเปิด)
      if (m & 1) u[c] -= (p - phi[c - 1]) * inv;
      if (m & 4) v[c] -= (p - phi[c - sy]) * inv;
      if (m & 16) w[c] -= (p - phi[c - sz]) * inv;
      if ((m & 2) && this.type[c + 1] === OPEN) u[c + 1] -= (0 - p) * inv;
      if ((m & 8) && this.type[c + sy] === OPEN) v[c + sy] -= (0 - p) * inv;
      if ((m & 32) && this.type[c + sz] === OPEN) w[c + sz] -= (0 - p) * inv;
    }
    // ความคลาดเคลื่อนของสมการความต่อเนื่องหลัง projection
    let e2 = 0, mo = 0;
    const dv = this.dv;
    for (let a = 0; a < fluid.length; a++) {
      const c = fluid[a];
      const au = Math.abs(u[c]), av = Math.abs(v[c]), aw = Math.abs(w[c]);
      if (au > mu) mu = au; if (av > mv) mv = av; if (aw > mw) mw = aw;
      const up = u[c + 1], um = u[c], vp = v[c + sy], vm = v[c], wp = w[c + sz], wm = w[c];
      const d = up - um + vp - vm + wp - wm;
      dv[c] = d;
      const o = (up > 0 ? up : 0) - (um < 0 ? um : 0) + (vp > 0 ? vp : 0) - (vm < 0 ? vm : 0) + (wp > 0 ? wp : 0) - (wm < 0 ? wm : 0);
      if (o > mo) mo = o;
      e2 += d * d;
    }
    this.#projectStats(mu, mv, mw, mo, e2);
  }

  #projectStats(mu, mv, mw, mo, e2) {
    for (const m of this.mods) for (let a = 0; a < m.fanVel.length; a++) if (m.fanVel[a] > mv) mv = m.fanVel[a];
    this.maxU = mu; this.maxV = mv; this.maxW = mw; this.maxOut = mo;
    this.vmax = Math.max(mu, mv, mw);
    this.divErr = Math.sqrt(e2 / Math.max(1, this.fluid.length)) / Math.max(0.5, this.vmax);
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
      let s = 0, sc = 0, mx = -1e9;
      const cells = m.inCells;
      for (let a = 0; a < cells.length; a++) {
        const t = T[cells[a]];
        s += t; sc += C[cells[a]];
        if (t > mx) mx = t;
      }
      const Tin = s / cells.length;
      const p = modulePerf(m.kw, m.eer, Tin, this.perf);
      st.Tin = Tin; st.TinMax = mx; st.Cin = sc / cells.length;
      st.capF = p.capF; st.qRej = p.qRej;
      st.Tdis = Tin + p.qRej / (rho * m.q * cp);
    });
  }

  /**
   * สมการการพาอุณหภูมิและ tracer แบบปริมาตรจำกัด (อนุรักษ์)
   *   ∂S/∂t + ∇·(uS) = ∇·(αt∇S)     αt = νt / Prt
   * ค่าที่หน้าเซลล์ใช้ MUSCL + van Leer limiter (ไม่เกิดค่าสั่นเกิน)
   */
  #transport(dt) {
    // สลับบัฟเฟอร์แทนการคัดลอก: ค่าเดิมอยู่ใน T0/C0 เขียนค่าใหม่ลง T/C
    // (เซลล์ที่ไม่ใช่อากาศมีค่าเท่ากันทั้งสองบัฟเฟอร์เสมอ — ดู reset)
    [this.T, this.T0] = [this.T0, this.T];
    [this.C, this.C0] = [this.C0, this.C];
    let dE;
    if (this.k) {
      const { T, C, T0, C0, dT, dC, tdis, kout: o, fluid } = this;
      for (let mi = 0; mi < this.mods.length; mi++) tdis[mi] = this.modState[mi].Tdis;
      this.k.ex.transport(this.nx, this.ny, this.nz, this.sy, this.sz, dt, this.h, 0.5 / PR_T, this.amb,
        this.u.byteOffset, this.v.byteOffset, this.w.byteOffset, this.type.byteOffset,
        T.byteOffset, C.byteOffset, T0.byteOffset, C0.byteOffset, dT.byteOffset, dC.byteOffset,
        this.nut.byteOffset, this.dv.byteOffset, this.fanOf.byteOffset, tdis.byteOffset,
        fluid.byteOffset, fluid.length, o.byteOffset);
      this._qOut = o[0]; dE = o[1];
    } else dE = this.#transportJS(dt);
    this.#energyAccount(dt, dE);
  }

  #transportJS(dt) {
    const { T, C, T0, C0, dT, dC, h, amb } = this;
    this._qOut = 0;
    this.#fluxAxis(this.u, 1, 0, dt);
    this.#fluxAxis(this.v, this.sy, 1, dt);
    this.#fluxAxis(this.w, this.sz, 2, dt);
    const k = dt / h, dv = this.dv;
    let dE = 0;
    const fl = this.fluid;
    for (let a = 0; a < fl.length; a++) {
      const c = fl[a];
      // + S·(∇·u) ชดเชยความคลาดเคลื่อนของมวลที่เหลือจาก projection (สนามคงที่ยังคงที่)
      let t = T0[c] + k * (dT[c] + T0[c] * dv[c]);
      let q = C0[c] + k * (dC[c] + C0[c] * dv[c]);
      dT[c] = 0; dC[c] = 0;   // ฟลักซ์เขียนลงเฉพาะเซลล์อากาศ จึงล้างที่นี่แทน fill ทั้งกริด
      if (t < amb - 2) t = amb - 2; else if (t > amb + 70) t = amb + 70;
      if (q < 0) q = 0; else if (q > 1) q = 1;
      dE += t - T0[c];
      T[c] = t; C[c] = q;
    }
    return dE;
  }

  #energyAccount(dt, dE) {
    const h = this.h;
    // บัญชีพลังงาน (W): ความร้อนจาก CDU, ความร้อนที่ออกทางขอบโดเมน, การสะสมในอากาศ
    const rc = this.rho * this.cp;
    let qIn = 0;
    this.mods.forEach((m, mi) => { if (m.active) qIn += this.modState[mi].qRej; });
    const acc = this.acc;
    acc.t += dt;
    acc.qIn += qIn * dt;
    acc.qOut += rc * h * h * this._qOut * dt;
    acc.dE += rc * h * h * h * dE;
    this.mods.forEach((m, mi) => { acc.tin[mi] += this.modState[mi].Tin * dt; acc.cin[mi] += this.modState[mi].Cin * dt; });
  }

  #fluxAxis(vel, st, axis, dt) {
    const { nx, ny, nz, sy, sz, type, T0, C0, dT, dC, nut, h, amb, fanOf } = this;
    const i1 = axis === 0 ? nx + 1 : nx, j1 = axis === 1 ? ny + 1 : ny, k1 = axis === 2 ? nz + 1 : nz;
    const acap = 0.12 * h * h / dt;
    const dh = 1 / h, ka = 0.5 / PR_T;
    let qOut = 0;
    for (let k = 1; k <= k1; k++)
      for (let j = 1; j <= j1; j++) {
        let c = 1 + j * sy + k * sz;
        for (let i = 1; i <= i1; i++, c++) {
          const a = c - st;
          const ta = type[a], tb = type[c];
          const vf = vel[c];
          if ((ta | tb) === 0) {
            // ── กรณีทั่วไป: อากาศ–อากาศ (MUSCL + van Leer: ค่าที่หน้า = Sup + ½·2d1d2/(d1+d2)) ──
            let sT, sC;
            if (vf > 0) {
              const ta0 = T0[a], ca0 = C0[a];
              sT = ta0; sC = ca0;
              const m = a - st;
              if (type[m] === 0) {
                let d1 = ta0 - T0[m], d2 = T0[c] - ta0, p = d1 * d2;
                if (p > 0) sT += p / (d1 + d2);
                d1 = ca0 - C0[m]; d2 = C0[c] - ca0; p = d1 * d2;
                if (p > 0) sC += p / (d1 + d2);
              }
            } else {
              const tb0 = T0[c], cb0 = C0[c];
              sT = tb0; sC = cb0;
              const m = c + st;
              if (type[m] === 0) {
                let d1 = tb0 - T0[m], d2 = T0[a] - tb0, p = d1 * d2;
                if (p > 0) sT += p / (d1 + d2);
                d1 = cb0 - C0[m]; d2 = C0[a] - cb0; p = d1 * d2;
                if (p > 0) sC += p / (d1 + d2);
              }
            }
            let al = ka * (nut[a] + nut[c]);
            if (al > acap) al = acap;
            const g = al * dh;
            const FT = vf * sT - g * (T0[c] - T0[a]);
            const FC = vf * sC - g * (C0[c] - C0[a]);
            dT[a] -= FT; dC[a] -= FC;
            dT[c] += FT; dC[c] += FC;
            continue;
          }
          if (ta !== FLUID && tb !== FLUID) continue;
          if (ta === SOLID || tb === SOLID) {
            if (vf === 0) continue;
            let sT, sC;
            if ((vf > 0) === (ta === SOLID)) {
              // ลมเป่าออกจากพัดลม CDU
              const m = fanOf[c];
              if (!m) continue;
              sT = this.modState[m - 1].Tdis; sC = 1;
            } else {
              // ลมถูกดูดเข้าคอยล์: ค่าที่หน้า = ค่าของเซลล์อากาศด้านต้นลม
              const f = ta === FLUID ? a : c;
              sT = T0[f]; sC = C0[f];
            }
            const FT = vf * sT, FC = vf * sC;
            if (ta === FLUID) { dT[a] -= FT; dC[a] -= FC; } else { dT[c] += FT; dC[c] += FC; }
            continue;
          }
          // อากาศ–ขอบเปิด: ลมเข้าโดเมนมีค่าเท่าอากาศภายนอก ลมออกใช้ค่าของเซลล์ด้านใน (upwind)
          const f = ta === FLUID ? a : c;
          const inflow = ta === FLUID ? vf < 0 : vf > 0;
          const sT = inflow ? amb : T0[f], sC = inflow ? 0 : C0[f];
          let al = 2 * ka * nut[f];
          if (al > acap) al = acap;
          const g = al * dh;
          const FT = vf * sT - g * (ta === FLUID ? amb - T0[a] : T0[c] - amb);
          const FC = vf * sC - g * (ta === FLUID ? -C0[a] : C0[c]);
          if (ta === FLUID) { dT[a] -= FT; dC[a] -= FC; qOut += FT - vf * amb; }
          else { dT[c] += FT; dC[c] += FC; qOut -= FT - vf * amb; }
        }
      }
    this._qOut += qOut;
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
    const { fluid, u, v, w, T, prev, sy, sz } = this;
    let du = 0, dT = 0;
    for (let a = 0; a < fluid.length; a++) {
      const c = fluid[a];
      const x = u[c] - prev.u[c], y = v[c] - prev.v[c], z = w[c] - prev.w[c], t = T[c] - prev.T[c];
      du += x * x + y * y + z * z; dT += t * t;
    }
    void sy; void sz;
    const n = Math.max(1, fluid.length);
    let dTref = 1;
    for (const st of this.modState) dTref = Math.max(dTref, st.Tdis - this.amb);
    const R = this.hist.res;
    R.mass.push(this.divErr);
    R.mom.push(Math.sqrt(du / (3 * n)) / Math.max(0.5, this.vmax));
    R.energy.push(Math.sqrt(dT / n) / dTref);
    prev.u.set(u); prev.v.set(v); prev.w.set(w); prev.T.set(T);
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
      vmax: this.vmax,
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
    return { T: this.T.slice(), C: this.C.slice(), u: uc, v: vc, w: wc, P };
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

/** van Leer: ความชันแบบค่าเฉลี่ยฮาร์มอนิก เป็นศูนย์เมื่อสองข้างต่างทิศ */
function vl(d1, d2) {
  const p = d1 * d2;
  return p > 0 ? 2 * p / (d1 + d2) : 0;
}
