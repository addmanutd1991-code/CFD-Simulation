/*
 * gpu-solver.js — เครื่องคำนวณ CFD บนการ์ดจอ (WebGPU compute shader)
 *
 * สมการ กริด และเงื่อนไขขอบชุดเดียวกับ solver.js / kernels.c ทุกประการ (ใช้ GridPrep ร่วมกัน)
 * ต่างกันที่การคำนวณ:
 *   - เลขทศนิยม 32 บิตทั้งหมด (CPU ใช้ 64 บิตระหว่างคำนวณ) ผลจึงไม่ตรงกันทุกบิต แต่เท่ากันในเชิงสถิติ
 *     อุณหภูมิเก็บเป็นส่วนเกินจากอากาศภายนอก θ = T − T∞ เพื่อรักษาความละเอียดของเลข 32 บิต
 *   - ทั้งสเต็ป (advection → projection → transport) ส่งให้ GPU เป็นชุดคำสั่งเดียว แล้วอ่านผลรวมขนาดเล็กกลับมา
 *     ครั้งเดียวต่อสเต็ป: สถิติสำหรับเลือก Δt, บัญชีพลังงาน, T ลมเข้ารายโมดูล
 *     ดังนั้น Δt จำนวนสเต็ปย่อย และอุณหภูมิลมเป่าของ CDU ใช้ค่าจากสเต็ปก่อนหน้า (ช้าไปหนึ่งสเต็ป)
 *   - การพาอุณหภูมิคำนวณฟลักซ์หกหน้าต่อเซลล์ (แต่ละหน้าคำนวณจากสองฝั่งด้วยสูตรเดียวกัน → ยังอนุรักษ์)
 *
 * บัฟเฟอร์ต่อเซลล์: ความเร็ว vec4 ×2, (θ, tracer) vec2 ×2, ค่าก่อนหน้า vec4, φ, ∇·u, νt, 1/diag, flags
 *   = 84 ไบต์ + สำเนาสำหรับแสดงผล 28 ไบต์
 */

import { modulePerf, airRho, AIR_CP, DEFAULT_PERF } from './models.js';
import { GridPrep, AXT, SOLID } from './prep.js';
import { SolverBase } from './monitor.js';

const G = 9.81, CS = 0.17, NU_MIN = 2e-3, PR_T = 0.85, CFL_VEL = 1.5, CFL_SCALAR = 0.5;
const RED = 8;                       // ช่องต่อแถว/ต่อชั้นของบัฟเฟอร์ผลรวม
export const GPU_BYTES_PER_CELL = 84 + 28;

/** เบราว์เซอร์นี้มี WebGPU หรือไม่ (ยังไม่รับประกันว่าขอ adapter ได้) */
export const gpuAvailable = () => typeof navigator !== 'undefined' && !!navigator.gpu;

/* ───────── WGSL ───────── */

const PARAMS = /* wgsl */`
struct Params {
  NX: i32, NY: i32, NZ: i32, nx: i32, ny: i32, nz: i32,
  bx: i32, by: i32, bz: i32, lx: i32, ly: i32, lz: i32,
  dt: f32, dts: f32, kb: f32, cs2: f32, numin: f32, omega: f32, ka: f32, pad: f32,
};
struct Mode { a: u32, b: u32, c: u32, d: u32 };
struct PorousFace { c: i32, ku: f32, kv: f32, kw: f32 };
struct InletCell { c: u32, area: f32 };
const T_F = 0; const T_C = 1; const T_D = 2; const T_RD = 3; const T_RDC = 4; const T_WF = 5; const T_PM = 6; const T_PP = 7;
const T_FM = 8; const T_FP = 9; const T_R2 = 10; const T_Q23 = 11; const T_RD2 = 12; const T_CB = 13;
`;

/** ฟังก์ชันช่วยที่ต้องมี binding ชื่อ P, tab, flags */
const HELPERS = /* wgsl */`
fn ax(a: i32, t: i32, i: i32) -> f32 {
  if (a == 0) { return tab[P.bx + t * P.lx + i]; }
  if (a == 1) { return tab[P.by + t * P.ly + i]; }
  return tab[P.bz + t * P.lz + i];
}
fn cidx(i: i32, j: i32, k: i32) -> i32 { return i + j * P.NX + k * P.NX * P.NY; }
fn inGrid(g: vec3<u32>) -> bool { return i32(g.x) < P.NX && i32(g.y) < P.NY && i32(g.z) < P.NZ; }
fn interior(i: i32, j: i32, k: i32) -> bool { return i >= 1 && i <= P.nx && j >= 1 && j <= P.ny && k >= 1 && k <= P.nz; }
fn ftype(c: i32) -> u32 { return flags[c] & 3u; }
fn fixb(c: i32) -> u32 { return (flags[c] >> 2u) & 7u; }
fn pmb(c: i32) -> u32 { return (flags[c] >> 8u) & 63u; }
`;

/** ฟลักซ์ของ (θ, tracer) ต่อหน่วยพื้นที่ที่หน้าระหว่างเซลล์ a (ด้านลบ) กับ c (ด้านบวก, ดัชนี ia ตามแกน) — ดู face_flux ใน kernels.c
 *  คืน (fθ, fC, ความร้อนออกทางขอบเปิด) ต้องมี binding ชื่อ scI, nut */
const FACE = /* wgsl */`
fn face(a: i32, c: i32, st: i32, axis: i32, ia: i32, vf: f32) -> vec3<f32> {
  let ta = ftype(a); let tb = ftype(c);
  let acapk = 0.12 / P.dts;
  if ((ta | tb) == 0u) {
    let sa = scI[a]; let sb = scI[c];
    var s: vec2<f32>;
    if (vf > 0.0) {
      s = sa;
      let m = a - st;
      if (ftype(m) == 0u) {
        let d1 = (sa - scI[m]) * ax(axis, T_RDC, ia - 1); let d2 = (sb - sa) * ax(axis, T_RDC, ia);
        let p = d1 * d2; let ok = p > vec2<f32>(0.0);
        s += ax(axis, T_D, ia - 1) * select(vec2<f32>(0.0), p / select(vec2<f32>(1.0), d1 + d2, ok), ok);
      }
    } else {
      s = sb;
      let m = c + st;
      if (ftype(m) == 0u) {
        let d1 = (sb - scI[m]) * ax(axis, T_RDC, ia + 1); let d2 = (sa - sb) * ax(axis, T_RDC, ia);
        let p = d1 * d2; let ok = p > vec2<f32>(0.0);
        s += ax(axis, T_D, ia) * select(vec2<f32>(0.0), p / select(vec2<f32>(1.0), d1 + d2, ok), ok);
      }
    }
    let r = ax(axis, T_RDC, ia);
    var g = P.ka * (nut[a] + nut[c]) * r;
    if (g * r > acapk) { g = acapk / r; }
    let f = vf * s - g * (sb - sa);
    return vec3<f32>(f, 0.0);
  }
  if (ta != 0u && tb != 0u) { return vec3<f32>(0.0); }
  if (ta == 1u || tb == 1u) {
    if (vf == 0.0) { return vec3<f32>(0.0); }
    var up = c;
    if (vf > 0.0) { up = a; }
    return vec3<f32>(vf * scI[up], 0.0);
  }
  // อากาศ–ขอบเปิด: ลมเข้าเป็นอากาศภายนอก (θ = 0, tracer = 0)
  var fl = c;
  if (ta == 0u) { fl = a; }
  let inflow = (ta == 0u && vf < 0.0) || (ta != 0u && vf > 0.0);
  let s = select(scI[fl], vec2<f32>(0.0), inflow);
  let r = ax(axis, T_RDC, ia);
  var g = 2.0 * P.ka * nut[fl] * r;
  if (g * r > acapk) { g = acapk / r; }
  let grad = select(scI[c], -scI[a], ta == 0u);
  let f = vf * s - g * grad;
  return vec3<f32>(f, select(-f.x, f.x, ta == 0u));
}
`;

