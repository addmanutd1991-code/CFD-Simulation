/*
 * solver.js — เครื่องคำนวณ CFD สามมิติ
 *
 * แบบจำลอง: Navier-Stokes แบบอัดตัวไม่ได้ (incompressible) บนกริดสม่ำเสมอ
 *   - Advection      : Semi-Lagrangian (เสถียรทุกขนาด time step)
 *   - Buoyancy       : Boussinesq approximation
 *   - Pressure       : Poisson projection ด้วย Gauss-Seidel
 *   - Energy         : สมการการพาความร้อนของอุณหภูมิ
 *
 * ชนิดของเซลล์ (mask): 0 = อากาศ, 1 = ของแข็ง, 2 = ขอบเปิด (outdoor)
 */

export const FLUID = 0, SOLID = 1, OPEN = 2;

const RHO = 1.2;       // kg/m3
const CP  = 1005;      // J/kg/K
const G   = 9.81;      // m/s2
const BETA = 1 / 293;  // 1/K — สัมประสิทธิ์การขยายตัวเชิงปริมาตรของอากาศ
const NU_T = 0.02;     // m2/s — ความหนืดปั่นป่วนของการไหลในห้อง

export class Solver {
  constructor() {
    this.ambient = 32;
    this.wind = { speed: 0, dirDeg: 0 };
    this.time = 0;
    this.steps = 0;
    this.heats = [];
    this.machines = [];
    this.inlets = [];
    this.resize(2, 2, 2, 1);
  }

  /* ───────── การสร้างโดเมน ───────── */

  /** W,H,D = ขนาดโดเมนเป็นเมตร, h = ขนาดเซลล์ */
  resize(W, H, D, h) {
    this.W = W; this.H = H; this.D = D; this.h = h;
    this.nx = Math.max(5, Math.round(W / h) + 2);
    this.ny = Math.max(5, Math.round(H / h) + 2);
    this.nz = Math.max(5, Math.round(D / h) + 2);
    const n = this.nx * this.ny * this.nz;
    this.n = n;
    this.sy = this.nx;
    this.sz = this.nx * this.ny;

    const F = () => new Float32Array(n);
    this.u = F(); this.v = F(); this.w = F();
    this.u0 = F(); this.v0 = F(); this.w0 = F();
    this.T = F(); this.T0 = F();
    this.p = F(); this.div = F();

    this.mask = new Uint8Array(n);
    this.fmask = new Uint8Array(n);   // 0 = ปกติ, 1 = บังคับความเร็ว (หน้ากริล)
    this.fu = F(); this.fv = F(); this.fw = F();
    this.forcedList = new Int32Array(0);

    this.reset();
  }

  /** ล้างผลการคำนวณ แต่คงรูปทรงและเงื่อนไขขอบไว้ */
  reset() {
    this.u.fill(0); this.v.fill(0); this.w.fill(0);
    this.p.fill(0);
    this.T.fill(this.ambient);
    this.time = 0; this.steps = 0;
    this.maxSpeed = 0;
  }

  idx(i, j, k) { return i + j * this.sy + k * this.sz; }

  /** แปลงพิกัดโลก (เมตร) → ดัชนีเซลล์ (รวมชั้นขอบ) */
  cellI(x) { return Math.min(this.nx - 1, Math.max(0, Math.floor(x / this.h) + 1)); }
  cellJ(y) { return Math.min(this.ny - 1, Math.max(0, Math.floor(y / this.h) + 1)); }
  cellK(z) { return Math.min(this.nz - 1, Math.max(0, Math.floor(z / this.h) + 1)); }

  /** จุดกึ่งกลางเซลล์ในพิกัดโลก */
  cx(i) { return (i - 0.5) * this.h; }
  cy(j) { return (j - 0.5) * this.h; }
  cz(k) { return (k - 0.5) * this.h; }

