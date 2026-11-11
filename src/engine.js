/*
 * engine.js — ตัวขับการคำนวณ: รับคำสั่ง init/run/pause แล้วเดินสเต็ปเป็นช่วง ๆ
 * ส่งรายงานความคืบหน้าและสนามค่ากลับไปเป็นระยะ
 *
 * ใช้โค้ดชุดเดียวกันทั้งใน Web Worker (worker.js) และบน main thread (สำรอง เมื่อเบราว์เซอร์
 * ไม่อนุญาตให้สร้าง Worker เช่นเปิดไฟล์จาก file:// ในบางเบราว์เซอร์)
 */

import { Solver } from './solver.js';
import { GpuSolver } from './gpu-solver.js';
import { createKernelsAsync, maxThreads } from './kernels.js';

export function createEngine(post, { slice = 120, fieldEvery = 450 } = {}) {
  let solver = null, running = false, timer = 0, lastField = 0, busy = false;

  // fields() / step() ของ solver แบบ GPU เป็น asynchronous (รออ่านผลกลับจากการ์ดจอ) แบบ CPU คืนค่าทันที
  const send = async (withFields) => {
    const s = solver;
    if (!s) return;
    const msg = { type: 'progress', report: s.report(), running };
    if (withFields) {
      const f = await s.fields();
      if (solver !== s) return;
      msg.fields = f;
      post(msg, [f.T.buffer, f.C.buffer, f.u.buffer, f.v.buffer, f.w.buffer, f.P.buffer]);
    } else post(msg);
  };

  const fail = (err) => {
    running = false;
    clearTimeout(timer); timer = 0;
    solver?.dispose(); solver = null;
    post({ type: 'error', message: err?.message || String(err) });
  };

  const loop = async () => {
    timer = 0;
    const s = solver;
    if (!running || !s || busy) return;
    busy = true;
    try {
      const t0 = performance.now();
      while (performance.now() - t0 < slice) {
        await s.step();
        if (solver !== s || !running) break;
        if (s.converged || s.time >= s.tMax) break;
      }
      if (solver !== s) return;          // ถูกเริ่มใหม่/ยกเลิกระหว่างรอ GPU
      const now = performance.now();
      const done = s.converged || s.time >= s.tMax;
      if (done) running = false;
      // เมชใหญ่: ส่งสนามค่าไปแสดงผลห่างขึ้น (สำเนา 24 ไบต์ต่อเซลล์ต่อครั้ง) — ราว 0.4 วินาทีต่อล้านเซลล์
      const wantFields = done || now - lastField > Math.max(fieldEvery, s.N * 4e-4);
      if (wantFields) lastField = now;
      await send(wantFields);
      if (solver !== s) return;
      if (done) post({ type: 'done', reason: s.converged ? 'converged' : 'limit', report: s.report() });
      else if (running) timer = setTimeout(loop, 0);
    } catch (err) {
      if (solver === s) fail(err);
    } finally {
      busy = false;
      // คำสั่ง run ที่เข้ามาระหว่างรอบนี้ยังไม่จบ
      if (running && solver && !timer) timer = setTimeout(loop, 0);
    }
  };

  /** สร้าง solver ตามที่ผู้ใช้เลือก: 'gpu' = WebGPU (ถ้าใช้ไม่ได้ถอยไป CPU พร้อมบอกเหตุผล), อื่น ๆ = WebAssembly */
  const createSolver = async (msg) => {
    let gpuError = null;
    if (msg.backend === 'gpu') {
      try {
        return { solver: await GpuSolver.create(msg.mesh, msg.params), gpuError };
      } catch (err) {
        gpuError = err?.message || String(err);
      }
    }
    // ใช้ทุกแกนประมวลผลที่มี (เว้นไว้หนึ่งแกนให้หน้าจอเมื่อเครื่องมีมากกว่า 4 แกน) — ได้หลายเธรดเฉพาะเมื่อ
    // หน้าเว็บเป็น cross-origin isolated (ดู kernels.js) ไม่เช่นนั้น maxThreads() = 1
    const avail = maxThreads();
    const threads = Math.max(1, Math.min(msg.threads || (avail > 4 ? avail - 1 : avail), avail));
    const kernels = await createKernelsAsync(Solver.memoryBytes(msg.mesh, threads), { threads });
    if (!kernels) throw new Error('เบราว์เซอร์นี้ใช้ WebAssembly ไม่ได้ — ไม่สามารถคำนวณได้');
    try {
      return { solver: new Solver(msg.mesh, { ...msg.params, kernels }), gpuError };
    } catch (err) {
      kernels.dispose();
      throw err;
    }
  };

  // คำสั่งถูกประมวลผลตามลำดับ — init รอสร้าง solver (โหลด WebAssembly / เตรียม GPU) ก่อน
  // คำสั่ง run ที่ส่งตามมาทันทีจึงไม่หลุด
  let queue = Promise.resolve();

  const handleMsg = async (msg) => {
    if (msg.cmd === 'init') {
      running = false;
      clearTimeout(timer); timer = 0;
      solver?.dispose(); solver = null;
      const t0 = performance.now();
      let made;
      try {
        made = await createSolver(msg);
      } catch (err) {
        post({ type: 'error', message: err?.message || String(err) });
        return;
      }
      solver = made.solver;
      post({
        type: 'ready', ms: performance.now() - t0, backend: solver.backend || 'cpu', threads: solver.threads,
        device: solver.deviceName || '', software: !!solver.software, gpuError: made.gpuError,
        isolated: !!globalThis.crossOriginIsolated,
      });
      await send(true);
    } else if (msg.cmd === 'run') {
      if (!solver) return;
      if (msg.tMax) solver.tMax = msg.tMax;
      // สั่งเดินต่อหลังชนเพดานเวลา → ขยายเพดานออกไปอีกเท่าเดิม
      if (solver.time >= solver.tMax) solver.tMax = solver.time + (msg.tMax || 600);
      running = true;
      if (!timer && !busy) timer = setTimeout(loop, 0);
    } else if (msg.cmd === 'pause') {
      running = false;
      clearTimeout(timer); timer = 0;
      // รอให้สเต็ปที่ค้างอยู่ (GPU) จบก่อนอ่านสนามค่า
      while (busy) await new Promise(r => setTimeout(r, 5));
      if (solver) await send(true);
    } else if (msg.cmd === 'dispose') {
      running = false;
      clearTimeout(timer); timer = 0;
      solver?.dispose(); solver = null;
    }
  };

  return {
    handle(msg) {
      queue = queue.then(() => handleMsg(msg)).catch(err => fail(err));
    },
  };
}
