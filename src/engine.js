/*
 * engine.js — ตัวขับการคำนวณ: รับคำสั่ง init/run/pause แล้วเดินสเต็ปเป็นช่วง ๆ
 * ส่งรายงานความคืบหน้าและสนามค่ากลับไปเป็นระยะ
 *
 * ใช้โค้ดชุดเดียวกันทั้งใน Web Worker (worker.js) และบน main thread (สำรอง เมื่อเบราว์เซอร์
 * ไม่อนุญาตให้สร้าง Worker เช่นเปิดไฟล์จาก file:// ในบางเบราว์เซอร์)
 */

import { Solver } from './solver.js';
import { createKernelsAsync } from './kernels.js';

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
    const wantFields = done || now - lastField > fieldEvery;
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
      solver = null;
      const t0 = performance.now();
      const kernels = await createKernelsAsync(Solver.memoryBytes(msg.mesh));
      solver = new Solver(msg.mesh, { ...msg.params, kernels });
      post({ type: 'ready', ms: performance.now() - t0, wasm: !!kernels });
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
      solver = null;
    }
  };

  return {
    handle(msg) {
      // ข้อผิดพลาดโยนต่อแบบไม่ผูกกับ promise เพื่อให้ worker.onerror ทำงาน (runner ถอยไปใช้ main thread)
      queue = queue.then(() => handleMsg(msg)).catch(err => setTimeout(() => { throw err; }));
    },
  };
}
