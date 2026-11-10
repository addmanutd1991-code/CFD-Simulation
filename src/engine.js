/*
 * engine.js — ตัวขับการคำนวณ: รับคำสั่ง init/run/pause แล้วเดินสเต็ปเป็นช่วง ๆ
 * ส่งรายงานความคืบหน้าและสนามค่ากลับไปเป็นระยะ
 *
 * ใช้โค้ดชุดเดียวกันทั้งใน Web Worker (worker.js) และบน main thread (สำรอง เมื่อเบราว์เซอร์
 * ไม่อนุญาตให้สร้าง Worker เช่นเปิดไฟล์จาก file:// ในบางเบราว์เซอร์)
 */

import { Solver } from './solver.js';
import { createKernelsAsync, maxThreads } from './kernels.js';

export function createEngine(post, { slice = 120, fieldEvery = 450 } = {}) {
  let solver = null, running = false, timer = 0, lastField = 0;

  const send = (withFields) => {
    const msg = { type: 'progress', report: solver.report(), running };
    if (withFields) {
      const f = solver.fields();
      msg.fields = f;
      post(msg, [f.T.buffer, f.C.buffer, f.u.buffer, f.v.buffer, f.w.buffer, f.P.buffer]);
    } else post(msg);
  };

  const loop = () => {
    timer = 0;
    if (!running || !solver) return;
    const t0 = performance.now();
    while (performance.now() - t0 < slice) {
      solver.step();
      if (solver.converged || solver.time >= solver.tMax) break;
    }
    const now = performance.now();
    const done = solver.converged || solver.time >= solver.tMax;
    if (done) running = false;
    // เมชใหญ่: ส่งสนามค่าไปแสดงผลห่างขึ้น (สำเนา 24 ไบต์ต่อเซลล์ต่อครั้ง) — ราว 0.4 วินาทีต่อล้านเซลล์
    const wantFields = done || now - lastField > Math.max(fieldEvery, solver.N * 4e-4);
    if (wantFields) lastField = now;
    send(wantFields);
    if (done) post({ type: 'done', reason: solver.converged ? 'converged' : 'limit', report: solver.report() });
    else timer = setTimeout(loop, 0);
  };

  // คำสั่งถูกประมวลผลตามลำดับ — init รอโหลด WebAssembly (แบบ async ใช้ได้ทั้งใน worker และ
  // main thread) ก่อน คำสั่ง run ที่ส่งตามมาทันทีจึงไม่หลุด
  let queue = Promise.resolve();

  const handleMsg = async (msg) => {
    if (msg.cmd === 'init') {
      running = false;
      clearTimeout(timer); timer = 0;
      solver?.dispose(); solver = null;
      const t0 = performance.now();
      // ใช้ทุกแกนประมวลผลที่มี (เว้นไว้หนึ่งแกนให้หน้าจอเมื่อเครื่องมีมากกว่า 4 แกน) — ได้หลายเธรดเฉพาะเมื่อ
      // หน้าเว็บเป็น cross-origin isolated (ดู kernels.js) ไม่เช่นนั้น maxThreads() = 1
      const avail = maxThreads();
      const threads = Math.max(1, Math.min(msg.threads || (avail > 4 ? avail - 1 : avail), avail));
      const kernels = await createKernelsAsync(Solver.memoryBytes(msg.mesh, threads), { threads });
      if (!kernels) {
        post({ type: 'error', message: 'เบราว์เซอร์นี้ใช้ WebAssembly ไม่ได้ — ไม่สามารถคำนวณได้' });
        return;
      }
      try {
        solver = new Solver(msg.mesh, { ...msg.params, kernels });
      } catch (err) {
        kernels.dispose();
        post({ type: 'error', message: err?.message || String(err) });
        return;
      }
      post({ type: 'ready', ms: performance.now() - t0, threads: solver.threads, isolated: !!globalThis.crossOriginIsolated });
      send(true);
    } else if (msg.cmd === 'run') {
      if (!solver) return;
      if (msg.tMax) solver.tMax = msg.tMax;
      // สั่งเดินต่อหลังชนเพดานเวลา → ขยายเพดานออกไปอีกเท่าเดิม
      if (solver.time >= solver.tMax) solver.tMax = solver.time + (msg.tMax || 600);
      running = true;
      if (!timer) timer = setTimeout(loop, 0);
    } else if (msg.cmd === 'pause') {
      running = false;
      clearTimeout(timer); timer = 0;
      if (solver) send(true);
    } else if (msg.cmd === 'dispose') {
      running = false;
      clearTimeout(timer); timer = 0;
      solver?.dispose(); solver = null;
    }
  };

  return {
    handle(msg) {
      // ข้อผิดพลาดโยนต่อแบบไม่ผูกกับ promise เพื่อให้ worker.onerror ทำงาน (runner ถอยไปใช้ main thread)
      queue = queue.then(() => handleMsg(msg)).catch(err => setTimeout(() => { throw err; }));
    },
  };
}
