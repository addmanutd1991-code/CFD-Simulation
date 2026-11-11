/*
 * kernels.c — ลูปหนักทั้งหมดของ solver คอมไพล์เป็น WebAssembly (npm run build:wasm)
 *
 * กริด rectilinear แบบ staggered (MAC) เซลล์กว้างไม่เท่ากันได้ — ระยะและสัมประสิทธิ์ของแต่ละแกน
 * คำนวณไว้ล่วงหน้าเป็นตารางหนึ่งมิติ (ดู AX_* ด้านล่าง, สร้างใน solver.js)
 *
 * การทำงานแบบขนาน: ทุกลูปแบ่งตามชั้น k (แผ่นตามแกน z) ให้เธรดละช่วง — เธรดช่วยงานเป็น Web Worker
 * ที่ใช้หน่วยความจำร่วม (SharedArrayBuffer) และรออยู่ใน worker_main() ผลรวม/ค่าสูงสุดเก็บแยกตามชั้น k
 * แล้วรวมตามลำดับ k เสมอ ผลลัพธ์จึงเหมือนกันทุกบิตไม่ว่าจะใช้กี่เธรด
 * คอมไพล์สองแบบ: ปกติ (เธรดเดียว) และ -DTHREADS (หน่วยความจำร่วม + atomics)
 *
 * อาร์เรย์ทั้งหมดอยู่ใน linear memory ของ WebAssembly ฝั่ง JS เข้าถึงผ่าน typed array view
 */

typedef unsigned char u8;
#define D(x) ((double)(x))
#define EXPORT(name) __attribute__((export_name(#name)))

enum { FLUID = 0, SOLID = 1, OPEN = 2 };

/* ตารางต่อแกน (แต่ละตารางยาว n+2 ช่อง, n = จำนวนเซลล์รวมชั้นเงา) — ลำดับต้องตรงกับ AXT ใน solver.js */
enum {
  AX_F,    /* พิกัดหน้าเซลล์: หน้าด้านลบของเซลล์ i (0..n) */
  AX_C,    /* พิกัดกึ่งกลางเซลล์ (0..n-1) */
  AX_D,    /* ความกว้างเซลล์ */
  AX_RD,   /* 1 / ความกว้างเซลล์ */
  AX_RDC,  /* 1 / ระยะระหว่างกึ่งกลางเซลล์ i-1 กับ i (ข้ามหน้า i) */
  AX_WF,   /* น้ำหนักของเซลล์ i เมื่อแทรกค่ากลางเซลล์ไปที่หน้า i (เซลล์ i-1 ได้ 1 − ค่านี้) */
  AX_PM,   /* สัมประสิทธิ์ Laplacian ของค่ากลางเซลล์ ด้านลบ: rd[i]·rdc[i] */
  AX_PP,   /*   ด้านบวก: rd[i]·rdc[i+1] */
  AX_FM,   /* สัมประสิทธิ์ Laplacian ของค่าที่หน้าเซลล์ ด้านลบ: rdc[i]·rd[i-1] */
  AX_FP,   /*   ด้านบวก: rdc[i]·rd[i] */
  AX_R2,   /* 1 / (C[i+1] − C[i-1]) */
  AX_Q23,  /* ความกว้าง^(2/3) */
  AX_RD2,  /* 1 / ความกว้าง² */
  AX_CB,   /* ความกว้าง^(1/3) */
  AX_COUNT
};

/* พารามิเตอร์/ผลลัพธ์สเกลาร์ (double) — ลำดับต้องตรงกับ PAR ใน solver.js */
enum {
  P_DT, P_KB, P_AMB, P_CS2, P_NUMIN, P_OMEGA, P_KA,
  O_MAXU, O_MAXV, O_MAXW, O_RATE, O_OUT, O_E2, O_QOUT, O_DE, O_DU2, O_DT2,
  P_COUNT
};

/* บริบทร่วมของทุก kernel — ทุกช่องกว้าง 4 ไบต์ ลำดับต้องตรงกับ CTX ใน solver.js */
typedef struct {
  int nx, ny, nz, NX, NY, NZ, sy, sz, N, nthreads;
  float *u, *v, *w, *u0, *v0, *w0, *T, *T0, *C, *C0, *phi, *rhs, *nut, *idg;
  float *pu, *pv, *pw, *pT;
  u8 *type, *fx, *pm;
  double *ax[3];      /* ตารางต่อแกน x, y, z */
  double *red;        /* ผลรวมแยกตามชั้น k: NZ × RED ช่อง */
  double *scratch;    /* บัฟเฟอร์ฟลักซ์ของ transport ต่อเธรด */
  double *par;        /* P_COUNT ช่อง */
} Ctx;

static Ctx G;
EXPORT(ctx) Ctx *ctx(void) { return &G; }

enum { RED = 8 };
#define AXT(a, t) (G.ax[a] + (t) * ((a) == 0 ? G.NX + 2 : (a) == 1 ? G.NY + 2 : G.NZ + 2))

/* ───────── ตัวกระจายงานให้เธรด ───────── */

enum { J_ADVECT, J_BUOY, J_TURB_A, J_TURB_B, J_DIFFUSE, J_DIV, J_SOR, J_CORRECT, J_STATS, J_TRANSPORT, J_RESID };

static void run_job(int job, int tid);

#ifdef THREADS
static struct { int gen, pending, job; } pool;

static volatile int spin_sink;
static inline void spin_pause(void) { spin_sink++; }

