/*
 * kernels.c — ลูปหนักของ solver.js เขียนเป็น C แล้วคอมไพล์เป็น WebAssembly (npm run build:wasm)
 *
 * แต่ละฟังก์ชันเป็นการแปลจากโค้ด JavaScript ใน solver.js แบบบรรทัดต่อบรรทัด:
 *   - อ่านค่า float แล้วคำนวณเป็น double ทั้งหมด เก็บกลับเป็น float — เหมือน Float32Array ใน JS
 *   - ลำดับการบวกเหมือนเดิมทุกตัว และคอมไพล์ด้วย -ffp-contract=off (ไม่รวมเป็น FMA)
 * ผลจึงตรงกับเส้นทาง JavaScript ทุกบิต (ตรวจได้ด้วย npm test -- --compare)
 *
 * อาร์เรย์ทั้งหมดอยู่ใน linear memory ของ WebAssembly ฝั่ง JS เข้าถึงผ่าน typed array view
 */

typedef unsigned char u8;
typedef short i16;
#define D(x) ((double)(x))
#define EXPORT(name) __attribute__((export_name(#name)))

enum { FLUID = 0, SOLID = 1, OPEN = 2 };

/* ───────── Semi-Lagrangian advection ของความเร็ว ───────── */

static inline double sample(const float *a, double fi, double fj, double fk,
                            double xm, double ym, double zm, int sy, int sz) {
  if (fi < 0) fi = 0; else if (fi > xm) fi = xm;
  if (fj < 0) fj = 0; else if (fj > ym) fj = ym;
  if (fk < 0) fk = 0; else if (fk > zm) fk = zm;
  const int i0 = (int)fi, j0 = (int)fj, k0 = (int)fk;
  const double s1 = fi - i0, t1 = fj - j0, r1 = fk - k0;
  const int b = i0 + j0 * sy + k0 * sz;
  const double a00 = D(a[b]) + s1 * (D(a[b + 1]) - D(a[b]));
  const double a10 = D(a[b + sy]) + s1 * (D(a[b + sy + 1]) - D(a[b + sy]));
  const double a01 = D(a[b + sz]) + s1 * (D(a[b + sz + 1]) - D(a[b + sz]));
  const double a11 = D(a[b + sz + sy]) + s1 * (D(a[b + sz + sy + 1]) - D(a[b + sz + sy]));
  const double a0 = a00 + t1 * (a10 - a00), a1 = a01 + t1 * (a11 - a01);
  return a0 + r1 * (a1 - a0);
}

EXPORT(advect)
void advect(int nx, int ny, int nz, int NX, int NY, int NZ, int sy, int sz, double r,
            float *u, float *v, float *w, const float *u0, const float *v0, const float *w0,
            const u8 *fixU, const u8 *fixV, const u8 *fixW) {
  const double xm = NX - 1.001, ym = NY - 1.001, zm = NZ - 1.001;
  for (int k = 1; k <= nz; k++)
    for (int j = 1; j <= ny; j++) {
      int c = 1 + j * sy + k * sz;
      for (int i = 1; i <= nx + 1; i++, c++) {
        if (fixU[c]) continue;
        const double uu = u0[c];
        const double vv = 0.25 * (D(v0[c - 1]) + D(v0[c]) + D(v0[c - 1 + sy]) + D(v0[c + sy]));
        const double ww = 0.25 * (D(w0[c - 1]) + D(w0[c]) + D(w0[c - 1 + sz]) + D(w0[c + sz]));
        u[c] = (float)sample(u0, i - r * uu, j - r * vv, k - r * ww, xm, ym, zm, sy, sz);
      }
    }
  for (int k = 1; k <= nz; k++)
    for (int j = 1; j <= ny + 1; j++) {
      int c = 1 + j * sy + k * sz;
      for (int i = 1; i <= nx; i++, c++) {
        if (fixV[c]) continue;
        const double uu = 0.25 * (D(u0[c]) + D(u0[c + 1]) + D(u0[c - sy]) + D(u0[c + 1 - sy]));
        const double vv = v0[c];
        const double ww = 0.25 * (D(w0[c]) + D(w0[c + sz]) + D(w0[c - sy]) + D(w0[c - sy + sz]));
        v[c] = (float)sample(v0, i - r * uu, j - r * vv, k - r * ww, xm, ym, zm, sy, sz);
      }
    }
  for (int k = 1; k <= nz + 1; k++)
    for (int j = 1; j <= ny; j++) {
      int c = 1 + j * sy + k * sz;
      for (int i = 1; i <= nx; i++, c++) {
        if (fixW[c]) continue;
        const double uu = 0.25 * (D(u0[c]) + D(u0[c + 1]) + D(u0[c - sz]) + D(u0[c + 1 - sz]));
        const double vv = 0.25 * (D(v0[c]) + D(v0[c + sy]) + D(v0[c - sz]) + D(v0[c + sy - sz]));
        const double ww = w0[c];
        w[c] = (float)sample(w0, i - r * uu, j - r * vv, k - r * ww, xm, ym, zm, sy, sz);
      }
    }
}

