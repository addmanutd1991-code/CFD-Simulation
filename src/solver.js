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
import { SolverBase, CONV, SAMPLE_DT } from './monitor.js';

export { CONV };

import { GridPrep, AXT, FLUID, SOLID, OPEN } from './prep.js';

export { FLUID, SOLID, OPEN };
const G = 9.81;
const CS = 0.17;        // ค่าคงที่ Smagorinsky
const NU_MIN = 2e-3;    // m²/s — ความปั่นป่วนพื้นหลังของอากาศภายนอก
const PR_T = 0.85;      // Turbulent Prandtl number
const CFL_VEL = 1.5;    // Semi-Lagrangian ยอม CFL > 1
const CFL_SCALAR = 0.5;    // ต่อผลรวมความเร็วไหลออกของเซลล์ (MUSCL + Euler)
/* ลำดับช่องต้องตรงกับ struct Ctx, enum AX_*, และ enum P_* ใน kernels.c */
const CTX = ['nx', 'ny', 'nz', 'NX', 'NY', 'NZ', 'sy', 'sz', 'N', 'nthreads',
  'u', 'v', 'w', 'u0', 'v0', 'w0', 'T', 'T0', 'C', 'C0', 'phi', 'rhs', 'nut', 'idg',
  'pu', 'pv', 'pw', 'pT', 'type', 'fx', 'pm', 'axx', 'axy', 'axz', 'red', 'scratch', 'par'];
const SLOT = Object.fromEntries(CTX.map((n, i) => [n, i]));
const PAR = Object.fromEntries(['DT', 'KB', 'AMB', 'CS2', 'NUMIN', 'OMEGA', 'KA',
  'MAXU', 'MAXV', 'MAXW', 'RATE', 'OUT', 'E2', 'QOUT', 'DE', 'DU2', 'DT2'].map((n, i) => [n, i]));
const RED = 8;
const SWAP = ['u', 'v', 'w', 'u0', 'v0', 'w0', 'T', 'T0', 'C', 'C0'];
const F32 = ['u', 'v', 'w', 'u0', 'v0', 'w0', 'T', 'T0', 'C', 'C0', 'phi', 'rhs', 'nut', 'idg', 'pu', 'pv', 'pw', 'pT'];

export class Solver extends SolverBase {
  constructor(mesh, params) {
    super();
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
    // การเตรียมกริด (หน้าที่กำหนดความเร็ว louver ขอบสมมาตร สัมประสิทธิ์ Poisson) ใช้ร่วมกับ solver แบบ GPU
    const prep = new GridPrep(mesh, { speed: this.windSpeed, wx: this.wx, wz: this.wz });
    this.fx.set(prep.fx); this.pm.set(prep.pm); this.idg.set(prep.idg);
    Object.assign(this, {
      fixList: prep.fixList, porous: prep.porous, mirror: prep.mirror, nFluid: prep.nFluid, omega: prep.omega,
      fanRate: prep.fanRate, fanVmax: prep.fanVmax,
    });
    this.axes = prep.axes.map(a => {
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

    this.par[PAR.OMEGA] = this.omega;
    this.pIters = 40;
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

  windAt(y) { return 1; }   // ลมเข้าแบบสม่ำเสมอ (ดู GridPrep.windAt)

  #applyMirror() {
    for (const a of ['u', 'v', 'w']) {
      const m = this.mirror[a], f = this[a];
      for (let q = 0; q < m.length; q += 2) f[m[q]] = f[m[q + 1]];
    }
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
    this.k.ex.residual();   // เก็บสนามเริ่มต้นไว้เป็นค่าอ้างอิงของ residual
    this._resetMonitor();
    this.project(80);
  }

  /** Σ การเปลี่ยนแปลง² ของความเร็วและอุณหภูมิเทียบครั้งก่อน (แล้วเก็บค่าปัจจุบันไว้) */
  _residualSums() {
    this.#sync();
    this.k.ex.residual();
    return [this.par[PAR.DU2], this.par[PAR.DT2]];
  }

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
    this._monitor(dt);
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