EXPORT(worker_main)
void worker_main(int tid) {
  int seen = 0;
  for (;;) {
    int spins = 0;
    while (__atomic_load_n(&pool.gen, __ATOMIC_SEQ_CST) == seen) {
      if (++spins > 30000) __builtin_wasm_memory_atomic_wait32(&pool.gen, seen, -1);
      else spin_pause();
    }
    seen = __atomic_load_n(&pool.gen, __ATOMIC_SEQ_CST);
    const int job = __atomic_load_n(&pool.job, __ATOMIC_SEQ_CST);
    if (job < 0) return;
    if (tid < G.nthreads) run_job(job, tid);
    if (__atomic_sub_fetch(&pool.pending, 1, __ATOMIC_SEQ_CST) == 0)
      __builtin_wasm_memory_atomic_notify(&pool.pending, 1);
  }
}

/* จำนวนเธรดช่วยงานที่กำลังรออยู่ใน worker_main (ตั้งจาก JS เมื่อทุกตัวพร้อม) */
static int helpers;
EXPORT(set_helpers) void set_helpers(int n) { helpers = n; }

static void run(int job) {
  if (helpers <= 0 || G.nthreads <= 1) { run_job(job, 0); return; }
  __atomic_store_n(&pool.job, job, __ATOMIC_SEQ_CST);
  __atomic_store_n(&pool.pending, helpers, __ATOMIC_SEQ_CST);
  __atomic_add_fetch(&pool.gen, 1, __ATOMIC_SEQ_CST);
  __builtin_wasm_memory_atomic_notify(&pool.gen, 0x7fffffff);
  run_job(job, 0);
  int spins = 0;
  for (;;) {
    const int p = __atomic_load_n(&pool.pending, __ATOMIC_SEQ_CST);
    if (p == 0) break;
    if (++spins > 4000) __builtin_wasm_memory_atomic_wait32(&pool.pending, p, 1000000);
    else spin_pause();
  }
}

/* จุดนัดพบระหว่างรอบย่อยของงานเดียว (ใช้ใน SOR: ทุกเธรดต้องจบสีหนึ่งก่อนเริ่มอีกสี)
 * หมุนรอสั้น ๆ แทนการปลุกเธรดใหม่ทุกรอบ — การปลุกแต่ละครั้งช้ากว่างานของรอบเล็ก ๆ */
static int bar_count;
static inline void barrier_reset(void) { __atomic_store_n(&bar_count, 0, __ATOMIC_SEQ_CST); }
static inline void barrier(int target) {
  if (__atomic_add_fetch(&bar_count, 1, __ATOMIC_SEQ_CST) >= target) {
    __builtin_wasm_memory_atomic_notify(&bar_count, 0x7fffffff);
    return;
  }
  int spins = 0;
  for (;;) {
    const int v = __atomic_load_n(&bar_count, __ATOMIC_SEQ_CST);
    if (v >= target) return;
    if (++spins > 50000) __builtin_wasm_memory_atomic_wait32(&bar_count, v, 500000);
    else spin_pause();
  }
}
static inline int team(void) { return helpers > 0 && G.nthreads > 1 ? G.nthreads : 1; }
#else
static void run(int job) { run_job(job, 0); }
static inline void barrier_reset(void) {}
static inline void barrier(int target) { (void)target; }
static inline int team(void) { return 1; }
#endif

/* ช่วง [lo, hi) ของเธรด tid */
static inline void split(int tid, int lo, int hi, int *a, int *b) {
  const int nt = G.nthreads < 1 ? 1 : G.nthreads, n = hi - lo;
  *a = lo + (int)((long long)n * tid / nt);
  *b = lo + (int)((long long)n * (tid + 1) / nt);
}

/* ───────── Semi-Lagrangian advection ของความเร็ว ───────── */

/* หาช่วง [X[i], X[i+1]] ที่ครอบ p โดยเดินจากดัชนีเริ่มต้น (จุดต้นทางอยู่ห่างไม่กี่เซลล์เสมอ) */
__attribute__((always_inline)) static inline int locate(const double *X, const double *rX, int n, double p, int i, double *s) {
  if (i > n - 2) i = n - 2;
  while (i > 0 && p < X[i]) i--;
  while (i < n - 2 && p >= X[i + 1]) i++;
  const double t = (p - X[i]) * rX[i];
  *s = t < 0 ? 0 : t > 1 ? 1 : t;
  return i;
}

__attribute__((always_inline)) static inline double trilin(const float *a, int b, double s1, double t1, double r1, int sy, int sz) {
  const double a00 = D(a[b]) + s1 * (D(a[b + 1]) - D(a[b]));
  const double a10 = D(a[b + sy]) + s1 * (D(a[b + sy + 1]) - D(a[b + sy]));
  const double a01 = D(a[b + sz]) + s1 * (D(a[b + sz + 1]) - D(a[b + sz]));
  const double a11 = D(a[b + sz + sy]) + s1 * (D(a[b + sz + sy + 1]) - D(a[b + sz + sy]));
  const double a0 = a00 + t1 * (a10 - a00), a1 = a01 + t1 * (a11 - a01);
  return a0 + r1 * (a1 - a0);
}