/* ───────── แรงลอยตัว · ความปั่นป่วน · การแพร่ของความเร็ว ───────── */

EXPORT(buoyancy)
void buoyancy(int nx, int ny, int nz, int sy, int sz, double kb, double amb,
              float *v, const float *T, const u8 *fixV) {
  for (int k = 1; k <= nz; k++)
    for (int j = 2; j <= ny + 1; j++) {
      int c = 1 + j * sy + k * sz;
      for (int i = 1; i <= nx; i++, c++) {
        if (fixV[c]) continue;
        v[c] = (float)(D(v[c]) + kb * (0.5 * (D(T[c]) + D(T[c - sy])) - amb));
      }
    }
}

EXPORT(turbulence)
void turbulence(int nx, int ny, int nz, int sy, int sz, double l2, double inv, double i2, double cap, double numin,
                const float *u, const float *v, const float *w, float *uc, float *vc, float *wc,
                float *nut, const u8 *type) {
  for (int k = 1; k <= nz; k++)
    for (int j = 1; j <= ny; j++) {
      int c = 1 + j * sy + k * sz;
      for (int i = 1; i <= nx; i++, c++) {
        uc[c] = (float)(0.5 * (D(u[c]) + D(u[c + 1])));
        vc[c] = (float)(0.5 * (D(v[c]) + D(v[c + sy])));
        wc[c] = (float)(0.5 * (D(w[c]) + D(w[c + sz])));
      }
    }
  for (int k = 1; k <= nz; k++)
    for (int j = 1; j <= ny; j++) {
      int c = 1 + j * sy + k * sz;
      for (int i = 1; i <= nx; i++, c++) {
        if (type[c] != FLUID) { nut[c] = 0; continue; }
        const double dudx = (D(u[c + 1]) - D(u[c])) * inv, dvdy = (D(v[c + sy]) - D(v[c])) * inv, dwdz = (D(w[c + sz]) - D(w[c])) * inv;
        const double dudy = (D(uc[c + sy]) - D(uc[c - sy])) * i2, dudz = (D(uc[c + sz]) - D(uc[c - sz])) * i2;
        const double dvdx = (D(vc[c + 1]) - D(vc[c - 1])) * i2, dvdz = (D(vc[c + sz]) - D(vc[c - sz])) * i2;
        const double dwdx = (D(wc[c + 1]) - D(wc[c - 1])) * i2, dwdy = (D(wc[c + sy]) - D(wc[c - sy])) * i2;
        const double a = dudy + dvdx, b = dudz + dwdx, e = dvdz + dwdy;
        const double S = __builtin_sqrt(2 * (dudx * dudx + dvdy * dvdy + dwdz * dwdz) + a * a + b * b + e * e);
        const double nu = numin + l2 * S;
        nut[c] = (float)(nu < cap ? nu : cap);
      }
    }
}