const WG3 = '@compute @workgroup_size(8, 4, 4)';

const SHADERS = {
  /* Semi-Lagrangian advection ของความเร็ว + แรงลอยตัว */
  advect: {
    bind: [['P', 'u', 'Params'], ['velI', 'ro', 'array<vec4<f32>>'], ['velO', 'rw', 'array<vec4<f32>>'], ['sc', 'ro', 'array<vec2<f32>>'],
      ['flags', 'ro', 'array<u32>'], ['tab', 'ro', 'array<f32>']],
    code: HELPERS + /* wgsl */`
fn locate(a: i32, tX: i32, tR: i32, rOff: i32, n: i32, p: f32, start: i32) -> vec2<f32> {
  var i = min(start, n - 2);
  while (i > 0 && p < ax(a, tX, i)) { i -= 1; }
  while (i < n - 2 && p >= ax(a, tX, i + 1)) { i += 1; }
  let t = clamp((p - ax(a, tX, i)) * ax(a, tR, i + rOff), 0.0, 1.0);
  return vec2<f32>(f32(i), t);
}
fn tri(comp: i32, lx: vec2<f32>, ly: vec2<f32>, lz: vec2<f32>) -> f32 {
  let sy = P.NX; let sz = P.NX * P.NY;
  let b = i32(lx.x) + i32(ly.x) * sy + i32(lz.x) * sz;
  let a00 = mix(velI[b][comp], velI[b + 1][comp], lx.y);
  let a10 = mix(velI[b + sy][comp], velI[b + sy + 1][comp], lx.y);
  let a01 = mix(velI[b + sz][comp], velI[b + sz + 1][comp], lx.y);
  let a11 = mix(velI[b + sz + sy][comp], velI[b + sz + sy + 1][comp], lx.y);
  return mix(mix(a00, a10, ly.y), mix(a01, a11, ly.y), lz.y);
}
${WG3} fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (!inGrid(g)) { return; }
  let i = i32(g.x); let j = i32(g.y); let k = i32(g.z);
  let sy = P.NX; let sz = P.NX * P.NY; let c = cidx(i, j, k);
  let v0 = velI[c];
  var o = v0;
  let fx = fixb(c);
  let ink = k >= 1 && k <= P.nz; let inj = j >= 1 && j <= P.ny; let ini = i >= 1 && i <= P.nx;
  if (ink && inj && i >= 1 && (fx & 1u) == 0u) {
    let a = ax(0, T_WF, i); let b = 1.0 - a;
    let vv = 0.5 * (b * (velI[c - 1].y + velI[c - 1 + sy].y) + a * (v0.y + velI[c + sy].y));
    let ww = 0.5 * (b * (velI[c - 1].z + velI[c - 1 + sz].z) + a * (v0.z + velI[c + sz].z));
    o.x = tri(0, locate(0, T_F, T_RD, 0, P.NX, ax(0, T_F, i) - P.dt * v0.x, i),
      locate(1, T_C, T_RDC, 1, P.NY, ax(1, T_C, j) - P.dt * vv, j), locate(2, T_C, T_RDC, 1, P.NZ, ax(2, T_C, k) - P.dt * ww, k));
  }
  if (ink && j >= 1 && ini && (fx & 2u) == 0u) {
    let a = ax(1, T_WF, j); let b = 1.0 - a;
    let uu = 0.5 * (b * (velI[c - sy].x + velI[c + 1 - sy].x) + a * (v0.x + velI[c + 1].x));
    let ww = 0.5 * (b * (velI[c - sy].z + velI[c - sy + sz].z) + a * (v0.z + velI[c + sz].z));
    o.y = tri(1, locate(0, T_C, T_RDC, 1, P.NX, ax(0, T_C, i) - P.dt * uu, i),
      locate(1, T_F, T_RD, 0, P.NY, ax(1, T_F, j) - P.dt * v0.y, j), locate(2, T_C, T_RDC, 1, P.NZ, ax(2, T_C, k) - P.dt * ww, k));
    // แรงลอยตัว Boussinesq: g·β·θ ที่หน้า v
    if (j >= 2) { o.y += P.kb * (a * sc[c].x + b * sc[c - sy].x); }
  }
  if (k >= 1 && inj && ini && (fx & 4u) == 0u) {
    let a = ax(2, T_WF, k); let b = 1.0 - a;
    let uu = 0.5 * (b * (velI[c - sz].x + velI[c + 1 - sz].x) + a * (v0.x + velI[c + 1].x));
    let vv = 0.5 * (b * (velI[c - sz].y + velI[c + sy - sz].y) + a * (v0.y + velI[c + sy].y));
    o.z = tri(2, locate(0, T_C, T_RDC, 1, P.NX, ax(0, T_C, i) - P.dt * uu, i),
      locate(1, T_C, T_RDC, 1, P.NY, ax(1, T_C, j) - P.dt * vv, j), locate(2, T_F, T_RD, 0, P.NZ, ax(2, T_F, k) - P.dt * v0.z, k));
  }
  velO[c] = o;
}`,
  },

  /* Smagorinsky: νt = (Cs·Δ)²·|S| */
  turb: {
    bind: [['P', 'u', 'Params'], ['vel', 'ro', 'array<vec4<f32>>'], ['nut', 'rw', 'array<f32>'], ['flags', 'ro', 'array<u32>'], ['tab', 'ro', 'array<f32>']],
    code: HELPERS + /* wgsl */`
// ความเร็วที่กึ่งกลางเซลล์ (ชั้นเงา = 0)
fn cen(i: i32, j: i32, k: i32) -> vec3<f32> {
  if (!interior(i, j, k)) { return vec3<f32>(0.0); }
  let c = cidx(i, j, k);
  return 0.5 * vec3<f32>(vel[c].x + vel[c + 1].x, vel[c].y + vel[c + P.NX].y, vel[c].z + vel[c + P.NX * P.NY].z);
}
${WG3} fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (!inGrid(g)) { return; }
  let i = i32(g.x); let j = i32(g.y); let k = i32(g.z);
  let c = cidx(i, j, k);
  if (!interior(i, j, k) || ftype(c) != 0u) { nut[c] = 0.0; return; }
  let sy = P.NX; let sz = P.NX * P.NY;
  let v = vel[c];
  let xp = cen(i + 1, j, k); let xm = cen(i - 1, j, k); let yp = cen(i, j + 1, k); let ym = cen(i, j - 1, k);
  let zp = cen(i, j, k + 1); let zm = cen(i, j, k - 1);
  let jx = ax(0, T_R2, i); let jy = ax(1, T_R2, j); let jz = ax(2, T_R2, k);
  let dudx = (vel[c + 1].x - v.x) * ax(0, T_RD, i); let dvdy = (vel[c + sy].y - v.y) * ax(1, T_RD, j); let dwdz = (vel[c + sz].z - v.z) * ax(2, T_RD, k);
  let a = (yp.x - ym.x) * jy + (xp.y - xm.y) * jx;
  let b = (zp.x - zm.x) * jz + (xp.z - xm.z) * jx;
  let e = (zp.y - zm.y) * jz + (yp.z - ym.z) * jy;
  let S = sqrt(2.0 * (dudx * dudx + dvdy * dvdy + dwdz * dwdz) + a * a + b * b + e * e);
  let nu = P.numin + P.cs2 * ax(0, T_Q23, i) * ax(1, T_Q23, j) * ax(2, T_Q23, k) * S;
  let cap = 0.42 / (P.dt * (ax(0, T_RD2, i) + ax(1, T_RD2, j) + ax(2, T_RD2, k)));
  nut[c] = min(nu, cap);
}`,
  },

  /* การแพร่ของความเร็ว (explicit) */
  diffuse: {
    bind: [['P', 'u', 'Params'], ['velI', 'ro', 'array<vec4<f32>>'], ['velO', 'rw', 'array<vec4<f32>>'], ['nut', 'ro', 'array<f32>'],
      ['flags', 'ro', 'array<u32>'], ['tab', 'ro', 'array<f32>']],
    code: HELPERS + /* wgsl */`
${WG3} fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (!inGrid(g)) { return; }
  let i = i32(g.x); let j = i32(g.y); let k = i32(g.z);
  let sy = P.NX; let sz = P.NX * P.NY; let c = cidx(i, j, k);
  let q = velI[c];
  let fx = fixb(c);
  if (i < 2 || i > P.nx - 1 || j < 2 || j > P.ny - 1 || k < 2 || k > P.nz - 1 || fx == 7u) { velO[c] = q; return; }
  let xm = velI[c - 1] - q; let xp = velI[c + 1] - q; let ym = velI[c - sy] - q; let yp = velI[c + sy] - q;
  let zm = velI[c - sz] - q; let zp = velI[c + sz] - q;
  let cxm = ax(0, T_PM, i); let cxp = ax(0, T_PP, i); let cym = ax(1, T_PM, j); let cyp = ax(1, T_PP, j);
  let czm = ax(2, T_PM, k); let czp = ax(2, T_PP, k);
  let nc = nut[c];
  var o = q;
  if ((fx & 1u) == 0u) {
    o.x = q.x + P.dt * 0.5 * (nc + nut[c - 1]) * (ax(0, T_FM, i) * xm.x + ax(0, T_FP, i) * xp.x + cym * ym.x + cyp * yp.x + czm * zm.x + czp * zp.x);
  }
  if ((fx & 2u) == 0u) {
    o.y = q.y + P.dt * 0.5 * (nc + nut[c - sy]) * (cxm * xm.y + cxp * xp.y + ax(1, T_FM, j) * ym.y + ax(1, T_FP, j) * yp.y + czm * zm.y + czp * zp.y);
  }
  if ((fx & 4u) == 0u) {
    o.z = q.z + P.dt * 0.5 * (nc + nut[c - sz]) * (cxm * xm.z + cxp * xp.z + cym * ym.z + cyp * yp.z + ax(2, T_FM, k) * zm.z + ax(2, T_FP, k) * zp.z);
  }
  velO[c] = o;
}`,
  },

  /* ความต้านทานของ louver: du/dt = −k·|u|·u (implicit) — ข้ามหน้าที่ถูกกำหนดความเร็ว */
  porous: {
    bind: [['P', 'u', 'Params'], ['vel', 'rw', 'array<vec4<f32>>'], ['plist', 'ro', 'array<PorousFace>'], ['flags', 'ro', 'array<u32>']],
    code: /* wgsl */`
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= arrayLength(&plist)) { return; }
  let e = plist[g.x];
  let c = e.c;
  if (c < 0) { return; }
  let fx = (flags[c] >> 2u) & 7u;
  var v = vel[c];
  if (e.ku > 0.0 && (fx & 1u) == 0u) { v.x = v.x / (1.0 + P.dt * e.ku * abs(v.x)); }
  if (e.kv > 0.0 && (fx & 2u) == 0u) { v.y = v.y / (1.0 + P.dt * e.kv * abs(v.y)); }
  if (e.kw > 0.0 && (fx & 4u) == 0u) { v.z = v.z / (1.0 + P.dt * e.kw * abs(v.z)); }
  vel[c] = v;
}`,
  },

  /* ขอบสมมาตร: ความเร็วแนวขนานในชั้นเงา = ค่าของเซลล์ต้นทาง */
  mirror: {
    bind: [['vel', 'rw', 'array<vec4<f32>>'], ['mlist', 'ro', 'array<vec4<i32>>']],
    code: /* wgsl */`
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= arrayLength(&mlist)) { return; }
  let e = mlist[g.x];
  if (e.x < 0) { return; }
  var v = vel[e.x];
  if (e.y >= 0) { v.x = vel[e.y].x; }
  if (e.z >= 0) { v.y = vel[e.z].y; }
  if (e.w >= 0) { v.z = vel[e.w].z; }
  vel[e.x] = v;
}`,
  },

  /* ∇·u ของเซลล์อากาศ */
  div: {
    bind: [['P', 'u', 'Params'], ['vel', 'ro', 'array<vec4<f32>>'], ['rhs', 'rw', 'array<f32>'], ['flags', 'ro', 'array<u32>'], ['tab', 'ro', 'array<f32>']],
    code: HELPERS + /* wgsl */`
${WG3} fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (!inGrid(g)) { return; }
  let i = i32(g.x); let j = i32(g.y); let k = i32(g.z);
  let c = cidx(i, j, k);
  if (!interior(i, j, k) || ftype(c) != 0u) { return; }
  let v = vel[c];
  rhs[c] = (vel[c + 1].x - v.x) * ax(0, T_RD, i) + (vel[c + P.NX].y - v.y) * ax(1, T_RD, j) + (vel[c + P.NX * P.NY].z - v.z) * ax(2, T_RD, k);
}`,
  },

  /* Red–Black SOR หนึ่งสี (M.a = สี) — วนเฉพาะเซลล์ของสีนั้น */
  sor: {
    bind: [['P', 'u', 'Params'], ['M', 'u', 'Mode'], ['phi', 'rw', 'array<f32>'], ['rhs', 'ro', 'array<f32>'], ['idg', 'ro', 'array<f32>'],
      ['flags', 'ro', 'array<u32>'], ['tab', 'ro', 'array<f32>']],
    code: HELPERS + /* wgsl */`
${WG3} fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let j = i32(g.y); let k = i32(g.z);
  let i = 2 * i32(g.x) + ((j + k + i32(M.a)) & 1);
  if (!interior(i, j, k)) { return; }
  let c = cidx(i, j, k);
  let m = pmb(c);
  if (m == 0u) { return; }
  let sy = P.NX; let sz = P.NX * P.NY;
  var s = 0.0;
  if ((m & 1u) != 0u) { s += ax(0, T_PM, i) * phi[c - 1]; }
  if ((m & 2u) != 0u) { s += ax(0, T_PP, i) * phi[c + 1]; }
  if ((m & 4u) != 0u) { s += ax(1, T_PM, j) * phi[c - sy]; }
  if ((m & 8u) != 0u) { s += ax(1, T_PP, j) * phi[c + sy]; }
  if ((m & 16u) != 0u) { s += ax(2, T_PM, k) * phi[c - sz]; }
  if ((m & 32u) != 0u) { s += ax(2, T_PP, k) * phi[c + sz]; }
  let p = phi[c];
  phi[c] = p + P.omega * ((s - rhs[c]) * idg[c] - p);
}`,
  },

  /* u ← u − ∇φ บนหน้าที่ไม่ถูกกำหนดความเร็ว (φ ของเซลล์ขอบเปิด/ของแข็ง = 0) */
  correct: {
    bind: [['P', 'u', 'Params'], ['vel', 'rw', 'array<vec4<f32>>'], ['phi', 'ro', 'array<f32>'], ['flags', 'ro', 'array<u32>'], ['tab', 'ro', 'array<f32>']],
    code: HELPERS + /* wgsl */`
${WG3} fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (!inGrid(g)) { return; }
  let i = i32(g.x); let j = i32(g.y); let k = i32(g.z);
  let c = cidx(i, j, k);
  let fx = fixb(c);
  if (fx == 7u) { return; }
  let p = phi[c];
  var v = vel[c];
  if (i >= 1 && (fx & 1u) == 0u) { v.x -= (p - phi[c - 1]) * ax(0, T_RDC, i); }
  if (j >= 1 && (fx & 2u) == 0u) { v.y -= (p - phi[c - P.NX]) * ax(1, T_RDC, j); }
  if (k >= 1 && (fx & 4u) == 0u) { v.z -= (p - phi[c - P.NX * P.NY]) * ax(2, T_RDC, k); }
  vel[c] = v;
}`,
  },

  /* ∇·u ที่เหลือหลัง projection (เก็บลง rhs) + สถิติต่อแถว (j, k):
   * 0 max|u| 1 max|v| 2 max|w| 3 max อัตรา CFL 4 max อัตราไหลออกรวม 5 Σ(∇·u·L)² */
  statsRow: {
    bind: [['P', 'u', 'Params'], ['vel', 'ro', 'array<vec4<f32>>'], ['rhs', 'rw', 'array<f32>'], ['flags', 'ro', 'array<u32>'], ['tab', 'ro', 'array<f32>'],
      ['row', 'rw', 'array<f32>']],
    code: HELPERS + /* wgsl */`
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let j = i32(g.x); let k = i32(g.y);
  if (j >= P.NY || k >= P.NZ) { return; }
  var mx = vec4<f32>(0.0); var mo = 0.0; var e2 = 0.0;
  if (j >= 1 && j <= P.ny && k >= 1 && k <= P.nz) {
    let sy = P.NX; let sz = P.NX * P.NY;
    let iy = ax(1, T_RD, j); let iz = ax(2, T_RD, k); let lyz = ax(1, T_CB, j) * ax(2, T_CB, k);
    for (var i = 1; i <= P.nx; i++) {
      let c = cidx(i, j, k);
      if (ftype(c) != 0u) { continue; }
      let ix = ax(0, T_RD, i);
      let m = vel[c].xyz; let p = vec3<f32>(vel[c + 1].x, vel[c + sy].y, vel[c + sz].z);
      let a = abs(m); let r = vec3<f32>(ix, iy, iz);
      mx = max(mx, vec4<f32>(a, max(a.x * ix, max(a.y * iy, a.z * iz))));
      let d = dot(p - m, r);
      rhs[c] = d;
      mo = max(mo, dot(max(p, vec3<f32>(0.0)) - min(m, vec3<f32>(0.0)), r));
      let e = d * ax(0, T_CB, i) * lyz;
      e2 += e * e;
    }
  }
  let o = (j + k * P.NY) * ${RED};
  row[o] = mx.x; row[o + 1] = mx.y; row[o + 2] = mx.z; row[o + 3] = mx.w; row[o + 4] = mo; row[o + 5] = e2; row[o + 6] = 0.0; row[o + 7] = 0.0;
}`,
  },

  /* รวมผลต่อแถวเป็นต่อชั้น k: ช่อง 0..M.a-1 ใช้ค่าสูงสุด ที่เหลือใช้ผลรวม */
  reduce: {
    bind: [['P', 'u', 'Params'], ['M', 'u', 'Mode'], ['row', 'ro', 'array<f32>'], ['kred', 'rw', 'array<f32>']],
    code: /* wgsl */`
@compute @workgroup_size(16) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let k = i32(g.x);
  if (k >= P.NZ) { return; }
  var acc: array<f32, ${RED}>;
  for (var s = 0; s < ${RED}; s++) { acc[s] = 0.0; }
  for (var j = 0; j < P.NY; j++) {
    let o = (j + k * P.NY) * ${RED};
    for (var s = 0; s < ${RED}; s++) {
      if (u32(s) < M.a) { acc[s] = max(acc[s], row[o + s]); } else { acc[s] += row[o + s]; }
    }
  }
  for (var s = 0; s < ${RED}; s++) { kred[k * ${RED} + s] = acc[s]; }
}`,
  },

  /* เซลล์ทึบใต้หน้าพัดลมเก็บสภาวะลมเป่า (θ ลมเป่า, tracer = 1) */
  fan: {
    bind: [['sc', 'rw', 'array<vec2<f32>>'], ['flist', 'ro', 'array<vec2<u32>>'], ['tdis', 'ro', 'array<f32>']],
    code: /* wgsl */`
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= arrayLength(&flist)) { return; }
  let e = flist[g.x];
  if (e.x == 0xffffffffu) { return; }
  sc[e.x] = vec2<f32>(tdis[e.y], 1.0);
}`,
  },

  /* การพา (θ, tracer): finite volume, MUSCL + van Leer */
  transport: {
    bind: [['P', 'u', 'Params'], ['scI', 'ro', 'array<vec2<f32>>'], ['scO', 'rw', 'array<vec2<f32>>'], ['vel', 'ro', 'array<vec4<f32>>'],
      ['nut', 'ro', 'array<f32>'], ['rhs', 'ro', 'array<f32>'], ['flags', 'ro', 'array<u32>'], ['tab', 'ro', 'array<f32>']],
    code: HELPERS + FACE + /* wgsl */`
${WG3} fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (!inGrid(g)) { return; }
  let i = i32(g.x); let j = i32(g.y); let k = i32(g.z);
  let c = cidx(i, j, k);
  let s0 = scI[c];
  if (!interior(i, j, k) || ftype(c) != 0u) { scO[c] = s0; return; }
  let sy = P.NX; let sz = P.NX * P.NY;
  let v = vel[c];
  let fxm = face(c - 1, c, 1, 0, i, v.x).xy; let fxp = face(c, c + 1, 1, 0, i + 1, vel[c + 1].x).xy;
  let fym = face(c - sy, c, sy, 1, j, v.y).xy; let fyp = face(c, c + sy, sy, 1, j + 1, vel[c + sy].y).xy;
  let fzm = face(c - sz, c, sz, 2, k, v.z).xy; let fzp = face(c, c + sz, sz, 2, k + 1, vel[c + sz].z).xy;
  // + S·(∇·u) ชดเชยความคลาดเคลื่อนของมวลที่เหลือจาก projection
  var s = s0 + P.dts * ((fxm - fxp) * ax(0, T_RD, i) + (fym - fyp) * ax(1, T_RD, j) + (fzm - fzp) * ax(2, T_RD, k) + s0 * rhs[c]);
  s = clamp(s, vec2<f32>(-2.0, 0.0), vec2<f32>(70.0, 1.0));
  scO[c] = s;
}`,
  },

  /* บัญชีพลังงานต่อแถว: 0 = ความร้อนออกทางขอบเปิด (K·m³/s), 1 = Σ Δθ·ปริมาตร — สะสมข้ามสเต็ปย่อย (M.a = 1 เริ่มใหม่) */
  energyRow: {
    bind: [['P', 'u', 'Params'], ['M', 'u', 'Mode'], ['scI', 'ro', 'array<vec2<f32>>'], ['scO', 'ro', 'array<vec2<f32>>'], ['vel', 'ro', 'array<vec4<f32>>'],
      ['nut', 'ro', 'array<f32>'], ['flags', 'ro', 'array<u32>'], ['tab', 'ro', 'array<f32>'], ['row', 'rw', 'array<f32>']],
    code: HELPERS + FACE + /* wgsl */`
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let j = i32(g.x); let k = i32(g.y);
  if (j >= P.NY || k >= P.NZ) { return; }
  var q = 0.0; var dE = 0.0;
  if (j >= 1 && j <= P.ny && k >= 1 && k <= P.nz) {
    let sy = P.NX; let sz = P.NX * P.NY;
    let dy = ax(1, T_D, j); let dz = ax(2, T_D, k);
    for (var i = 1; i <= P.nx; i++) {
      let c = cidx(i, j, k);
      if (ftype(c) != 0u) { continue; }
      let dx = ax(0, T_D, i);
      dE += (scO[c].x - scI[c].x) * dx * dy * dz;
      if (ftype(c - 1) == 2u) { q += face(c - 1, c, 1, 0, i, vel[c].x).z * dy * dz; }
      if (ftype(c + 1) == 2u) { q += face(c, c + 1, 1, 0, i + 1, vel[c + 1].x).z * dy * dz; }
      if (ftype(c - sy) == 2u) { q += face(c - sy, c, sy, 1, j, vel[c].y).z * dx * dz; }
      if (ftype(c + sy) == 2u) { q += face(c, c + sy, sy, 1, j + 1, vel[c + sy].y).z * dx * dz; }
      if (ftype(c - sz) == 2u) { q += face(c - sz, c, sz, 2, k, vel[c].z).z * dx * dy; }
      if (ftype(c + sz) == 2u) { q += face(c, c + sz, sz, 2, k + 1, vel[c + sz].z).z * dx * dy; }
    }
  }
  let o = (j + k * P.NY) * ${RED};
  if (M.a == 1u) { row[o] = q; row[o + 1] = dE; for (var s = 2; s < ${RED}; s++) { row[o + s] = 0.0; } }
  else { row[o] += q; row[o + 1] += dE; }
}`,
  },

  /* θ ลมเข้าเฉลี่ยถ่วงพื้นที่หน้าคอยล์ของแต่ละโมดูล: (θ, tracer, θ สูงสุด, 0) */
  units: {
    bind: [['sc', 'ro', 'array<vec2<f32>>'], ['inl', 'ro', 'array<InletCell>'], ['mtab', 'ro', 'array<vec2<u32>>'], ['mout', 'rw', 'array<vec4<f32>>']],
    code: /* wgsl */`
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= arrayLength(&mtab)) { return; }
  let m = mtab[g.x];
  var s = vec2<f32>(0.0); var sa = 0.0; var mx = -1e9;
  for (var a = m.x; a < m.x + m.y; a++) {
    let e = inl[a];
    let v = sc[e.c];
    s += v * e.area; sa += e.area; mx = max(mx, v.x);
  }
  if (sa > 0.0) { mout[g.x] = vec4<f32>(s / sa, mx, 1.0); } else { mout[g.x] = vec4<f32>(0.0); }
}`,
  },

  /* Residual ต่อแถว: 0 = Σ|Δu|², 1 = ΣΔθ² ของเซลล์อากาศ เทียบค่าที่เก็บไว้ แล้วเก็บค่าปัจจุบัน */
  residRow: {
    bind: [['P', 'u', 'Params'], ['vel', 'ro', 'array<vec4<f32>>'], ['sc', 'ro', 'array<vec2<f32>>'], ['prev', 'rw', 'array<vec4<f32>>'],
      ['flags', 'ro', 'array<u32>'], ['row', 'rw', 'array<f32>']],
    code: /* wgsl */`
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let j = i32(g.x); let k = i32(g.y);
  if (j >= P.NY || k >= P.NZ) { return; }
  var du = 0.0; var dT = 0.0;
  for (var i = 0; i < P.NX; i++) {
    let c = i + j * P.NX + k * P.NX * P.NY;
    let now = vec4<f32>(vel[c].xyz, sc[c].x);
    if ((flags[c] & 3u) == 0u) {
      let d = now - prev[c];
      du += dot(d.xyz, d.xyz); dT += d.w * d.w;
    }
    prev[c] = now;
  }
  let o = (j + k * P.NY) * ${RED};
  row[o] = du; row[o + 1] = dT;
  for (var s = 2; s < ${RED}; s++) { row[o + s] = 0.0; }
}`,
  },
};