/* อ่าน u0/v0/w0 เขียน u/v/w ครบทุกช่องของชั้น (หน้าที่ถูกกำหนดความเร็วและชั้นเงาคัดลอกค่าเดิม) */
static void job_advect(int tid) {
  const int nx = G.nx, ny = G.ny, nz = G.nz, NX = G.NX, NY = G.NY, NZ = G.NZ, sy = G.sy, sz = G.sz;
  const float *u0 = G.u0, *v0 = G.v0, *w0 = G.w0;
  float *u = G.u, *v = G.v, *w = G.w;
  const u8 *fx = G.fx;
  const double dt = G.par[P_DT];
  const double *Fx = AXT(0, AX_F), *Cx = AXT(0, AX_C), *rdx = AXT(0, AX_RD), *rcx = AXT(0, AX_RDC) + 1, *wx = AXT(0, AX_WF);
  const double *Fy = AXT(1, AX_F), *Cy = AXT(1, AX_C), *rdy = AXT(1, AX_RD), *rcy = AXT(1, AX_RDC) + 1, *wy = AXT(1, AX_WF);
  const double *Fz = AXT(2, AX_F), *Cz = AXT(2, AX_C), *rdz = AXT(2, AX_RD), *rcz = AXT(2, AX_RDC) + 1, *wz = AXT(2, AX_WF);
  int k0, k1;
  split(tid, 0, NZ, &k0, &k1);
  for (int k = k0; k < k1; k++)
    for (int j = 0; j < NY; j++) {
      int c = j * sy + k * sz;
      const int ink = k >= 1 && k <= nz, inj = j >= 1 && j <= ny;
      for (int i = 0; i < NX; i++, c++) {
        /* u — หน้า x */
        if (ink && inj && i >= 1 && !(fx[c] & 1)) {
          const double a = wx[i], b = 1 - a;
          const double uu = u0[c];
          const double vv = 0.5 * (b * (D(v0[c - 1]) + D(v0[c - 1 + sy])) + a * (D(v0[c]) + D(v0[c + sy])));
          const double ww = 0.5 * (b * (D(w0[c - 1]) + D(w0[c - 1 + sz])) + a * (D(w0[c]) + D(w0[c + sz])));
          double s, t, r;
          const int i0 = locate(Fx, rdx, NX, Fx[i] - dt * uu, i, &s);
          const int j0 = locate(Cy, rcy, NY, Cy[j] - dt * vv, j, &t);
          const int q0 = locate(Cz, rcz, NZ, Cz[k] - dt * ww, k, &r);
          u[c] = (float)trilin(u0, i0 + j0 * sy + q0 * sz, s, t, r, sy, sz);
        } else u[c] = u0[c];
        /* v — หน้า y */
        if (ink && j >= 1 && i >= 1 && i <= nx && !(fx[c] & 2)) {
          const double a = wy[j], b = 1 - a;
          const double uu = 0.5 * (b * (D(u0[c - sy]) + D(u0[c + 1 - sy])) + a * (D(u0[c]) + D(u0[c + 1])));
          const double vv = v0[c];
          const double ww = 0.5 * (b * (D(w0[c - sy]) + D(w0[c - sy + sz])) + a * (D(w0[c]) + D(w0[c + sz])));
          double s, t, r;
          const int i0 = locate(Cx, rcx, NX, Cx[i] - dt * uu, i, &s);
          const int j0 = locate(Fy, rdy, NY, Fy[j] - dt * vv, j, &t);
          const int q0 = locate(Cz, rcz, NZ, Cz[k] - dt * ww, k, &r);
          v[c] = (float)trilin(v0, i0 + j0 * sy + q0 * sz, s, t, r, sy, sz);
        } else v[c] = v0[c];
        /* w — หน้า z */
        if (k >= 1 && inj && i >= 1 && i <= nx && !(fx[c] & 4)) {
          const double a = wz[k], b = 1 - a;
          const double uu = 0.5 * (b * (D(u0[c - sz]) + D(u0[c + 1 - sz])) + a * (D(u0[c]) + D(u0[c + 1])));
          const double vv = 0.5 * (b * (D(v0[c - sz]) + D(v0[c + sy - sz])) + a * (D(v0[c]) + D(v0[c + sy])));
          const double ww = w0[c];
          double s, t, r;
          const int i0 = locate(Cx, rcx, NX, Cx[i] - dt * uu, i, &s);
          const int j0 = locate(Cy, rcy, NY, Cy[j] - dt * vv, j, &t);
          const int q0 = locate(Fz, rdz, NZ, Fz[k] - dt * ww, k, &r);
          w[c] = (float)trilin(w0, i0 + j0 * sy + q0 * sz, s, t, r, sy, sz);
        } else w[c] = w0[c];
      }
    }
}

/* ───────── แรงลอยตัว · ความปั่นป่วน · การแพร่ของความเร็ว ───────── */

static void job_buoyancy(int tid) {
  const int nx = G.nx, ny = G.ny, sy = G.sy, sz = G.sz;
  float *v = G.v;
  const float *T = G.T;
  const u8 *fx = G.fx;
  const double kb = G.par[P_KB], amb = G.par[P_AMB];
  const double *wy = AXT(1, AX_WF);
  int k0, k1;
  split(tid, 1, G.nz + 1, &k0, &k1);
  for (int k = k0; k < k1; k++)
    for (int j = 2; j <= ny + 1; j++) {
      int c = 1 + j * sy + k * sz;
      const double a = wy[j], b = 1 - a;
      for (int i = 1; i <= nx; i++, c++) {
        if (fx[c] & 2) continue;
        v[c] = (float)(D(v[c]) + kb * (a * D(T[c]) + b * D(T[c - sy]) - amb));
      }
    }
}

/* ความเร็วที่กึ่งกลางเซลล์ลง u0/v0/w0 (ใช้เป็นที่พักชั่วคราว — ค่าก่อน advect ไม่ใช้อีกแล้ว) ชั้นเงา = 0 */
static void job_turb_a(int tid) {
  const int nx = G.nx, ny = G.ny, nz = G.nz, NX = G.NX, NY = G.NY, sy = G.sy, sz = G.sz;
  const float *u = G.u, *v = G.v, *w = G.w;
  float *uc = G.u0, *vc = G.v0, *wc = G.w0;
  int k0, k1;
  split(tid, 0, G.NZ, &k0, &k1);
  for (int k = k0; k < k1; k++)
    for (int j = 0; j < NY; j++) {
      int c = j * sy + k * sz;
      const int in = k >= 1 && k <= nz && j >= 1 && j <= ny;
      for (int i = 0; i < NX; i++, c++) {
        if (in && i >= 1 && i <= nx) {
          uc[c] = (float)(0.5 * (D(u[c]) + D(u[c + 1])));
          vc[c] = (float)(0.5 * (D(v[c]) + D(v[c + sy])));
          wc[c] = (float)(0.5 * (D(w[c]) + D(w[c + sz])));
        } else { uc[c] = 0; vc[c] = 0; wc[c] = 0; }
      }
    }
}