EXPORT(diffuse)
void diffuse(int nx, int ny, int nz, int sy, int sz, double q,
             float *u, float *v, float *w, const float *u0, const float *v0, const float *w0,
             const float *nut, const u8 *fixU, const u8 *fixV, const u8 *fixW) {
  for (int k = 2; k <= nz - 1; k++)
    for (int j = 2; j <= ny - 1; j++) {
      int c = 2 + j * sy + k * sz;
      for (int i = 2; i <= nx - 1; i++, c++) {
        if (!fixU[c]) {
          const double a = q * 0.5 * (D(nut[c]) + D(nut[c - 1]));
          u[c] = (float)(D(u0[c]) + a * (D(u0[c - 1]) + D(u0[c + 1]) + D(u0[c - sy]) + D(u0[c + sy]) + D(u0[c - sz]) + D(u0[c + sz]) - 6 * D(u0[c])));
        }
        if (!fixV[c]) {
          const double a = q * 0.5 * (D(nut[c]) + D(nut[c - sy]));
          v[c] = (float)(D(v0[c]) + a * (D(v0[c - 1]) + D(v0[c + 1]) + D(v0[c - sy]) + D(v0[c + sy]) + D(v0[c - sz]) + D(v0[c + sz]) - 6 * D(v0[c])));
        }
        if (!fixW[c]) {
          const double a = q * 0.5 * (D(nut[c]) + D(nut[c - sz]));
          w[c] = (float)(D(w0[c]) + a * (D(w0[c - 1]) + D(w0[c + 1]) + D(w0[c - sy]) + D(w0[c + sy]) + D(w0[c - sz]) + D(w0[c + sz]) - 6 * D(w0[c])));
        }
      }
    }
}

/* ───────── Projection (Red–Black SOR) ───────── */

/* out[0..4] = max|u|, max|v|, max|w|, max ผลรวมความเร็วไหลออก, Σ(∇·u)² */
EXPORT(project)
void project(int sy, int sz, double h, int iters, double om,
             float *u, float *v, float *w, float *phi, float *rhs, float *dv,
             const u8 *pm, const u8 *nf, const u8 *type,
             const int *red, int nr, const int *black, int nb, const int *fluid, int nfl, double *out) {
  for (int a = 0; a < nfl; a++) {
    const int c = fluid[a];
    rhs[c] = (float)(h * (D(u[c + 1]) - D(u[c]) + D(v[c + sy]) - D(v[c]) + D(w[c + sz]) - D(w[c])));
  }
  for (int it = 0; it < iters; it++)
    for (int pass = 0; pass < 2; pass++) {
      const int *list = pass ? black : red;
      const int n = pass ? nb : nr;
      for (int a = 0; a < n; a++) {
        const int c = list[a], m = pm[c];
        const double p = phi[c];
        if (m == 63) {
          phi[c] = (float)(p + om * ((D(phi[c - 1]) + D(phi[c + 1]) + D(phi[c - sy]) + D(phi[c + sy]) + D(phi[c - sz]) + D(phi[c + sz]) - D(rhs[c])) / 6 - p));
          continue;
        }
        double s = 0;
        if (m & 1) s += phi[c - 1];
        if (m & 2) s += phi[c + 1];
        if (m & 4) s += phi[c - sy];
        if (m & 8) s += phi[c + sy];
        if (m & 16) s += phi[c - sz];
        if (m & 32) s += phi[c + sz];
        phi[c] = (float)(p + om * ((s - D(rhs[c])) / nf[c] - p));
      }
    }
  const double inv = 1 / h;
  for (int a = 0; a < nfl; a++) {
    const int c = fluid[a], m = pm[c];
    const double p = phi[c];
    if (m & 1) u[c] = (float)(D(u[c]) - (p - D(phi[c - 1])) * inv);
    if (m & 4) v[c] = (float)(D(v[c]) - (p - D(phi[c - sy])) * inv);
    if (m & 16) w[c] = (float)(D(w[c]) - (p - D(phi[c - sz])) * inv);
    if ((m & 2) && type[c + 1] == OPEN) u[c + 1] = (float)(D(u[c + 1]) - (0 - p) * inv);
    if ((m & 8) && type[c + sy] == OPEN) v[c + sy] = (float)(D(v[c + sy]) - (0 - p) * inv);
    if ((m & 32) && type[c + sz] == OPEN) w[c + sz] = (float)(D(w[c + sz]) - (0 - p) * inv);
  }
  double mu = 0, mv = 0, mw = 0, e2 = 0, mo = 0;
  for (int a = 0; a < nfl; a++) {
    const int c = fluid[a];
    const double au = __builtin_fabs(D(u[c])), av = __builtin_fabs(D(v[c])), aw = __builtin_fabs(D(w[c]));
    if (au > mu) mu = au;
    if (av > mv) mv = av;
    if (aw > mw) mw = aw;
    const double up = u[c + 1], um = u[c], vp = v[c + sy], vm = v[c], wp = w[c + sz], wm = w[c];
    const double d = up - um + vp - vm + wp - wm;
    dv[c] = (float)d;
    const double o = (up > 0 ? up : 0) - (um < 0 ? um : 0) + (vp > 0 ? vp : 0) - (vm < 0 ? vm : 0) + (wp > 0 ? wp : 0) - (wm < 0 ? wm : 0);
    if (o > mo) mo = o;
    e2 += d * d;
  }
  out[0] = mu; out[1] = mv; out[2] = mw; out[3] = mo; out[4] = e2;
}