function shaderSource(def) {
  const decl = def.bind.map(([name, kind, type], b) => kind === 'u'
    ? `@group(0) @binding(${b}) var<uniform> ${name}: ${type};`
    : `@group(0) @binding(${b}) var<storage, ${kind === 'rw' ? 'read_write' : 'read'}> ${name}: ${type};`).join('\n');
  return PARAMS + decl + '\n' + def.code;
}

/* ───────── ตัวคำนวณ ───────── */

export class GpuSolver extends SolverBase {
  /** สร้างและเตรียมพร้อม (asynchronous) — โยนข้อผิดพลาดถ้าใช้ WebGPU ไม่ได้หรือหน่วยความจำการ์ดจอไม่พอ */
  static async create(mesh, params) {
    if (!gpuAvailable()) throw new Error('เบราว์เซอร์นี้ไม่มี WebGPU');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('ไม่พบการ์ดจอที่ใช้ WebGPU ได้');
    const need = mesh.N * 16;
    const L = adapter.limits;
    if (L.maxBufferSize < need || L.maxStorageBufferBindingSize < need) {
      throw new Error(`เมชใหญ่เกินขีดจำกัดบัฟเฟอร์ของการ์ดจอนี้ (ต้องการ ${(need / 2 ** 20).toFixed(0)} MB ต่อบัฟเฟอร์)`);
    }
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxBufferSize: Math.max(need, 268435456),
        maxStorageBufferBindingSize: Math.max(need, 134217728),
        maxStorageBuffersPerShaderStage: 8,
      },
    });
    const info = adapter.info || {};
    const s = new GpuSolver(mesh, params, device);
    s.deviceName = [info.vendor, info.device || info.architecture, info.description].filter(Boolean).join(' ') || 'WebGPU';
    s.software = !!(adapter.isFallbackAdapter || info.isFallbackAdapter || /swiftshader|llvmpipe|software/i.test(s.deviceName));
    try {
      await s.#init();
    } catch (err) {
      s.dispose();
      throw err;
    }
    return s;
  }

  constructor(mesh, params, device) {
    super();
    Object.assign(this, {
      nx: mesh.nx, ny: mesh.ny, nz: mesh.nz, h: mesh.h,
      NX: mesh.NX, NY: mesh.NY, NZ: mesh.NZ, N: mesh.N, sy: mesh.sy, sz: mesh.sz,
    });
    this.backend = 'gpu'; this.threads = 0;
    this.device = device;
    this.mesh = mesh;
    this.mods = mesh.modules;
    this.units = mesh.units;
    this.amb = params.ambient;
    this.perf = { ...DEFAULT_PERF, ...(params.perf || {}) };
    this.windSpeed = params.windSpeed || 0;
    const wr = (params.windDir || 0) * Math.PI / 180;
    this.wx = -Math.sin(wr) * this.windSpeed;
    this.wz = Math.cos(wr) * this.windSpeed;
    this.tMax = params.tMax || 1800;
    this.rho = airRho(this.amb);
    this.cp = AIR_CP;
    this.beta = 1 / (this.amb + 273.15);
    this.lost = null;
    device.lost.then((e) => { if (!this.disposed) this.lost = e?.message || 'การ์ดจอหยุดทำงาน'; });
  }

  dispose() {
    this.disposed = true;
    try { this.device?.destroy(); } catch { /* ignore */ }
  }

  /* ───────── การเตรียมบัฟเฟอร์และ pipeline ───────── */

  #buffer(size, usage, data) {
    const b = this.device.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage });
    if (data) this.#upload(b, data);
    return b;
  }

  #upload(buf, data) {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const CH = 1 << 26;   // ส่งทีละ 64 MB
    for (let o = 0; o < bytes.length; o += CH) this.device.queue.writeBuffer(buf, o, bytes, o, Math.min(CH, bytes.length - o));
  }

  async #init() {
    const { device, N, NX, NY, NZ, mesh } = this;
    const U = GPUBufferUsage;
    const ST = U.STORAGE | U.COPY_SRC | U.COPY_DST;
    const prep = new GridPrep(mesh, { speed: this.windSpeed, wx: this.wx, wz: this.wz });
    Object.assign(this, { nFluid: prep.nFluid, omega: prep.omega, fanRate: prep.fanRate, fanVmax: prep.fanVmax });
    this.pIters = 40;

    // flags: ชนิดเซลล์ (2 บิต) | หน้าที่ถูกกำหนดความเร็ว (3 บิต) << 2 | หน้าอิสระหกด้าน << 8
    const flags = new Uint32Array(N);
    for (let c = 0; c < N; c++) flags[c] = mesh.type[c] | (prep.fx[c] << 2) | (prep.pm[c] << 8);

    // ตารางต่อแกน (float32) ต่อกันเป็นบัฟเฟอร์เดียว
    const tabLen = prep.axes.reduce((a, x) => a + x.t.length, 0);
    const tab = new Float32Array(tabLen);
    const base = [];
    let off = 0;
    for (const a of prep.axes) { base.push(off); tab.set(a.t, off); off += a.t.length; }

    // สนามเริ่มต้น: ความเร็วที่ถูกกำหนด + สนามลมธรรมชาติ, θ = 0
    const vel = new Float32Array(4 * N);
    const fl = prep.fixList;
    for (let q = 0; q < fl.u.idx.length; q++) vel[4 * fl.u.idx[q]] = fl.u.val[q];
    for (let q = 0; q < fl.v.idx.length; q++) vel[4 * fl.v.idx[q] + 1] = fl.v.val[q];
    for (let q = 0; q < fl.w.idx.length; q++) vel[4 * fl.w.idx[q] + 2] = fl.w.val[q];
    if (this.windSpeed > 0.01) {
      for (let c = 0; c < N; c++) {
        const f = prep.fx[c];
        if (!(f & 1)) vel[4 * c] = this.wx;
        if (!(f & 4)) vel[4 * c + 2] = this.wz;
      }
    }

    // louver: (ดัชนีเซลล์, ku, kv, kw)
    const P = prep.porous, np = Math.max(1, P.idx.length);
    const plist = new Float32Array(4 * np), pI = new Int32Array(plist.buffer);
    pI[0] = -1;
    for (let a = 0; a < P.idx.length; a++) { pI[4 * a] = P.idx[a]; plist[4 * a + 1] = P.ku[a]; plist[4 * a + 2] = P.kv[a]; plist[4 * a + 3] = P.kw[a]; }

    // ขอบสมมาตร: ไล่คู่ (เงา ← ใน) ตามลำดับเดียวกับ CPU แล้วเก็บต้นทางสุดท้ายของแต่ละเซลล์เงา
    const mm = new Map();
    ['u', 'v', 'w'].forEach((a, ci) => {
      const pairs = prep.mirror[a], src = new Map();
      for (let q = 0; q < pairs.length; q += 2) src.set(pairs[q], src.get(pairs[q + 1]) ?? pairs[q + 1]);
      for (const [g, s] of src) { if (!mm.has(g)) mm.set(g, [g, -1, -1, -1]); mm.get(g)[ci + 1] = s; }
    });
    const mlist = new Int32Array(4 * Math.max(1, mm.size)).fill(-1);
    let q = 0;
    for (const e of mm.values()) { mlist.set(e, 4 * q); q++; }
    this.nMirror = mm.size;

    // CDU: รายการเซลล์หน้าคอยล์ (ดัชนี, พื้นที่), ตารางโมดูล (เริ่ม, จำนวน), เซลล์ใต้พัดลม (ดัชนี, โมดูล)
    const M = this.mods.length, nIn = this.mods.reduce((a, m) => a + (m.active ? m.inCells.length : 0), 0);
    const inl = new Float32Array(2 * Math.max(1, nIn)), inlU = new Uint32Array(inl.buffer);
    const mtab = new Uint32Array(2 * Math.max(1, M));
    const nFan = this.mods.reduce((a, m) => a + (m.active ? m.fanCells.length : 0), 0);
    const flist = new Uint32Array(2 * Math.max(1, nFan)).fill(0xffffffff);
    let io = 0, fo = 0;
    this.mods.forEach((m, mi) => {
      mtab[2 * mi] = io;
      if (!m.active) return;
      for (let a = 0; a < m.inCells.length; a++) { inlU[2 * io] = m.inCells[a]; inl[2 * io + 1] = m.inArea[a]; io++; }
      mtab[2 * mi + 1] = m.inCells.length;
      for (let a = 0; a < m.fanCells.length; a++) { flist[2 * fo] = m.fanCells[a]; flist[2 * fo + 1] = mi; fo++; }
    });
    this.nFan = nFan;

    const B = this.buf = {
      velA: this.#buffer(16 * N, ST, vel), velB: this.#buffer(16 * N, ST),
      scA: this.#buffer(8 * N, ST), scB: this.#buffer(8 * N, ST),
      prev: this.#buffer(16 * N, ST),
      phi: this.#buffer(4 * N, ST), rhs: this.#buffer(4 * N, ST), nut: this.#buffer(4 * N, ST),
      idg: this.#buffer(4 * N, ST, prep.idg), flags: this.#buffer(4 * N, ST, flags),
      tab: this.#buffer(4 * tabLen, ST, tab),
      plist: this.#buffer(plist.byteLength, ST, plist), mlist: this.#buffer(mlist.byteLength, ST, mlist),
      inl: this.#buffer(inl.byteLength, ST, inl), mtab: this.#buffer(mtab.byteLength, ST, mtab), flist: this.#buffer(flist.byteLength, ST, flist),
      tdis: this.#buffer(4 * Math.max(1, M), ST), mout: this.#buffer(16 * Math.max(1, M), ST),
      rowS: this.#buffer(4 * RED * NY * NZ, ST), rowE: this.#buffer(4 * RED * NY * NZ, ST), rowR: this.#buffer(4 * RED * NY * NZ, ST),
      kS: this.#buffer(4 * RED * NZ, ST), kE: this.#buffer(4 * RED * NZ, ST), kR: this.#buffer(4 * RED * NZ, ST),
      P: this.#buffer(80, U.UNIFORM | U.COPY_DST),
    };
    // ค่าคงที่ขนาดเล็กของแต่ละรอบ (สี SOR, เริ่มสะสมใหม่, จำนวนช่องที่ใช้ค่าสูงสุด)
    this.mode = {};
    for (const v of [0, 1, 5]) this.mode[v] = this.#buffer(16, U.UNIFORM | U.COPY_DST, new Uint32Array([v, 0, 0, 0]));
    this.resLen = 3 * RED * NZ + 4 * Math.max(1, M);
    this.staging = this.#buffer(4 * this.resLen, U.MAP_READ | U.COPY_DST);
    {
      const p0 = new Float32Array(4 * N);
      for (let c = 0; c < N; c++) { p0[4 * c] = vel[4 * c]; p0[4 * c + 1] = vel[4 * c + 1]; p0[4 * c + 2] = vel[4 * c + 2]; }
      this.#upload(B.prev, p0);
    }

    // พารามิเตอร์ร่วม
    this.pbuf = new ArrayBuffer(80);
    const pi = new Int32Array(this.pbuf), pf = new Float32Array(this.pbuf);
    pi.set([NX, NY, NZ, this.nx, this.ny, this.nz, base[0], base[1], base[2], prep.axes[0].L, prep.axes[1].L, prep.axes[2].L]);
    pf[15] = CS * CS; pf[16] = NU_MIN; pf[17] = this.omega; pf[18] = 0.5 / PR_T;
    this.pf = pf;

    // pipeline
    device.pushErrorScope('validation');
    this.pipe = {};
    for (const [name, def] of Object.entries(SHADERS)) {
      const module = device.createShaderModule({ code: shaderSource(def), label: name });
      const ci = await module.getCompilationInfo?.();
      const errs = (ci?.messages || []).filter(m => m.type === 'error');
      if (errs.length) throw new Error(`shader ${name}: ${errs.map(e => `${e.lineNum}:${e.linePos} ${e.message}`).join(' | ')}`);
      this.pipe[name] = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' }, label: name });
    }
    const verr = await device.popErrorScope();
    if (verr) throw new Error('WebGPU: ' + verr.message);

    const bg = (name, ...bufs) => device.createBindGroup({
      layout: this.pipe[name].getBindGroupLayout(0),
      entries: bufs.map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    const m = this.mode;
    this.bg = {
      turb: bg('turb', B.P, B.velB, B.nut, B.flags, B.tab),
      diffuse: bg('diffuse', B.P, B.velB, B.velA, B.nut, B.flags, B.tab),
      porous: bg('porous', B.P, B.velA, B.plist, B.flags),
      mirror: bg('mirror', B.velA, B.mlist),
      div: bg('div', B.P, B.velA, B.rhs, B.flags, B.tab),
      sor: [0, 1].map(c => bg('sor', B.P, m[c], B.phi, B.rhs, B.idg, B.flags, B.tab)),
      correct: bg('correct', B.P, B.velA, B.phi, B.flags, B.tab),
      statsRow: bg('statsRow', B.P, B.velA, B.rhs, B.flags, B.tab, B.rowS),
      redS: bg('reduce', B.P, m[5], B.rowS, B.kS), redE: bg('reduce', B.P, m[0], B.rowE, B.kE), redR: bg('reduce', B.P, m[0], B.rowR, B.kR),
    };
    // ชุดที่ขึ้นกับบัฟเฟอร์ (θ, tracer) ปัจจุบัน: สร้างไว้ทั้งสองทิศ
    const sc = [B.scA, B.scB];
    this.bgS = [0, 1].map(a => ({
      advect: bg('advect', B.P, B.velA, B.velB, sc[a], B.flags, B.tab),
      fan: bg('fan', sc[a], B.flist, B.tdis),
      transport: bg('transport', B.P, sc[a], sc[1 - a], B.velA, B.nut, B.rhs, B.flags, B.tab),
      energy: [1, 0].map(first => bg('energyRow', B.P, m[first], sc[a], sc[1 - a], B.velA, B.nut, B.flags, B.tab, B.rowE)),   // [0] = เริ่มใหม่, [1] = สะสม
      units: bg('units', sc[a], B.inl, B.mtab, B.mout),
      resid: bg('residRow', B.P, B.velA, sc[a], B.prev, B.flags, B.rowR),
    }));
    this.cur = 0;   // ดัชนีบัฟเฟอร์ (θ, tracer) ปัจจุบัน

    this.time = 0; this.steps = 0; this.dt = 0;
    this.vmax = 1; this.rate = 0; this.maxOut = 0; this.divErr = 0;
    this.resid = [0, 0];
    this._resetMonitor();
    // projection ครั้งแรกให้สนามเริ่มต้นไม่มี divergence
    this.#writeParams(0.1, 0.1);
    const enc = device.createCommandEncoder();
    this.#encodeProject(enc, 80);
    await this.#submitAndRead(enc);
    this.#takeStats();
  }

  #writeParams(dt, dts) {
    const pf = this.pf;
    pf[12] = dt; pf[13] = dts; pf[14] = G * this.beta * dt;
    this.device.queue.writeBuffer(this.buf.P, 0, this.pbuf);
  }

  #run(enc, name, bindGroup, x, y = 1, z = 1) {
    const p = enc.beginComputePass();
    p.setPipeline(this.pipe[name]);
    p.setBindGroup(0, bindGroup);
    p.dispatchWorkgroups(x, y, z);
    p.end();
  }

  /** จำนวน workgroup ของรอบสามมิติ (8×4×4) และรอบต่อแถว (8×8) */
  get #g3() { return [Math.ceil(this.NX / 8), Math.ceil(this.NY / 4), Math.ceil(this.NZ / 4)]; }
  get #g2() { return [Math.ceil(this.NY / 8), Math.ceil(this.NZ / 8)]; }

  #encodeProject(enc, iters) {
    const g3 = this.#g3, g2 = this.#g2;
    this.#run(enc, 'div', this.bg.div, ...g3);
    // SOR: หลายรอบอยู่ใน compute pass เดียว (สลับ bind group ของสองสี)
    const p = enc.beginComputePass();
    p.setPipeline(this.pipe.sor);
    const hx = Math.ceil((Math.ceil(this.NX / 2) + 1) / 8);
    for (let it = 0; it < iters; it++) {
      for (let c = 0; c < 2; c++) { p.setBindGroup(0, this.bg.sor[c]); p.dispatchWorkgroups(hx, g3[1], g3[2]); }
    }
    p.end();
    this.#run(enc, 'correct', this.bg.correct, ...g3);
    this.#run(enc, 'statsRow', this.bg.statsRow, ...g2);
    this.#run(enc, 'reduce', this.bg.redS, Math.ceil(this.NZ / 16));
  }

  /** ส่งชุดคำสั่งแล้วอ่านผลรวม (สถิติ, พลังงาน, residual, โมดูล) กลับมาเป็น Float32Array */
  async #submitAndRead(enc) {
    const { buf: B, NZ } = this, n = 4 * RED * NZ;
    enc.copyBufferToBuffer(B.kS, 0, this.staging, 0, n);
    enc.copyBufferToBuffer(B.kE, 0, this.staging, n, n);
    enc.copyBufferToBuffer(B.kR, 0, this.staging, 2 * n, n);
    enc.copyBufferToBuffer(B.mout, 0, this.staging, 3 * n, 16 * Math.max(1, this.mods.length));
    this.device.queue.submit([enc.finish()]);
    await this.staging.mapAsync(GPUMapMode.READ);
    if (this.lost) throw new Error('การ์ดจอหยุดทำงานระหว่างคำนวณ: ' + this.lost);
    this.res = new Float32Array(this.staging.getMappedRange()).slice();
    this.staging.unmap();
  }

  #takeStats() {
    const r = this.res, NZ = this.NZ;
    let mu = 0, mv = 0, mw = 0, mr = 0, mo = 0, e2 = 0;
    for (let k = 1; k <= this.nz; k++) {
      const o = k * RED;
      mu = Math.max(mu, r[o]); mv = Math.max(mv, r[o + 1]); mw = Math.max(mw, r[o + 2]);
      mr = Math.max(mr, r[o + 3]); mo = Math.max(mo, r[o + 4]); e2 += r[o + 5];
    }
    void NZ;
    this.maxU = mu; this.maxV = Math.max(mv, this.fanVmax); this.maxW = mw;
    this.maxOut = mo;
    this.rate = Math.max(mr, this.fanRate);
    this.vmax = Math.max(this.maxU, this.maxV, this.maxW);
    this.divErr = Math.sqrt(e2 / Math.max(1, this.nFluid)) / Math.max(0.5, this.vmax);
    if (!Number.isFinite(this.vmax)) throw new Error('การคำนวณบน GPU ให้ค่าไม่ถูกต้อง (NaN)');
  }

  /* ───────── สเต็ปเวลา ───────── */

  async step() {
    const { device, buf: B, h, mods } = this;
    // Δt และจำนวนสเต็ปย่อยจากสถิติของสนามความเร็วล่าสุด (ผลของ projection ในสเต็ปก่อน)
    const dt = Math.min(0.25, CFL_VEL / Math.max(0.5 / h, this.rate));
    const ns = Math.max(1, Math.ceil(this.maxOut * dt / CFL_SCALAR - 0.01));
    const dts = dt / ns;
    this.dt = dt;
    this.#writeParams(dt, dts);
    // อุณหภูมิลมเป่าของแต่ละโมดูลจาก T ลมเข้าล่าสุด
    const tdis = new Float32Array(Math.max(1, mods.length));
    let qIn = 0;
    mods.forEach((m, mi) => {
      if (!m.active) return;
      const st = this.modState[mi];
      const p = modulePerf(m.kw, m.eer, st.Tin, this.perf);
      st.capF = p.capF; st.qRej = p.qRej;
      st.Tdis = st.Tin + p.qRej / (this.rho * m.q * this.cp);
      tdis[mi] = st.Tdis - this.amb;
      qIn += p.qRej;
    });
    device.queue.writeBuffer(B.tdis, 0, tdis);

    const sample = this.time + dt >= this.nextSample;
    const g3 = this.#g3, g2 = this.#g2;
    const enc = device.createCommandEncoder();
    let a = this.cur;
    this.#run(enc, 'advect', this.bgS[a].advect, ...g3);                 // velA → velB (+ แรงลอยตัว)
    this.#run(enc, 'turb', this.bg.turb, ...g3);
    this.#run(enc, 'diffuse', this.bg.diffuse, ...g3);                   // velB → velA
    if (this.mesh.stats.porous > 0) this.#run(enc, 'porous', this.bg.porous, Math.ceil(B.plist.size / 16 / 64));
    if (this.nMirror) this.#run(enc, 'mirror', this.bg.mirror, Math.ceil(this.nMirror / 64));
    this.#encodeProject(enc, this.steps < 20 ? 80 : this.pIters);
    if (this.nFan) this.#run(enc, 'fan', this.bgS[a].fan, Math.ceil(this.nFan / 64));
    for (let s = 0; s < ns; s++) {
      this.#run(enc, 'transport', this.bgS[a].transport, ...g3);
      this.#run(enc, 'energyRow', this.bgS[a].energy[s === 0 ? 0 : 1], ...g2);
      a = 1 - a;
    }
    this.#run(enc, 'reduce', this.bg.redE, Math.ceil(this.NZ / 16));
    if (mods.length) this.#run(enc, 'units', this.bgS[a].units, mods.length);
    if (sample) {
      this.#run(enc, 'residRow', this.bgS[a].resid, ...g2);
      this.#run(enc, 'reduce', this.bg.redR, Math.ceil(this.NZ / 16));
    }
    this.cur = a;
    await this.#submitAndRead(enc);

    this.#takeStats();
    if (this.divErr > 0.01) this.pIters = Math.min(120, this.pIters + 6);
    else if (this.divErr < 0.002) this.pIters = Math.max(12, this.pIters - 2);

    // บัญชีพลังงานและ T ลมเข้ารายโมดูล
    const r = this.res, n = RED * this.NZ, rc = this.rho * this.cp;
    let qo = 0, dE = 0;
    for (let k = 1; k <= this.nz; k++) { qo += r[n + k * RED]; dE += r[n + k * RED + 1]; }
    const acc = this.acc;
    acc.t += dt; acc.qIn += qIn * dt; acc.qOut += rc * qo * dts; acc.dE += rc * dE;
    mods.forEach((m, mi) => {
      const st = this.modState[mi];
      if (m.active) {
        const o = 3 * n + 4 * mi;
        st.Tin = this.amb + r[o]; st.Cin = r[o + 1]; st.TinMax = this.amb + r[o + 2];
      }
      acc.tin[mi] += st.Tin * dt; acc.cin[mi] += st.Cin * dt;
    });
    if (sample) {
      let du = 0, dT = 0;
      for (let k = 0; k < this.NZ; k++) { du += r[2 * n + k * RED]; dT += r[2 * n + k * RED + 1]; }
      this.resid = [du, dT];
    }
    this.time += dt;
    this.steps++;
    this._monitor(dt);
  }

  _residualSums() { return this.resid; }

  /* ───────── ผลลัพธ์ ───────── */

  /** อ่านบัฟเฟอร์ทั้งก้อนกลับมา (ใช้ตอนส่งสนามค่าไปแสดงผล) */
  async #readBuffer(src, bytes, Type) {
    const U = GPUBufferUsage;
    this.stage ??= {};
    const st = this.stage[bytes] ??= this.#buffer(bytes, U.MAP_READ | U.COPY_DST);
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, st, 0, bytes);
    this.device.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const out = new Type(st.getMappedRange()).slice();
    st.unmap();
    return out;
  }

  /** สนามดิบ (ความเร็วที่หน้าเซลล์, T, tracer, φ) — ใช้ทดสอบเทียบกับ solver แบบ CPU */
  async raw() {
    const { N, buf: B } = this;
    const vel = await this.#readBuffer(B.velA, 16 * N, Float32Array);
    const sc = await this.#readBuffer(this.cur ? B.scB : B.scA, 8 * N, Float32Array);
    const phi = await this.#readBuffer(B.phi, 4 * N, Float32Array);
    const u = new Float32Array(N), v = new Float32Array(N), w = new Float32Array(N), T = new Float32Array(N), C = new Float32Array(N);
    for (let c = 0; c < N; c++) { u[c] = vel[4 * c]; v[c] = vel[4 * c + 1]; w[c] = vel[4 * c + 2]; T[c] = sc[2 * c] + this.amb; C[c] = sc[2 * c + 1]; }
    return { u, v, w, T, C, phi };
  }

  /** สนามค่าที่กึ่งกลางเซลล์ สำหรับแสดงผล */
  async fields() {
    const { nx, ny, nz, sy, sz, N } = this;
    const { u, v, w, T, C, phi } = await this.raw();
    const uc = new Float32Array(N), vc = new Float32Array(N), wc = new Float32Array(N);
    for (let k = 1; k <= nz; k++)
      for (let j = 1; j <= ny; j++) {
        let c = 1 + j * sy + k * sz;
        for (let i = 1; i <= nx; i++, c++) {
          uc[c] = 0.5 * (u[c] + u[c + 1]);
          vc[c] = 0.5 * (v[c] + v[c + sy]);
          wc[c] = 0.5 * (w[c] + w[c + sz]);
        }
      }
    const type = this.mesh.type, kp = this.rho / Math.max(1e-6, this.dt || 0.1);
    const P = phi;
    for (let c = 0; c < N; c++) P[c] = type[c] === SOLID ? 0 : phi[c] * kp;
    for (const m of this.mods) for (let a = 0; a < m.fanCells.length; a++) { T[m.fanCells[a]] = this.amb; C[m.fanCells[a]] = 0; }
    return { T, C, u: uc, v: vc, w: wc, P };
  }
}