/* Smagorinsky: νt = (Cs·Δ)²·|S|, Δ = (dx·dy·dz)^(1/3) — จำกัดไม่ให้เกินเสถียรภาพของการแพร่แบบ explicit */
static void job_turb_b(int tid) {
  const int nx = G.nx, ny = G.ny, sy = G.sy, sz = G.sz;
  const float *u = G.u, *v = G.v, *w = G.w, *uc = G.u0, *vc = G.v0, *wc = G.w0;
  float *nut = G.nut;
  const u8 *type = G.type;
  const double cs2 = G.par[P_CS2], numin = G.par[P_NUMIN], rdt = 0.42 / G.par[P_DT];
  const double *rdx = AXT(0, AX_RD), *r2x = AXT(0, AX_R2), *qx = AXT(0, AX_Q23), *sx = AXT(0, AX_RD2);
  const double *rdy = AXT(1, AX_RD), *r2y = AXT(1, AX_R2), *qy = AXT(1, AX_Q23), *s2y = AXT(1, AX_RD2);
  const double *rdz = AXT(2, AX_RD), *r2z = AXT(2, AX_R2), *qz = AXT(2, AX_Q23), *s2z = AXT(2, AX_RD2);
  int k0, k1;
  split(tid, 1, G.nz + 1, &k0, &k1);
  for (int k = k0; k < k1; k++)
    for (int j = 1; j <= ny; j++) {
      int c = 1 + j * sy + k * sz;
      const double iy = rdy[j], iz = rdz[k], jy = r2y[j], jz = r2z[k];
      const double l2yz = cs2 * qy[j] * qz[k], syz = s2y[j] + s2z[k];
      for (int i = 1; i <= nx; i++, c++) {
        if (type[c] != FLUID) { nut[c] = 0; continue; }
        const double jx = r2x[i];
        const double dudx = (D(u[c + 1]) - D(u[c])) * rdx[i], dvdy = (D(v[c + sy]) - D(v[c])) * iy, dwdz = (D(w[c + sz]) - D(w[c])) * iz;
        const double dudy = (D(uc[c + sy]) - D(uc[c - sy])) * jy, dudz = (D(uc[c + sz]) - D(uc[c - sz])) * jz;
        const double dvdx = (D(vc[c + 1]) - D(vc[c - 1])) * jx, dvdz = (D(vc[c + sz]) - D(vc[c - sz])) * jz;
        const double dwdx = (D(wc[c + 1]) - D(wc[c - 1])) * jx, dwdy = (D(wc[c + sy]) - D(wc[c - sy])) * jy;
        const double a = dudy + dvdx, b = dudz + dwdx, e = dvdz + dwdy;
        const double S = __builtin_sqrt(2 * (dudx * dudx + dvdy * dvdy + dwdz * dwdz) + a * a + b * b + e * e);
        const double nu = numin + l2yz * qx[i] * S;
        const double cap = rdt / (sx[i] + syz);
        nut[c] = (float)(nu < cap ? nu : cap);
      }
    }
}

/* อ่าน u0/v0/w0 เขียน u/v/w ครบทุกช่องของชั้น */
static void job_diffuse(int tid) {
  const int nx = G.nx, ny = G.ny, nz = G.nz, NX = G.NX, NY = G.NY, sy = G.sy, sz = G.sz;
  const float *u0 = G.u0, *v0 = G.v0, *w0 = G.w0, *nut = G.nut;
  float *u = G.u, *v = G.v, *w = G.w;
  const u8 *fx = G.fx;
  const double dt = G.par[P_DT];
  const double *cmx = AXT(0, AX_PM), *cpx = AXT(0, AX_PP), *fmx = AXT(0, AX_FM), *fpx = AXT(0, AX_FP);
  const double *cmy = AXT(1, AX_PM), *cpy = AXT(1, AX_PP), *fmy = AXT(1, AX_FM), *fpy = AXT(1, AX_FP);
  const double *cmz = AXT(2, AX_PM), *cpz = AXT(2, AX_PP), *fmz = AXT(2, AX_FM), *fpz = AXT(2, AX_FP);
  int k0, k1;
  split(tid, 0, G.NZ, &k0, &k1);
  for (int k = k0; k < k1; k++)
    for (int j = 0; j < NY; j++) {
      int c = j * sy + k * sz;
      if (k < 2 || k > nz - 1 || j < 2 || j > ny - 1) {
        for (int i = 0; i < NX; i++, c++) { u[c] = u0[c]; v[c] = v0[c]; w[c] = w0[c]; }
        continue;
      }
      const double ym = cmy[j], yp = cpy[j], zm = cmz[k], zp = cpz[k];
      const double yfm = fmy[j], yfp = fpy[j], zfm = fmz[k], zfp = fpz[k];
      for (int i = 0; i < NX; i++, c++) {
        const int f = (i < 2 || i > nx - 1) ? 7 : fx[c];
        if (f == 7) { u[c] = u0[c]; v[c] = v0[c]; w[c] = w0[c]; continue; }
        const double xm = cmx[i], xp = cpx[i];
        const double nc = nut[c];
        if (!(f & 1)) {
          const double a = dt * 0.5 * (nc + D(nut[c - 1])), q = u0[c];
          u[c] = (float)(q + a * (fmx[i] * (D(u0[c - 1]) - q) + fpx[i] * (D(u0[c + 1]) - q)
            + ym * (D(u0[c - sy]) - q) + yp * (D(u0[c + sy]) - q) + zm * (D(u0[c - sz]) - q) + zp * (D(u0[c + sz]) - q)));
        } else u[c] = u0[c];
        if (!(f & 2)) {
          const double a = dt * 0.5 * (nc + D(nut[c - sy])), q = v0[c];
          v[c] = (float)(q + a * (xm * (D(v0[c - 1]) - q) + xp * (D(v0[c + 1]) - q)
            + yfm * (D(v0[c - sy]) - q) + yfp * (D(v0[c + sy]) - q) + zm * (D(v0[c - sz]) - q) + zp * (D(v0[c + sz]) - q)));
        } else v[c] = v0[c];
        if (!(f & 4)) {
          const double a = dt * 0.5 * (nc + D(nut[c - sz])), q = w0[c];
          w[c] = (float)(q + a * (xm * (D(w0[c - 1]) - q) + xp * (D(w0[c + 1]) - q)
            + ym * (D(w0[c - sy]) - q) + yp * (D(w0[c + sy]) - q) + zfm * (D(w0[c - sz]) - q) + zfp * (D(w0[c + sz]) - q)));
        } else w[c] = w0[c];
      }
    }
}