/* ───────── การพาอุณหภูมิและ tracer (finite volume, MUSCL + van Leer) ───────── */

static double fluxAxis(int nx, int ny, int nz, int sy, int sz, int st, int axis, double acap, double dh, double ka, double amb,
                       const float *vel, const u8 *type, const float *T0, const float *C0, double *dT, double *dC,
                       const float *nut, const i16 *fanOf, const double *tdis) {
  const int i1 = axis == 0 ? nx + 1 : nx, j1 = axis == 1 ? ny + 1 : ny, k1 = axis == 2 ? nz + 1 : nz;
  double qOut = 0;
  for (int k = 1; k <= k1; k++)
    for (int j = 1; j <= j1; j++) {
      int c = 1 + j * sy + k * sz;
      for (int i = 1; i <= i1; i++, c++) {
        const int a = c - st;
        const int ta = type[a], tb = type[c];
        const double vf = vel[c];
        if ((ta | tb) == 0) {
          double sT, sC;
          if (vf > 0) {
            const double ta0 = T0[a], ca0 = C0[a];
            sT = ta0; sC = ca0;
            const int m = a - st;
            if (type[m] == 0) {
              double d1 = ta0 - D(T0[m]), d2 = D(T0[c]) - ta0, p = d1 * d2;
              if (p > 0) sT += p / (d1 + d2);
              d1 = ca0 - D(C0[m]); d2 = D(C0[c]) - ca0; p = d1 * d2;
              if (p > 0) sC += p / (d1 + d2);
            }
          } else {
            const double tb0 = T0[c], cb0 = C0[c];
            sT = tb0; sC = cb0;
            const int m = c + st;
            if (type[m] == 0) {
              double d1 = tb0 - D(T0[m]), d2 = D(T0[a]) - tb0, p = d1 * d2;
              if (p > 0) sT += p / (d1 + d2);
              d1 = cb0 - D(C0[m]); d2 = D(C0[a]) - cb0; p = d1 * d2;
              if (p > 0) sC += p / (d1 + d2);
            }
          }
          double al = ka * (D(nut[a]) + D(nut[c]));
          if (al > acap) al = acap;
          const double g = al * dh;
          const double FT = vf * sT - g * (D(T0[c]) - D(T0[a]));
          const double FC = vf * sC - g * (D(C0[c]) - D(C0[a]));
          dT[a] -= FT; dC[a] -= FC;
          dT[c] += FT; dC[c] += FC;
          continue;
        }
        if (ta != FLUID && tb != FLUID) continue;
        if (ta == SOLID || tb == SOLID) {
          if (vf == 0) continue;
          double sT, sC;
          if ((vf > 0) == (ta == SOLID)) {
            const int m = fanOf[c];
            if (!m) continue;
            sT = tdis[m - 1]; sC = 1;
          } else {
            const int f = ta == FLUID ? a : c;
            sT = T0[f]; sC = C0[f];
          }
          const double FT = vf * sT, FC = vf * sC;
          if (ta == FLUID) { dT[a] -= FT; dC[a] -= FC; } else { dT[c] += FT; dC[c] += FC; }
          continue;
        }
        const int f = ta == FLUID ? a : c;
        const int inflow = ta == FLUID ? vf < 0 : vf > 0;
        const double sT = inflow ? amb : D(T0[f]), sC = inflow ? 0 : D(C0[f]);
        double al = 2 * ka * D(nut[f]);
        if (al > acap) al = acap;
        const double g = al * dh;
        const double FT = vf * sT - g * (ta == FLUID ? amb - D(T0[a]) : D(T0[c]) - amb);
        const double FC = vf * sC - g * (ta == FLUID ? -D(C0[a]) : D(C0[c]));
        if (ta == FLUID) { dT[a] -= FT; dC[a] -= FC; qOut += FT - vf * amb; }
        else { dT[c] += FT; dC[c] += FC; qOut -= FT - vf * amb; }
      }
    }
  return qOut;
}