  /**
   * เริ่มสร้างโดเมนใหม่: กำหนดชั้นขอบตามโหมด แล้วล้างของแข็งภายในทิ้ง
   * openSides = true สำหรับ outdoor (ขอบเปิดให้อากาศไหลผ่านได้)
   */
  beginBuild(openSides) {
    const { nx, ny, nz } = this;
    this.openSides = openSides;
    this.mask.fill(FLUID);
    this.fmask.fill(0);
    this.heats = [];
    this.machines = [];
    this.inlets = [];

    const edge = openSides ? OPEN : SOLID;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const onEdge = i === 0 || i === nx - 1 || j === 0 || j === ny - 1 || k === 0 || k === nz - 1;
          if (!onEdge) continue;
          // พื้นดิน/พื้นห้อง เป็นของแข็งเสมอ
          this.mask[this.idx(i, j, k)] = (j === 0) ? SOLID : edge;
        }
  }

  /** กำหนดเซลล์ภายในกล่อง (พิกัดโลก) ให้เป็นของแข็ง */
  addSolidBox(b) {
    this.forCellsInBox(b, id => { this.mask[id] = SOLID; this.fmask[id] = 0; });
  }

  /** เพิ่มแหล่งความร้อน (วัตต์) กระจายทั่วกล่อง */
  addHeatBox(b, watts) {
    const cells = [];
    this.forCellsInBox(b, id => { if (this.mask[id] !== SOLID) cells.push(id); });
    if (cells.length) this.heats.push({ cells: Int32Array.from(cells), watts });
  }

  /**
   * หน้าจ่ายลม (inlet): กำหนดอุณหภูมิลมที่ออกจากเครื่อง เหมือน inlet boundary ของ CFX
   * พร้อมวัดพลังงานที่การกำหนดค่านี้ใส่เข้า/ดึงออกจากอากาศ เพื่อนำไปหักลบให้สมดุลพลังงานตรงเป๊ะ
   */
  addInlet(cells) {
    const e = { cells, T: null, powerW: 0 };
    this.inlets.push(e);
    return e;
  }

  /** ลงทะเบียนกำลังของเครื่อง (ลบ = ทำความเย็น, บวก = คายความร้อน) */
  addMachine() {
    const e = { watts: 0 };
    this.machines.push(e);
    return e;
  }

  applyInlets(dt) {
    const eCell = RHO * CP * this.h ** 3;
    for (const c of this.inlets) {
      if (c.T == null || !c.cells.length) { c.powerW = 0; continue; }
      let sum = 0;
      for (let i = 0; i < c.cells.length; i++) sum += this.T[c.cells[i]];
      c.powerW = (c.T * c.cells.length - sum) * eCell / dt;
      for (let i = 0; i < c.cells.length; i++) this.T[c.cells[i]] = c.T;
    }
  }

  /** พลังงานความร้อนรวมของอากาศในโดเมน (ไม่นับเซลล์ที่ถูกกำหนดค่าตายตัว) */
  airEnergy() {
    const { mask, fmask, T } = this;
    let s = 0;
    for (let id = 0; id < this.n; id++) if (mask[id] === FLUID && !fmask[id]) s += T[id];
    return s * RHO * CP * this.h ** 3;
  }

  /**
   * บังคับสมดุลพลังงานรวมของโดเมนให้ตรงกับกำลังของอุปกรณ์จริง
   *
   * เหตุผล: semi-Lagrangian เป็นวิธีที่ไม่อนุรักษ์ปริมาณรวม และเงื่อนไขขอบแบบ
   * "กำหนดอุณหภูมิลมจ่าย" ก็ไม่ได้หักพลังงานที่อากาศพาออกทางลมกลับ ผลคือห้อง
   * เย็นลงช้ากว่าที่เครื่องขนาดนั้นทำได้จริงหลายเท่า
   *
   * จึงวัดพลังงานที่เปลี่ยนไปจริงในสเต็ปนั้น เทียบกับที่ควรเป็น (กำลังเครื่อง +
   * ภาระความร้อน) แล้วเกลี่ยส่วนต่างกลับเข้าไป โดยถ่วงน้ำหนักตามความเร็วลม
   * บริเวณที่ลมพัดถึงจึงได้รับผลมาก ส่วนมุมอับลมแทบไม่เปลี่ยน — รูปแบบการกระจาย
   * ที่ได้จาก CFD จึงยังคงอยู่ ขณะที่ระดับอุณหภูมิรวมถูกต้องตามหลักเทอร์โมไดนามิกส์
   */
  balanceEnergy(dt, e0) {
    const { mask, fmask, T, u, v, w } = this;
    let targetW = 0;
    for (const m of this.machines) targetW += m.watts;
    for (const h of this.heats) targetW += h.watts;

    const err = targetW * dt - (this.airEnergy() - e0);
    if (!err) return;

    let wsum = 0;
    for (let id = 0; id < this.n; id++) {
      if (mask[id] !== FLUID || fmask[id]) continue;
      wsum += Math.hypot(u[id], v[id], w[id]) + 0.04;
    }
    if (wsum <= 0) return;
    const k = err / (RHO * CP * this.h ** 3 * wsum);
    for (let id = 0; id < this.n; id++) {
      if (mask[id] !== FLUID || fmask[id]) continue;
      const t = T[id] + k * (Math.hypot(u[id], v[id], w[id]) + 0.04);
      T[id] = t < 2 ? 2 : t > 95 ? 95 : t;
    }
  }

  /**
   * เพิ่มบริเวณที่บังคับความเร็ว (หน้าจ่ายลม / หน้าดูดลมกลับ)
   * b = กล่องพิกัดโลก, dir = ทิศทางลม (หน่วยเวกเตอร์), faceN = เวกเตอร์ตั้งฉากของหน้ากริล
   * flow = อัตราลม (m3/s), physArea = พื้นที่หน้ากริลจริงของอุปกรณ์ (ตร.ม.)
   *
   * บนกริดหยาบ หนึ่งเซลล์มักกว้างกว่าช่องจ่ายลมจริงหลายเท่า ถ้าใช้พื้นที่ของเซลล์
   * ตรง ๆ ความเร็วลมออกจะต่ำเกินจริงจนลมพุ่งไม่ถึงกลางห้องและถูกดูดกลับเข้าเครื่องทันที
   * จึงย่อจำนวนเซลล์ของหน้ากริลลงให้ใกล้พื้นที่จริง — ได้ทั้งอัตราลมและความเร็วลมที่ถูกต้อง
   */
  addFlowRegion(b, dir, faceN, flow, physArea) {
    const cells = [];
    this.forCellsInBox(b, id => cells.push(id));
    if (!cells.length) {                       // กล่องบางกว่า 1 เซลล์ — ใช้เซลล์ที่ใกล้จุดกึ่งกลางที่สุด
      const i = this.cellI((b.x0 + b.x1) / 2), j = this.cellJ((b.y0 + b.y1) / 2), k = this.cellK((b.z0 + b.z1) / 2);
      cells.push(this.idx(i, j, k));
    }

    // ห้ามหน้ากริลไปทับชั้นขอบโดเมน มิฉะนั้นผนังห้องจะถูกเจาะทะลุ
    const ijk = (id) => {
      const k = (id / this.sz) | 0, r = id - k * this.sz, j = (r / this.sy) | 0;
      return [r - j * this.sy, j, k];
    };
    const inner = cells.filter(id => {
      const [i, j, k] = ijk(id);
      return i > 0 && i < this.nx - 1 && j > 0 && j < this.ny - 1 && k > 0 && k < this.nz - 1;
    });
    let use = inner.length ? inner : cells;

    // จัดเซลล์เป็นกลุ่มตามตำแหน่งบนหน้ากริล (ฉายลงระนาบตั้งฉากกับ faceN)
    const ax = Math.abs(faceN[0]), ay = Math.abs(faceN[1]), az = Math.abs(faceN[2]);
    const axis = ax >= ay && ax >= az ? 0 : (ay >= az ? 1 : 2);
    const groups = new Map();
    for (const id of use) {
      const [i, j, k] = ijk(id);
      const key = axis === 0 ? j + k * 4096 : (axis === 1 ? i + k * 4096 : i + j * 4096);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(id);
    }
    const keys = [...groups.keys()].sort((a, b2) => a - b2);
    const cellArea = this.h * this.h;
    const nWant = Math.max(1, Math.min(keys.length, Math.round((physArea || Infinity) / cellArea)));
    if (nWant < keys.length) {
      // คงไว้เท่าพื้นที่จริง โดยกระจายให้ทั่วหน้ากริล
      const stride = keys.length / nWant;
      const pick = [];
      for (let a = 0; a < nWant; a++) pick.push(keys[Math.min(keys.length - 1, Math.floor((a + 0.5) * stride))]);
      use = [...new Set(pick)].flatMap(k => groups.get(k));
    }

    const area = nWant * cellArea;
    // ปรับขนาดความเร็วให้อัตราลมที่ไหลผ่านหน้ากริลตรงกับค่าที่ตั้งไว้
    const dot = Math.abs(dir[0] * faceN[0] + dir[1] * faceN[1] + dir[2] * faceN[2]);
    const mag = Math.min(9, flow / (area * Math.max(0.35, dot)));

    const list = Int32Array.from(use);
    for (const id of list) {
      if (this.mask[id] === OPEN) continue;
      this.mask[id] = FLUID;
      this.fmask[id] = 1;
      this.fu[id] = dir[0] * mag;
      this.fv[id] = dir[1] * mag;
      this.fw[id] = dir[2] * mag;
    }

    return { cells: list, mag, area, flow };
  }

  /** เรียกหลังเพิ่มวัตถุครบแล้ว — สร้างรายการเซลล์ที่ถูกบังคับไว้ล่วงหน้า */
  endBuild() {
    const list = [];
    for (let id = 0; id < this.n; id++) if (this.fmask[id]) list.push(id);
    this.forcedList = Int32Array.from(list);

    // นับเซลล์อากาศไว้ใช้ตอนเฉลี่ยค่า
    let f = 0;
    for (let id = 0; id < this.n; id++) if (this.mask[id] === FLUID) f++;
    this.fluidCount = f;
    this.closed = !this.openSides;
  }

  forCellsInBox(b, fn) {
    const h = this.h;
    const i0 = this.cellI(b.x0 + 1e-6), i1 = this.cellI(b.x1 - 1e-6);
    const j0 = this.cellJ(b.y0 + 1e-6), j1 = this.cellJ(b.y1 - 1e-6);
    const k0 = this.cellK(b.z0 + 1e-6), k1 = this.cellK(b.z1 - 1e-6);
    for (let k = Math.min(k0, k1); k <= Math.max(k0, k1); k++)
      for (let j = Math.min(j0, j1); j <= Math.max(j0, j1); j++)
        for (let i = Math.min(i0, i1); i <= Math.max(i0, i1); i++) {
          // ต้องซ้อนทับกันจริง ไม่ใช่แค่แตะขอบพอดี มิฉะนั้นเซลล์อากาศที่อยู่
          // ติดกับผิวอุปกรณ์จะถูกนับเป็นของแข็งไปด้วย จนหน้ากริลดูดลมไม่เข้า
          const eps = h * 0.02;
          const x0 = (i - 1) * h, y0 = (j - 1) * h, z0 = (k - 1) * h;
          if (x0 >= b.x1 - eps || x0 + h <= b.x0 + eps) continue;
          if (y0 >= b.y1 - eps || y0 + h <= b.y0 + eps) continue;
          if (z0 >= b.z1 - eps || z0 + h <= b.z0 + eps) continue;
          fn(this.idx(i, j, k));
        }
  }

  /** อุณหภูมิเฉลี่ยของกลุ่มเซลล์ (ใช้หาอุณหภูมิลมกลับของแต่ละเครื่อง) */
  avgT(cells) {
    if (!cells || !cells.length) return this.ambient;
    let s = 0;
    for (let i = 0; i < cells.length; i++) s += this.T[cells[i]];
    return s / cells.length;
  }

  /* ───────── การคำนวณหนึ่งสเต็ป ───────── */

  suggestDt() {
    // semi-Lagrangian เสถียรทุกขนาดสเต็ป จึงเดินได้เกิน CFL = 1 เล็กน้อย
    // แลกความละเอียดกับความเร็วในการเข้าสู่สภาวะคงตัว
    const vmax = Math.max(0.25, this.maxSpeed);
    return Math.min(0.05, Math.max(0.005, 1.1 * this.h / vmax));
  }

  step(dt) {
    const e0 = this.airEnergy();
    this.applyForced();
    this.applyBoundaries();
    this.addBuoyancy(dt);
    this.addHeat(dt);
    this.advect(dt);
    this.applyInlets(dt);
    this.applyForced();
    this.applyBoundaries();
    this.project(16);
    this.applyForced();
    this.applyBoundaries();
    this.balanceEnergy(dt, e0);
    this.time += dt;
    this.steps++;
  }

  applyForced() {
    const { forcedList, fu, fv, fw, u, v, w } = this;
    for (let a = 0; a < forcedList.length; a++) {
      const id = forcedList[a];
      u[id] = fu[id]; v[id] = fv[id]; w[id] = fw[id];
    }
  }

  applyBoundaries() {
    const { nx, ny, nz, mask, u, v, w, T } = this;
    // เซลล์ของแข็ง: ความเร็วเป็นศูนย์ (no-slip)
    for (let id = 0; id < this.n; id++) {
      if (mask[id] === SOLID) { u[id] = 0; v[id] = 0; w[id] = 0; }
    }
    if (!this.openSides) return;

    // ขอบเปิด: ลมพัดเข้าตามที่ตั้งไว้ ส่วนด้านที่ลมออกใช้ zero-gradient
    const rad = this.wind.dirDeg * Math.PI / 180;
    const wu = this.wind.speed * Math.sin(rad), ww = -this.wind.speed * Math.cos(rad);
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const id = this.idx(i, j, k);
          if (mask[id] !== OPEN) continue;
          let ni = i, nj = j, nk = k;
          if (i === 0) ni = 1; else if (i === nx - 1) ni = nx - 2;
          if (j === ny - 1) nj = ny - 2;
          if (k === 0) nk = 1; else if (k === nz - 1) nk = nz - 2;
          const nid = this.idx(ni, nj, nk);

          // ด้านต้นลม → กำหนดความเร็วลมภายนอก
          const upwindX = (i === 0 && wu > 0) || (i === nx - 1 && wu < 0);
          const upwindZ = (k === 0 && ww > 0) || (k === nz - 1 && ww < 0);
          if (this.wind.speed > 0.01 && (upwindX || upwindZ)) {
            u[id] = wu; v[id] = 0; w[id] = ww; T[id] = this.ambient;
          } else {
            u[id] = u[nid]; v[id] = v[nid]; w[id] = w[nid];
            const inward = (i === 0 ? u[id] : i === nx - 1 ? -u[id] : 0)
              + (j === ny - 1 ? -v[id] : 0)
              + (k === 0 ? w[id] : k === nz - 1 ? -w[id] : 0);
            T[id] = inward > 0 ? this.ambient : T[nid];
          }
        }
  }

  addBuoyancy(dt) {
    const { mask, T, v } = this;
    // ใช้อุณหภูมิเฉลี่ยของโดเมนเป็นค่าอ้างอิง เพื่อให้แรงลอยตัวเป็นค่าสัมพัทธ์
    let sum = 0, c = 0;
    for (let id = 0; id < this.n; id++) if (mask[id] === FLUID) { sum += T[id]; c++; }
    const Tref = c ? sum / c : this.ambient;
    this.avgTemp = Tref;
    const k = G * BETA * dt;
    for (let id = 0; id < this.n; id++) {
      if (mask[id] !== FLUID || this.fmask[id]) continue;
      v[id] += k * (T[id] - Tref);
    }
  }

  addHeat(dt) {
    const cellVol = this.h ** 3;
    for (const hs of this.heats) {
      if (!hs.watts || !hs.cells.length) continue;
      const dT = hs.watts * dt / (RHO * CP * cellVol * hs.cells.length);
      for (let i = 0; i < hs.cells.length; i++) {
        const id = hs.cells[i];
        // จำกัดช่วงอุณหภูมิ: ต่ำสุดที่คอยล์เย็นทำได้จริง และกันค่าพุ่งที่คอยล์ร้อน
        this.T[id] = Math.min(90, Math.max(6, this.T[id] + dT));
      }
    }
  }

  advect(dt) {
    const { u, v, w, u0, v0, w0, T, T0 } = this;
    u0.set(u); v0.set(v); w0.set(w); T0.set(T);
    this.advectField(u, u0, u0, v0, w0, dt, 1);
    this.advectField(v, v0, u0, v0, w0, dt, 1);
    this.advectField(w, w0, u0, v0, w0, dt, 1);
    this.advectTemp(T, T0, u0, v0, w0, dt);

    this.diffuseVel(dt);

    let mx = 0;
    for (let id = 0; id < this.n; id++) {
      if (this.mask[id] !== FLUID) continue;
      const s = u[id] * u[id] + v[id] * v[id] + w[id] * w[id];
      if (s > mx) mx = s;
    }
    this.maxSpeed = Math.sqrt(mx);
  }

  /**
   * ความหนืดปั่นป่วน (eddy viscosity) ของการไหลในห้อง ~0.02 m²/s
   * ทำให้ลำลมแผ่ตัวและดึงอากาศรอบข้างเข้ามาผสมเหมือนของจริง ความเร็วจึงสลายตาม
   * ระยะทางอย่างสมจริง แทนที่จะพุ่งเป็นลำแคบไปจนสุดห้อง
   */
  diffuseVel(dt) {
    const { nx, ny, nz, h, mask, fmask, u, v, w, u0, v0, w0, sy, sz } = this;
    // สัมประสิทธิ์ชัดแจ้งต้องไม่เกินขีดเสถียรภาพ 1/6
    const a = Math.min(0.16, NU_T * dt / (h * h));
    if (a < 1e-4) return;
    u0.set(u); v0.set(v); w0.set(w);
    for (let k = 1; k < nz - 1; k++)
      for (let j = 1; j < ny - 1; j++) {
        let id = 1 + j * sy + k * sz;
        for (let i = 1; i < nx - 1; i++, id++) {
          if (mask[id] !== FLUID || fmask[id]) continue;
          let su = 0, sv = 0, sw = 0, c = 0;
          const nb = [id - 1, id + 1, id - sy, id + sy, id - sz, id + sz];
          for (let q = 0; q < 6; q++) {
            const m = nb[q];
            // เซลล์ของแข็งมีความเร็วศูนย์อยู่แล้ว จึงให้ผลเป็น no-slip ที่ผิวพอดี
            su += u0[m]; sv += v0[m]; sw += w0[m]; c++;
          }
          u[id] = u0[id] + a * (su - c * u0[id]);
          v[id] = v0[id] + a * (sv - c * v0[id]);
          w[id] = w0[id] + a * (sw - c * w0[id]);
        }
      }
  }

  /** skipFrom: ข้ามเซลล์ที่ fmask >= skipFrom (1 = ทุกเซลล์ที่ถูกบังคับ, 2 = เฉพาะที่บังคับอุณหภูมิ) */
  advectField(dst, src, su, sv, sw, dt, skipFrom) {
    const { nx, ny, nz, h, mask, sy, sz, fmask } = this;
    const dtx = dt / h;
    const xmax = nx - 1.501, ymax = ny - 1.501, zmax = nz - 1.501;
    for (let k = 1; k < nz - 1; k++)
      for (let j = 1; j < ny - 1; j++) {
        let id = 1 + j * sy + k * sz;
        for (let i = 1; i < nx - 1; i++, id++) {
          if (mask[id] !== FLUID || fmask[id] >= skipFrom) continue;
          let x = i - dtx * su[id];
          let y = j - dtx * sv[id];
          let z = k - dtx * sw[id];
          if (x < 0.5) x = 0.5; else if (x > xmax) x = xmax;
          if (y < 0.5) y = 0.5; else if (y > ymax) y = ymax;
          if (z < 0.5) z = 0.5; else if (z > zmax) z = zmax;

          const i0 = x | 0, j0 = y | 0, k0 = z | 0;
          const s1 = x - i0, s0 = 1 - s1;
          const t1 = y - j0, t0 = 1 - t1;
          const r1 = z - k0, r0 = 1 - r1;
          const b = i0 + j0 * sy + k0 * sz;
          dst[id] =
            r0 * (t0 * (s0 * src[b] + s1 * src[b + 1]) + t1 * (s0 * src[b + sy] + s1 * src[b + sy + 1])) +
            r1 * (t0 * (s0 * src[b + sz] + s1 * src[b + sz + 1]) + t1 * (s0 * src[b + sz + sy] + s1 * src[b + sz + sy + 1]));
        }
      }
  }

  /**
   * พาอุณหภูมิแบบไม่ดึงค่าจากเซลล์ของแข็ง
   *
   * ถ้าปล่อยให้ interpolation หยิบอุณหภูมิของผนังมาด้วย ผนังจะกลายเป็นแหล่งความร้อน
   * ที่ไม่มีวันหมด (ค่าถูก "คัดลอก" เข้ามาโดยตัวผนังไม่เย็นลงเลย) ห้องจึงไม่มีวันเย็น
   * การตัดน้ำหนักของเซลล์ของแข็งออกแล้วหารกลับ = ผนังเป็นฉนวนสมบูรณ์ (adiabatic)
   */
  advectTemp(dst, src, su, sv, sw, dt) {
    const { nx, ny, nz, h, mask, sy, sz } = this;
    const dtx = dt / h;
    const xmax = nx - 1.501, ymax = ny - 1.501, zmax = nz - 1.501;
    for (let k = 1; k < nz - 1; k++)
      for (let j = 1; j < ny - 1; j++) {
        let id = 1 + j * sy + k * sz;
        for (let i = 1; i < nx - 1; i++, id++) {
          if (mask[id] !== FLUID) continue;
          let x = i - dtx * su[id];
          let y = j - dtx * sv[id];
          let z = k - dtx * sw[id];
          if (x < 0.5) x = 0.5; else if (x > xmax) x = xmax;
          if (y < 0.5) y = 0.5; else if (y > ymax) y = ymax;
          if (z < 0.5) z = 0.5; else if (z > zmax) z = zmax;

          const i0 = x | 0, j0 = y | 0, k0 = z | 0;
          const s1 = x - i0, s0 = 1 - s1;
          const t1 = y - j0, t0 = 1 - t1;
          const r1 = z - k0, r0 = 1 - r1;
          const b = i0 + j0 * sy + k0 * sz;
          let acc = 0, wsum = 0, w, m;
          m = b;            w = r0 * t0 * s0; if (mask[m] !== SOLID) { acc += w * src[m]; wsum += w; }
          m = b + 1;        w = r0 * t0 * s1; if (mask[m] !== SOLID) { acc += w * src[m]; wsum += w; }
          m = b + sy;       w = r0 * t1 * s0; if (mask[m] !== SOLID) { acc += w * src[m]; wsum += w; }
          m = b + sy + 1;   w = r0 * t1 * s1; if (mask[m] !== SOLID) { acc += w * src[m]; wsum += w; }
          m = b + sz;       w = r1 * t0 * s0; if (mask[m] !== SOLID) { acc += w * src[m]; wsum += w; }
          m = b + sz + 1;   w = r1 * t0 * s1; if (mask[m] !== SOLID) { acc += w * src[m]; wsum += w; }
          m = b + sz + sy;  w = r1 * t1 * s0; if (mask[m] !== SOLID) { acc += w * src[m]; wsum += w; }
          m = b + sz + sy + 1; w = r1 * t1 * s1; if (mask[m] !== SOLID) { acc += w * src[m]; wsum += w; }
          dst[id] = wsum > 1e-4 ? acc / wsum : src[id];
        }
      }
  }

  project(iters) {
    const { nx, ny, nz, h, u, v, w, p, div, mask, fmask, sy, sz } = this;

    // 1) ความแตกต่างของการไหล (divergence)
    let dsum = 0, dcount = 0;
    div.fill(0); p.fill(0);
    for (let k = 1; k < nz - 1; k++)
      for (let j = 1; j < ny - 1; j++) {
        let id = 1 + j * sy + k * sz;
        for (let i = 1; i < nx - 1; i++, id++) {
          if (mask[id] !== FLUID || fmask[id]) continue;
          const d = -0.5 * h * (
            (u[id + 1] - u[id - 1]) +
            (v[id + sy] - v[id - sy]) +
            (w[id + sz] - w[id - sz]));
          div[id] = d; dsum += d; dcount++;
        }
      }
    // โดเมนปิด (indoor) ต้องหักค่าเฉลี่ยออก มิฉะนั้นสมการ Poisson ไม่มีคำตอบ
    if (this.closed && dcount) {
      const m = dsum / dcount;
      for (let id = 0; id < this.n; id++) if (mask[id] === FLUID && !fmask[id]) div[id] -= m;
    }

    // 2) แก้สมการ Poisson ด้วย SOR (Gauss-Seidel + over-relaxation)
    //    ω ราว 1.7 ลู่เข้าเร็วกว่า Gauss-Seidel ล้วนประมาณสองเท่าที่จำนวนรอบเท่ากัน
    const OMEGA = 1.7;
    for (let it = 0; it < iters; it++) {
      for (let k = 1; k < nz - 1; k++)
        for (let j = 1; j < ny - 1; j++) {
          let id = 1 + j * sy + k * sz;
          for (let i = 1; i < nx - 1; i++, id++) {
            if (mask[id] !== FLUID || fmask[id]) continue;
            const c = p[id];
            const xm = mask[id - 1] === OPEN ? 0 : (mask[id - 1] === FLUID && !fmask[id - 1] ? p[id - 1] : c);
            const xp = mask[id + 1] === OPEN ? 0 : (mask[id + 1] === FLUID && !fmask[id + 1] ? p[id + 1] : c);
            const ym = mask[id - sy] === OPEN ? 0 : (mask[id - sy] === FLUID && !fmask[id - sy] ? p[id - sy] : c);
            const yp = mask[id + sy] === OPEN ? 0 : (mask[id + sy] === FLUID && !fmask[id + sy] ? p[id + sy] : c);
            const zm = mask[id - sz] === OPEN ? 0 : (mask[id - sz] === FLUID && !fmask[id - sz] ? p[id - sz] : c);
            const zp = mask[id + sz] === OPEN ? 0 : (mask[id + sz] === FLUID && !fmask[id + sz] ? p[id + sz] : c);
            p[id] = c + OMEGA * ((div[id] + xm + xp + ym + yp + zm + zp) / 6 - c);
          }
        }
    }

    // 3) หักความชันของความดันออกจากความเร็ว
    const inv = 0.5 / h;
    for (let k = 1; k < nz - 1; k++)
      for (let j = 1; j < ny - 1; j++) {
        let id = 1 + j * sy + k * sz;
        for (let i = 1; i < nx - 1; i++, id++) {
          if (mask[id] !== FLUID || fmask[id]) continue;
          u[id] -= inv * (p[id + 1] - p[id - 1]);
          v[id] -= inv * (p[id + sy] - p[id - sy]);
          w[id] -= inv * (p[id + sz] - p[id - sz]);
        }
      }
  }

  /* ───────── การอ่านค่าเพื่อแสดงผล ───────── */

  /** อ่านความเร็วแบบ trilinear ที่พิกัดโลก (สำหรับอนุภาคลม) */
  sampleVel(x, y, z, out) {
    const { h, nx, ny, nz, sy, sz, u, v, w } = this;
    let a = x / h + 0.5, b = y / h + 0.5, c = z / h + 0.5;
    a = Math.min(nx - 1.51, Math.max(0.5, a));
    b = Math.min(ny - 1.51, Math.max(0.5, b));
    c = Math.min(nz - 1.51, Math.max(0.5, c));
    const i0 = a | 0, j0 = b | 0, k0 = c | 0;
    const s1 = a - i0, s0 = 1 - s1, t1 = b - j0, t0 = 1 - t1, r1 = c - k0, r0 = 1 - r1;
    const base = i0 + j0 * sy + k0 * sz;
    const lerp = f =>
      r0 * (t0 * (s0 * f[base] + s1 * f[base + 1]) + t1 * (s0 * f[base + sy] + s1 * f[base + sy + 1])) +
      r1 * (t0 * (s0 * f[base + sz] + s1 * f[base + sz + 1]) + t1 * (s0 * f[base + sz + sy] + s1 * f[base + sz + sy + 1]));
    out[0] = lerp(u); out[1] = lerp(v); out[2] = lerp(w);
    return out;
  }

  isSolidAt(x, y, z) {
    return this.mask[this.idx(this.cellI(x), this.cellJ(y), this.cellK(z))] === SOLID;
  }

  /** สรุปสถิติของเขตที่คนอยู่อาศัย (0.1–1.8 ม.) */
  stats() {
    const { nx, nz, mask, T, u, v, w } = this;
    let tSum = 0, tN = 0, tMin = 1e9, tMax = -1e9;
    let vSum = 0, vMax = 0, comfy = 0, draft = 0;
    const jLo = this.cellJ(0.1), jHi = this.cellJ(Math.min(1.8, this.H - 0.05));
    for (let k = 1; k < nz - 1; k++)
      for (let j = jLo; j <= jHi; j++)
        for (let i = 1; i < nx - 1; i++) {
          const id = this.idx(i, j, k);
          if (mask[id] !== FLUID || this.fmask[id]) continue;
          const t = T[id];
          const s = Math.hypot(u[id], v[id], w[id]);
          tSum += t; tN++;
          if (t < tMin) tMin = t;
          if (t > tMax) tMax = t;
          vSum += s;
          if (s > vMax) vMax = s;
          if (t >= 22 && t <= 26) comfy++;
          if (s > 0.25) draft++;
        }
    if (!tN) return null;
    return {
      avgT: tSum / tN, minT: tMin, maxT: tMax,
      avgV: vSum / tN, maxV: vMax,
      comfortPct: 100 * comfy / tN,
      draftPct: 100 * draft / tN,
      cells: tN,
    };
  }

  /** ดึงข้อมูลระนาบตัดออกมาเป็นอาร์เรย์ 2 มิติ (สำหรับ contour) */
  slice(axis, t, field) {
    const { nx, ny, nz, mask, T, u, v, w } = this;
    const val = (id) => field === 'T' ? T[id] : Math.hypot(u[id], v[id], w[id]);
    let cols, rows, get, pos;
    if (axis === 'Y') {
      const j = Math.max(1, Math.min(ny - 2, 1 + Math.round(t * (ny - 3))));
      cols = nx - 2; rows = nz - 2; pos = this.cy(j);
      get = (a, b) => this.idx(a + 1, j, b + 1);
    } else if (axis === 'X') {
      const i = Math.max(1, Math.min(nx - 2, 1 + Math.round(t * (nx - 3))));
      cols = nz - 2; rows = ny - 2; pos = this.cx(i);
      get = (a, b) => this.idx(i, b + 1, a + 1);
    } else {
      const k = Math.max(1, Math.min(nz - 2, 1 + Math.round(t * (nz - 3))));
      cols = nx - 2; rows = ny - 2; pos = this.cz(k);
      get = (a, b) => this.idx(a + 1, b + 1, k);
    }
    const data = new Float32Array(cols * rows);
    const solid = new Uint8Array(cols * rows);
    let mn = 1e9, mx = -1e9;
    for (let b = 0; b < rows; b++)
      for (let a = 0; a < cols; a++) {
        const id = get(a, b);
        const q = val(id);
        data[a + b * cols] = q;
        solid[a + b * cols] = mask[id] === SOLID ? 1 : 0;
        if (mask[id] === FLUID) { if (q < mn) mn = q; if (q > mx) mx = q; }
      }
    if (mn > mx) { mn = field === 'T' ? this.ambient - 1 : 0; mx = mn + 1; }
    return { cols, rows, data, solid, min: mn, max: mx, pos, axis };
  }
}

export const AIR = { RHO, CP };