/* ───────── Projection (Red–Black SOR บนกริดไม่สม่ำเสมอ) ─────────
 *   Σ_หน้าอิสระ coef·(φc − φnb) = −∇·u     แล้ว u ← u − ∇φ
 *   pm = บิตของหน้าอิสระหกด้าน (0 = ไม่ใช่เซลล์อากาศ หรือไม่มีหน้าอิสระ), idg = 1 / Σ coef ของหน้าอิสระ
 */

static void job_div(int tid) {
  const int nx = G.nx, ny = G.ny, sy = G.sy, sz = G.sz;
  const float *u = G.u, *v = G.v, *w = G.w;
  float *rhs = G.rhs;
  const u8 *type = G.type;
  const double *rdx = AXT(0, AX_RD), *rdy = AXT(1, AX_RD), *rdz = AXT(2, AX_RD);
  int k0, k1;
  split(tid, 1, G.nz + 1, &k0, &k1);
  for (int k = k0; k < k1; k++)
    for (int j = 1; j <= ny; j++) {
      int c = 1 + j * sy + k * sz;
      const double iy = rdy[j], iz = rdz[k];
      for (int i = 1; i <= nx; i++, c++) {
        if (type[c] != FLUID) continue;
        rhs[c] = (float)((D(u[c + 1]) - D(u[c])) * rdx[i] + (D(v[c + sy]) - D(v[c])) * iy + (D(w[c + sz]) - D(w[c])) * iz);
      }
    }
}

static void sor_pass(int tid, int color) {
  const int nx = G.nx, ny = G.ny, sy = G.sy, sz = G.sz;
  float *phi = G.phi;
  const float *rhs = G.rhs, *idg = G.idg;
  const u8 *pm = G.pm;
  const double om = G.par[P_OMEGA];
  const double *xm = AXT(0, AX_PM), *xp = AXT(0, AX_PP);
  const double *cym = AXT(1, AX_PM), *cyp = AXT(1, AX_PP), *czm = AXT(2, AX_PM), *czp = AXT(2, AX_PP);
  int k0, k1;
  split(tid, 1, G.nz + 1, &k0, &k1);
  for (int k = k0; k < k1; k++) {
    const double zm = czm[k], zp = czp[k];
    for (int j = 1; j <= ny; j++) {
      const double ym = cym[j], yp = cyp[j];
      const int i0 = (((1 + j + k) & 1) == color) ? 1 : 2;
      int c = i0 + j * sy + k * sz;
      for (int i = i0; i <= nx; i += 2, c += 2) {
        const int m = pm[c];
        if (!m) continue;
        const double p = phi[c];
        double s;
        if (m == 63) {
          s = xm[i] * D(phi[c - 1]) + xp[i] * D(phi[c + 1]) + ym * D(phi[c - sy]) + yp * D(phi[c + sy]) + zm * D(phi[c - sz]) + zp * D(phi[c + sz]);
        } else {
          s = 0;
          if (m & 1) s += xm[i] * D(phi[c - 1]);
          if (m & 2) s += xp[i] * D(phi[c + 1]);
          if (m & 4) s += ym * D(phi[c - sy]);
          if (m & 8) s += yp * D(phi[c + sy]);
          if (m & 16) s += zm * D(phi[c - sz]);
          if (m & 32) s += zp * D(phi[c + sz]);
        }
        phi[c] = (float)(p + om * ((s - D(rhs[c])) * D(idg[c]) - p));
      }
    }
  }
}

static void job_correct(int tid) {
  const int nx = G.nx, ny = G.ny, sy = G.sy, sz = G.sz;
  float *u = G.u, *v = G.v, *w = G.w;
  const float *phi = G.phi;
  const u8 *pm = G.pm, *type = G.type;
  const double *rcx = AXT(0, AX_RDC), *rcy = AXT(1, AX_RDC), *rcz = AXT(2, AX_RDC);
  int k0, k1;
  split(tid, 1, G.nz + 1, &k0, &k1);
  for (int k = k0; k < k1; k++)
    for (int j = 1; j <= ny; j++) {
      int c = 1 + j * sy + k * sz;
      for (int i = 1; i <= nx; i++, c++) {
        const int m = pm[c];
        if (!m) continue;
        const double p = phi[c];
        /* ปรับหน้าด้านลบของเซลล์ (หน้าด้านบวกเป็นหน้าด้านลบของเซลล์ถัดไป หรือหน้าขอบเปิดซึ่ง φ = 0) */
        if (m & 1) u[c] = (float)(D(u[c]) - (p - D(phi[c - 1])) * rcx[i]);
        if (m & 4) v[c] = (float)(D(v[c]) - (p - D(phi[c - sy])) * rcy[j]);
        if (m & 16) w[c] = (float)(D(w[c]) - (p - D(phi[c - sz])) * rcz[k]);
        if ((m & 2) && type[c + 1] == OPEN) u[c + 1] = (float)(D(u[c + 1]) + p * rcx[i + 1]);
        if ((m & 8) && type[c + sy] == OPEN) v[c + sy] = (float)(D(v[c + sy]) + p * rcy[j + 1]);
        if ((m & 32) && type[c + sz] == OPEN) w[c + sz] = (float)(D(w[c + sz]) + p * rcz[k + 1]);
      }
    }
}

