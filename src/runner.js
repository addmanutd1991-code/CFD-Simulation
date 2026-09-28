/*
 * runner.js — เลือกว่าจะคำนวณใน Web Worker หรือบน main thread
 *
 * ไฟล์รวมชิ้นเดียว (dist/*.html) ฝังโค้ด worker ไว้เป็นข้อความใน globalThis.__CFD_WORKER_SRC__
 * จึงสร้าง Worker จาก Blob ได้แม้เปิดจาก file:// ถ้าเบราว์เซอร์ยังไม่ยอม จะถอยไปคำนวณบน
 * main thread โดยแบ่งเป็นช่วงสั้น ๆ ให้หน้าจอยังตอบสนอง
 */

import { createEngine } from './engine.js';

export class Runner {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.mode = 'worker';
    this.worker = null;
    this.engine = null;
    this.#start();
  }

  #start() {
    try {
      const src = globalThis.__CFD_WORKER_SRC__;
      if (src) {
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        this.worker = new Worker(url);
      } else {
        this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      }
      this.worker.onmessage = (e) => this.onMessage(e.data);
      this.worker.onerror = (e) => {
        e.preventDefault?.();
        this.#fallback(e.message || 'worker error');
      };
    } catch (err) {
      this.#fallback(err.message);
    }
  }

  #fallback(reason) {
    if (this.mode === 'main') return;
    console.warn('Web Worker ใช้ไม่ได้ — คำนวณบน main thread แทน:', reason);
    try { this.worker?.terminate(); } catch { /* ignore */ }
    this.worker = null;
    this.mode = 'main';
    this.engine = createEngine((msg) => setTimeout(() => this.onMessage(msg), 0), { slice: 30, fieldEvery: 700 });
    if (this.pendingInit) this.engine.handle(this.pendingInit);
    if (this.pendingRun) this.engine.handle({ cmd: 'run' });
    this.onMessage({ type: 'mode', mode: 'main', reason });
  }

  send(msg, transfer) {
    if (msg.cmd === 'init') { this.pendingInit = msg; this.pendingRun = false; }
    if (msg.cmd === 'run') this.pendingRun = true;
    if (msg.cmd === 'pause' || msg.cmd === 'dispose') this.pendingRun = false;
    if (this.mode === 'worker' && this.worker) {
      // ไม่โอน (transfer) buffer ของ init เพื่อให้ถอยไปใช้ main thread ได้ถ้า worker ล้มเหลว
      this.worker.postMessage(msg, transfer || []);
    } else if (this.engine) this.engine.handle(msg);
  }
}
