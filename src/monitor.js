/*
 * monitor.js — ส่วนที่ solver ทุกแบบใช้ร่วมกัน (CPU/WebAssembly และ GPU/WebGPU):
 * ประวัติผล บัญชีพลังงาน residual เกณฑ์ลู่เข้า และรายงานผล
 *
 * คลาสลูกต้องมี: mods, amb, rho, cp, perf, time, steps, dt, tMax, vmax, divErr, pIters, nFluid,
 *   nx/ny/nz, threads, modState[], acc และ _residualSums() → [Σ|Δu|², ΣΔT²] ของเซลล์อากาศ
 */

import { modulePerf } from './models.js';

export const SAMPLE_DT = 0.5;  // s — ระยะเก็บประวัติผล

/** เกณฑ์ลู่เข้า — ต้องผ่านทุกข้อต่อเนื่องกัน HOLD ครั้ง (ครั้งละ SAMPLE_DT) */
export const CONV = {
  tMin: 60,          // s — เวลาขั้นต่ำก่อนเริ่มตัดสิน (ให้ลมร้อนเดินทางทั่วโดเมน)
  drift: 0.05,       // K — ค่าเฉลี่ย 10 s ล่าสุดของ T ลมเข้าเทียบ 10 s ก่อนหน้า
  balLo: 0.95, balHi: 1.05,
  mass: 0.01,        // RMS(∇·u)·L / u_max หลัง projection (L = ขนาดเซลล์)
  hold: 6,
};

export class SolverBase {
  _newAcc() { return { t: 0, qIn: 0, qOut: 0, dE: 0, tin: this.mods.map(() => 0), cin: this.mods.map(() => 0) }; }

  /** ล้างประวัติและสถานะการติดตามผล (เรียกตอนเริ่มคำนวณ) */
  _resetMonitor() {
    this.hist = { t: [], tin: this.mods.map(() => []), cin: this.mods.map(() => []), bal: [], res: { mass: [], mom: [], energy: [] } };
    this.hold = 0;
    this.checks = null;
    this.acc = this._newAcc();
    this.nextSample = SAMPLE_DT;
    this.modState = this.mods.map(() => ({ Tin: this.amb, TinMax: this.amb, Cin: 0, Tdis: this.amb, capF: 1, qRej: 0 }));
    this.converged = false;
  }

  _monitor() {
    if (this.time < this.nextSample) return;
    this.nextSample += SAMPLE_DT;
    const acc = this.acc, t = Math.max(1e-9, acc.t);
    const H = this.hist;
    H.t.push(this.time);
    this.mods.forEach((m, mi) => { H.tin[mi].push(acc.tin[mi] / t); H.cin[mi].push(acc.cin[mi] / t); });
    H.bal.push({ qIn: acc.qIn / t, qOut: acc.qOut / t, dE: acc.dE / t });
    this._residuals();
    this.acc = this._newAcc();
    this._checkConvergence();
  }

  /**
   * Residual แบบ CFX (ใช้ดูแนวโน้ม): RMS ของการเปลี่ยนแปลงในช่วง SAMPLE_DT ที่ทำให้ไร้มิติ
   *   mass   = RMS(∇·u)·h / u_max
   *   mom    = RMS(Δu) / u_max
   *   energy = RMS(ΔT) / ΔT_ref   (ΔT_ref = อุณหภูมิลมเป่าเกินอากาศภายนอกสูงสุด)
   */
  _residuals() {
    const [du, dT] = this._residualSums();
    const n = Math.max(1, this.nFluid);
    let dTref = 1;
    for (const st of this.modState) dTref = Math.max(dTref, st.Tdis - this.amb);
    const R = this.hist.res;
    R.mass.push(this.divErr);
    R.mom.push(Math.sqrt(du / (3 * n)) / Math.max(0.5, this.vmax));
    R.energy.push(Math.sqrt(dT / n) / dTref);
  }

  /** ค่าเฉลี่ยของประวัติในช่วงเวลา [t0, t1] */
  _windowMean(arr, t0, t1) {
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

  _checkConvergence() {
    const t = this.time;
    let maxDrift = 0;
    this.mods.forEach((m, mi) => {
      if (!m.active) return;
      const a = this._windowMean(this.hist.tin[mi], t - 10, t);
      const b = this._windowMean(this.hist.tin[mi], t - 20, t - 10);
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
      let Tin = this._windowMean(this.hist.tin[mi], t - win, t);
      let Cin = this._windowMean(this.hist.cin[mi], t - win, t);
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
      vmax: this.vmax, threads: this.threads, backend: this.backend || 'cpu', device: this.deviceName || '', cells: this.nx * this.ny * this.nz,
      modules: mods,
      history: decimate(this.hist, 500),
    };
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