/* ∇·u ที่เหลือหลัง projection เก็บลง rhs (transport ใช้ชดเชย) + สถิติสำหรับเลือก Δt
 * red[k]: 0 max|u| 1 max|v| 2 max|w| 3 max อัตรา CFL (1/s) 4 max อัตราไหลออกรวม (1/s) 5 Σ(∇·u·L)² */
static void job_stats(int tid) {
  const int nx = G.nx, ny = G.ny, sy = G.sy, sz = G.sz;
  const float *u = G.u, *v = G.v, *w = G.w;
  float *rhs = G.rhs;
  const u8 *type = G.type;
  const double *rdx = AXT(0, AX_RD), *rdy = AXT(1, AX_RD), *rdz = AXT(2, AX_RD);
  const double *cbx = AXT(0, AX_CB), *cby = AXT(1, AX_CB), *cbz = AXT(2, AX_CB);
  int k0, k1;
  split(tid, 1, G.nz + 1, &k0, &k1);
  for (int k = k0; k < k1; k++) {
    double mu = 0, mv = 0, mw = 0, mr = 0, mo = 0, e2 = 0;
    for (int j = 1; j <= ny; j++) {
      int c = 1 + j * sy + k * sz;
      const double iy = rdy[j], iz = rdz[k], lyz = cby[j] * cbz[k];
      for (int i = 1; i <= nx; i++, c++) {
        if (type[c] != FLUID) continue;
        const double ix = rdx[i];
        const double um = u[c], vm = v[c], wm = w[c], up = u[c + 1], vp = v[c + sy], wp = w[c + sz];
        const double au = __builtin_fabs(um), av = __builtin_fabs(vm), aw = __builtin_fabs(wm);
        if (au > mu) mu = au;
        if (av > mv) mv = av;
        if (aw > mw) mw = aw;
        double r = au * ix;
        if (av * iy > r) r = av * iy;
        if (aw * iz > r) r = aw * iz;
        if (r > mr) mr = r;
        const double d = (up - um) * ix + (vp - vm) * iy + (wp - wm) * iz;
        rhs[c] = (float)d;
        const double o = ((up > 0 ? up : 0) - (um < 0 ? um : 0)) * ix + ((vp > 0 ? vp : 0) - (vm < 0 ? vm : 0)) * iy + ((wp > 0 ? wp : 0) - (wm < 0 ? wm : 0)) * iz;
        if (o > mo) mo = o;
        const double e = d * cbx[i] * lyz;
        e2 += e * e;
      }
    }
    double *R = G.red + k * RED;
    R[0] = mu; R[1] = mv; R[2] = mw; R[3] = mr; R[4] = mo; R[5] = e2;
  }
}

/* ทุกรอบ SOR อยู่ในงานเดียว: แต่ละเธรดทำชั้นของตัวเองทีละสี แล้วนัดพบกันก่อนเปลี่ยนสี */
static int sor_iters;
static void job_sor(int tid) {
  const int nt = team();
  for (int it = 0; it < sor_iters; it++)
    for (int color = 0; color < 2; color++) {
      sor_pass(tid, color);
      barrier((2 * it + color + 1) * nt);
    }
}

EXPORT(project)
void project(int iters) {
  run(J_DIV);
  sor_iters = iters;
  barrier_reset();
  run(J_SOR);
  run(J_CORRECT);
  run(J_STATS);
  double mu = 0, mv = 0, mw = 0, mr = 0, mo = 0, e2 = 0;
  for (int k = 1; k <= G.nz; k++) {
    const double *R = G.red + k * RED;
    if (R[0] > mu) mu = R[0];
    if (R[1] > mv) mv = R[1];
    if (R[2] > mw) mw = R[2];
    if (R[3] > mr) mr = R[3];
    if (R[4] > mo) mo = R[4];
    e2 += R[5];
  }
  double *o = G.par;
  o[O_MAXU] = mu; o[O_MAXV] = mv; o[O_MAXW] = mw; o[O_RATE] = mr; o[O_OUT] = mo; o[O_E2] = e2;
}

/* ───────── การพาอุณหภูมิและ tracer (finite volume, MUSCL + van Leer) ─────────
 *
 * ฟลักซ์ต่อหน่วยพื้นที่ที่หน้าระหว่างเซลล์ a (ด้านลบ, ดัชนี ia-1 ตามแกน) กับ c (ด้านบวก, ดัชนี ia)
 *   อากาศ–อากาศ : ค่าที่หน้า = ค่าต้นลม + ½·ความกว้างเซลล์ต้นลม·ความชันจำกัดแบบ van Leer, + การแพร่
 *   อากาศ–ของแข็ง: เฉพาะหน้าที่กำหนดความเร็ว (พัดลม/คอยล์ของ CDU) ใช้ค่าของเซลล์ต้นลม
 *                  — เซลล์ทึบใต้พัดลมเก็บอุณหภูมิลมเป่าและ tracer = 1 ไว้ (ตั้งจาก solver.js)
 *   อากาศ–ขอบเปิด: ลมเข้าเป็นอากาศภายนอก ลมออกใช้ค่าเซลล์ด้านใน
 * qo = ความร้อนที่ออกทางขอบเปิดต่อหน่วยพื้นที่ (ผู้เรียกคูณพื้นที่หน้า)
 */