/* out[0] = ความร้อนที่ไหลออกทางขอบ (หน่วยเดียวกับ JS: Σ ฟลักซ์), out[1] = Σ ΔT ของเซลล์อากาศ */
EXPORT(transport)
void transport(int nx, int ny, int nz, int sy, int sz, double dt, double h, double ka, double amb,
               const float *u, const float *v, const float *w, const u8 *type,
               float *T, float *C, const float *T0, const float *C0, double *dT, double *dC,
               const float *nut, const float *dv, const i16 *fanOf, const double *tdis,
               const int *fluid, int nfl, double *out) {
  const double acap = 0.12 * h * h / dt, dh = 1 / h;
  double qOut = 0;
  qOut += fluxAxis(nx, ny, nz, sy, sz, 1, 0, acap, dh, ka, amb, u, type, T0, C0, dT, dC, nut, fanOf, tdis);
  qOut += fluxAxis(nx, ny, nz, sy, sz, sy, 1, acap, dh, ka, amb, v, type, T0, C0, dT, dC, nut, fanOf, tdis);
  qOut += fluxAxis(nx, ny, nz, sy, sz, sz, 2, acap, dh, ka, amb, w, type, T0, C0, dT, dC, nut, fanOf, tdis);
  const double k = dt / h;
  double dE = 0;
  for (int a = 0; a < nfl; a++) {
    const int c = fluid[a];
    double t = D(T0[c]) + k * (dT[c] + D(T0[c]) * D(dv[c]));
    double q = D(C0[c]) + k * (dC[c] + D(C0[c]) * D(dv[c]));
    dT[c] = 0; dC[c] = 0;
    if (t < amb - 2) t = amb - 2; else if (t > amb + 70) t = amb + 70;
    if (q < 0) q = 0; else if (q > 1) q = 1;
    dE += t - D(T0[c]);
    T[c] = (float)t; C[c] = (float)q;
  }
  out[0] = qOut; out[1] = dE;
}