__attribute__((always_inline)) static inline void face_flux(int a, int c, int st, double vf, const double *dw, const double *rdc, int ia,
                             const u8 *type, const float *T0, const float *C0, const float *nut,
                             double ka, double acapk, double amb, double *fT, double *fC, double *qo) {
  const int ta = type[a], tb = type[c];
  if ((ta | tb) == 0) {
    double sT, sC;
    if (vf > 0) {
      const double ta0 = T0[a], ca0 = C0[a];
      sT = ta0; sC = ca0;
      const int m = a - st;
      if (type[m] == 0) {
        const double r1 = rdc[ia - 1], r2 = rdc[ia], hw = dw[ia - 1];
        double d1 = (ta0 - D(T0[m])) * r1, d2 = (D(T0[c]) - ta0) * r2, p = d1 * d2;
        if (p > 0) sT += hw * p / (d1 + d2);
        d1 = (ca0 - D(C0[m])) * r1; d2 = (D(C0[c]) - ca0) * r2; p = d1 * d2;
        if (p > 0) sC += hw * p / (d1 + d2);
      }
    } else {
      const double tb0 = T0[c], cb0 = C0[c];
      sT = tb0; sC = cb0;
      const int m = c + st;
      if (type[m] == 0) {
        const double r1 = rdc[ia + 1], r2 = rdc[ia], hw = dw[ia];
        double d1 = (tb0 - D(T0[m])) * r1, d2 = (D(T0[a]) - tb0) * r2, p = d1 * d2;
        if (p > 0) sT += hw * p / (d1 + d2);
        d1 = (cb0 - D(C0[m])) * r1; d2 = (D(C0[a]) - cb0) * r2; p = d1 * d2;
        if (p > 0) sC += hw * p / (d1 + d2);
      }
    }
    const double r = rdc[ia];
    /* αt จำกัดไม่เกิน 0.12·Δ²/Δt (เสถียรภาพของการแพร่แบบ explicit) — เทียบแบบไม่ต้องหาร */
    double g = ka * (D(nut[a]) + D(nut[c])) * r;
    if (g * r > acapk) g = acapk / r;
    *fT = vf * sT - g * (D(T0[c]) - D(T0[a]));
    *fC = vf * sC - g * (D(C0[c]) - D(C0[a]));
    return;
  }
  *fT = 0; *fC = 0;
  if (ta != FLUID && tb != FLUID) return;
  if (ta == SOLID || tb == SOLID) {
    if (vf == 0) return;
    const int f = vf > 0 ? a : c;
    *fT = vf * D(T0[f]); *fC = vf * D(C0[f]);
    return;
  }
  const int f = ta == FLUID ? a : c;
  const int inflow = ta == FLUID ? vf < 0 : vf > 0;
  const double sT = inflow ? amb : D(T0[f]), sC = inflow ? 0 : D(C0[f]);
  const double r = rdc[ia];
  double g = 2 * ka * D(nut[f]) * r;
  if (g * r > acapk) g = acapk / r;
  const double FT = vf * sT - g * (ta == FLUID ? amb - D(T0[a]) : D(T0[c]) - amb);
  *fT = FT;
  *fC = vf * sC - g * (ta == FLUID ? -D(C0[a]) : D(C0[c]));
  *qo += ta == FLUID ? FT - vf * amb : -(FT - vf * amb);
}

/* red[k]: 0 = ความร้อนออกทางขอบ (K·m³/s), 1 = Σ ΔT·ปริมาตร (K·m³)
 * ฟลักซ์ของแต่ละหน้าคำนวณครั้งเดียวแล้วส่งต่อให้เซลล์ถัดไป (ตัวแปร / บัฟเฟอร์แถว / บัฟเฟอร์ระนาบ)
 * หน้าที่อยู่ระหว่างช่วงของสองเธรดคำนวณซ้ำทั้งสองฝั่งด้วยสูตรเดียวกัน → ค่าตรงกันทุกบิต ยังอนุรักษ์ */
static void job_transport(int tid) {
  const int nx = G.nx, ny = G.ny, NX = G.NX, NY = G.NY, sy = G.sy, sz = G.sz;
  const float *u = G.u, *v = G.v, *w = G.w, *T0 = G.T0, *C0 = G.C0, *nut = G.nut, *dv = G.rhs;
  float *T = G.T, *C = G.C;
  const u8 *type = G.type;
  const double dt = G.par[P_DT], ka = G.par[P_KA], amb = G.par[P_AMB], acapk = 0.12 / dt;
  const double *dx = AXT(0, AX_D), *rdx = AXT(0, AX_RD), *rcx = AXT(0, AX_RDC);
  const double *dy = AXT(1, AX_D), *rdy = AXT(1, AX_RD), *rcy = AXT(1, AX_RDC);
  const double *dz = AXT(2, AX_D), *rdz = AXT(2, AX_RD), *rcz = AXT(2, AX_RDC);
  const int plane = NX * NY;
  double *fzT = G.scratch + (long)tid * (2 * plane + 2 * NX), *fzC = fzT + plane, *fyT = fzC + plane, *fyC = fyT + NX;
  int k0, k1;
  split(tid, 1, G.nz + 1, &k0, &k1);
  if (k0 >= k1) return;
  /* ฟลักซ์ผ่านหน้า z ด้านลบของชั้นแรก */
  {
    double q = 0;
    for (int j = 1; j <= ny; j++) {
      int c = 1 + j * sy + k0 * sz;
      for (int i = 1; i <= nx; i++, c++) {
        double qo = 0;
        face_flux(c - sz, c, sz, w[c], dz, rcz, k0, type, T0, C0, nut, ka, acapk, amb, &fzT[i + j * NX], &fzC[i + j * NX], &qo);
        q += qo * dx[i] * dy[j];
      }
    }
    double *R = G.red + k0 * RED;
    R[0] = k0 == 1 ? q : 0; R[1] = 0;
  }
  for (int k = k0; k < k1; k++) {
    double qOut = 0, dE = 0;
    const double izk = rdz[k], dzk = dz[k];
    {
      int c = 1 + sy + k * sz;
      for (int i = 1; i <= nx; i++, c++) {
        double qo = 0;
        face_flux(c - sy, c, sy, v[c], dy, rcy, 1, type, T0, C0, nut, ka, acapk, amb, &fyT[i], &fyC[i], &qo);
        qOut += qo * dx[i] * dzk;
      }
    }
    for (int j = 1; j <= ny; j++) {
      int c = 1 + j * sy + k * sz;
      const double iyj = rdy[j], dyj = dy[j], ayz = dyj * dzk;
      double fxT, fxC, qo = 0;
      face_flux(c - 1, c, 1, u[c], dx, rcx, 1, type, T0, C0, nut, ka, acapk, amb, &fxT, &fxC, &qo);
      qOut += qo * ayz;
      for (int i = 1; i <= nx; i++, c++) {
        const int q = i + j * NX;
        double pxT, pxC, pyT, pyC, pzT, pzC, qx = 0, qy = 0, qz = 0;
        face_flux(c, c + 1, 1, u[c + 1], dx, rcx, i + 1, type, T0, C0, nut, ka, acapk, amb, &pxT, &pxC, &qx);
        face_flux(c, c + sy, sy, v[c + sy], dy, rcy, j + 1, type, T0, C0, nut, ka, acapk, amb, &pyT, &pyC, &qy);
        face_flux(c, c + sz, sz, w[c + sz], dz, rcz, k + 1, type, T0, C0, nut, ka, acapk, amb, &pzT, &pzC, &qz);
        const double dxi = dx[i];
        qOut += qx * ayz + qy * dxi * dzk + qz * dxi * dyj;
        if (type[c] == FLUID) {
          const double ixi = rdx[i], t0 = T0[c], c0 = C0[c], d = dv[c];
          /* + S·(∇·u) ชดเชยความคลาดเคลื่อนของมวลที่เหลือจาก projection (สนามคงที่ยังคงที่) */
          double t = t0 + dt * ((fxT - pxT) * ixi + (fyT[i] - pyT) * iyj + (fzT[q] - pzT) * izk + t0 * d);
          double s = c0 + dt * ((fxC - pxC) * ixi + (fyC[i] - pyC) * iyj + (fzC[q] - pzC) * izk + c0 * d);
          if (t < amb - 2) t = amb - 2; else if (t > amb + 70) t = amb + 70;
          if (s < 0) s = 0; else if (s > 1) s = 1;
          dE += (t - t0) * dxi * ayz;
          T[c] = (float)t; C[c] = (float)s;
        }
        fxT = pxT; fxC = pxC; fyT[i] = pyT; fyC[i] = pyC; fzT[q] = pzT; fzC[q] = pzC;
      }
    }
    double *R = G.red + k * RED;
    R[0] += qOut; R[1] = dE;
    if (k + 1 < k1) { R[RED] = 0; R[RED + 1] = 0; }
  }
}

EXPORT(transport)
void transport(void) {
  run(J_TRANSPORT);
  double q = 0, e = 0;
  for (int k = 1; k <= G.nz; k++) { q += G.red[k * RED]; e += G.red[k * RED + 1]; }
  G.par[O_QOUT] = q; G.par[O_DE] = e;
}

/* ───────── Residual: Σ การเปลี่ยนแปลง² ของเซลล์อากาศเทียบค่าที่เก็บไว้ครั้งก่อน แล้วเก็บค่าปัจจุบัน ───────── */

static void job_resid(int tid) {
  const int NX = G.NX, NY = G.NY, sy = G.sy, sz = G.sz;
  const float *u = G.u, *v = G.v, *w = G.w, *T = G.T;
  float *pu = G.pu, *pv = G.pv, *pw = G.pw, *pT = G.pT;
  const u8 *type = G.type;
  int k0, k1;
  split(tid, 0, G.NZ, &k0, &k1);
  for (int k = k0; k < k1; k++) {
    double du = 0, dT = 0;
    for (int j = 0; j < NY; j++) {
      int c = j * sy + k * sz;
      for (int i = 0; i < NX; i++, c++) {
        if (type[c] == FLUID) {
          const double x = D(u[c]) - D(pu[c]), y = D(v[c]) - D(pv[c]), z = D(w[c]) - D(pw[c]), t = D(T[c]) - D(pT[c]);
          du += x * x + y * y + z * z; dT += t * t;
        }
        pu[c] = u[c]; pv[c] = v[c]; pw[c] = w[c]; pT[c] = T[c];
      }
    }
    G.red[k * RED] = du; G.red[k * RED + 1] = dT;
  }
}

EXPORT(residual)
void residual(void) {
  run(J_RESID);
  double a = 0, b = 0;
  for (int k = 0; k < G.NZ; k++) { a += G.red[k * RED]; b += G.red[k * RED + 1]; }
  G.par[O_DU2] = a; G.par[O_DT2] = b;
}

/* ───────── จุดเรียกจาก JS ───────── */

EXPORT(advect) void advect(void) { run(J_ADVECT); }
EXPORT(buoyancy) void buoyancy(void) { run(J_BUOY); }
EXPORT(turbulence) void turbulence(void) { run(J_TURB_A); run(J_TURB_B); }
EXPORT(diffuse) void diffuse(void) { run(J_DIFFUSE); }

static void run_job(int job, int tid) {
  switch (job) {
    case J_ADVECT: job_advect(tid); break;
    case J_BUOY: job_buoyancy(tid); break;
    case J_TURB_A: job_turb_a(tid); break;
    case J_TURB_B: job_turb_b(tid); break;
    case J_DIFFUSE: job_diffuse(tid); break;
    case J_DIV: job_div(tid); break;
    case J_SOR: job_sor(tid); break;
    case J_CORRECT: job_correct(tid); break;
    case J_STATS: job_stats(tid); break;
    case J_TRANSPORT: job_transport(tid); break;
    case J_RESID: job_resid(tid); break;
  }
}
