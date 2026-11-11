/*
 * kernels.js — โหลดลูปหนักที่คอมไพล์เป็น WebAssembly (src/kernels.c → src/kernels-wasm.js)
 * และจัดการเธรดช่วยงาน
 *
 * solver.js วางอาร์เรย์ทั้งหมดไว้ใน linear memory ของ WebAssembly แล้วเรียกฟังก์ชันใน kernels.c
 *
 * หลายเธรด: ใช้ได้เมื่อมี SharedArrayBuffer (หน้าเว็บเป็น cross-origin isolated — ดู README) และอยู่ใน
 * Web Worker หรือ Node เธรดช่วยงานแต่ละตัวเป็น Worker ที่ instantiate โมดูลเดียวกันบนหน่วยความจำร่วม
 * มีสแตกของตัวเอง แล้วเข้าไปรองานใน worker_main() ถ้าเงื่อนไขไม่ครบจะใช้โมดูลเธรดเดียวโดยอัตโนมัติ
 */

import { KERNELS_WASM, KERNELS_WASM_MT } from './kernels-wasm.js';

const RESERVE = 1 << 20;        // สแตกและพื้นที่คงที่ของโมดูล (ต้องการจริงราว 64 KB)
export const STACK_BYTES = 1 << 16;    // สแตกของเธรดช่วยงานแต่ละตัว
export const MAX_THREADS = 16;
const cache = {};

const decode = b64 => Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
const pagesFor = size => Math.ceil((size + RESERVE) / 65536);

function wrap(instance, memory, extra = {}) {
  const ex = instance.exports;
  const limit = memory.buffer.byteLength;
  let off = ex.__heap_base.value;
  return {
    ex, memory, threads: 1, dispose() {},
    /** จองอาร์เรย์ใน linear memory (หน่วยความจำไม่ขยายภายหลัง view จึงใช้ได้ตลอด) */
    alloc(T, n) {
      off = (off + 15) & ~15;
      const a = new T(memory.buffer, off, n);
      off += n * T.BYTES_PER_ELEMENT;
      if (off > limit) throw new Error('kernels: หน่วยความจำไม่พอ');
      return a;
    },
    ...extra,
  };
}

/** ขนาดหน่วยความจำที่ต้องจองเพิ่มสำหรับอาร์เรย์ n ตัว (เผื่อการจัดแนว 16 ไบต์) */
export const ALIGN_SLACK = 16;

const wasmOK = () => !globalThis.__CFD_NO_WASM__ && typeof WebAssembly === 'object';

/** สร้างแบบ synchronous เธรดเดียว — ใช้ได้ใน Web Worker และ Node; คืน null ถ้าใช้ไม่ได้ */
export function createKernels(size) {
  if (!wasmOK()) return null;
  try {
    cache.sync = cache.sync || new WebAssembly.Module(decode(KERNELS_WASM));
    const memory = new WebAssembly.Memory({ initial: pagesFor(size) });
    return wrap(new WebAssembly.Instance(cache.sync, { env: { memory } }), memory);
  } catch {
    return null;
  }
}

/* ───────── เธรดช่วยงาน ───────── */

const HELPER_BODY = `
  const { module, memory, tid, sp } = data;
  const inst = await WebAssembly.instantiate(module, { env: { memory } });
  inst.exports.__stack_pointer.value = sp;
  post('ready');
  inst.exports.worker_main(tid);
`;
const HELPER_WEB = `self.onmessage = async (e) => { const data = e.data, post = (m) => self.postMessage(m); ${HELPER_BODY} };`;
const HELPER_NODE = `const { parentPort } = require('node:worker_threads');
parentPort.once('message', async (data) => { const post = (m) => parentPort.postMessage(m); ${HELPER_BODY} });`;

const nodeThreads = () => {
  try { return globalThis.process?.versions?.node ? globalThis.process.getBuiltinModule?.('node:worker_threads') : null; } catch { return null; }
};

/** จำนวนเธรดที่สภาพแวดล้อมนี้ใช้ได้ (1 = ใช้หลายเธรดไม่ได้) */
export function maxThreads() {
  if (!wasmOK() || typeof SharedArrayBuffer !== 'function') return 1;
  const nt = nodeThreads();
  if (nt) return Math.min(MAX_THREADS, Math.max(1, nt.availableParallelism?.() || globalThis.navigator?.hardwareConcurrency || 1));
  // เบราว์เซอร์: ต้องเป็น cross-origin isolated และอยู่ใน Worker (main thread ห้ามรอแบบ blocking)
  if (!globalThis.crossOriginIsolated || typeof WorkerGlobalScope === 'undefined' || typeof Worker !== 'function') return 1;
  return Math.min(MAX_THREADS, Math.max(1, globalThis.navigator?.hardwareConcurrency || 1));
}

function spawnHelper(msg) {
  return new Promise((resolve, reject) => {
    const nt = nodeThreads();
    let w;
    const timer = setTimeout(() => reject(new Error('helper timeout')), 8000);
    const ok = () => { clearTimeout(timer); resolve(w); };
    const bad = (e) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(e?.message || 'helper error')); };
    if (nt) {
      w = new nt.Worker(HELPER_NODE, { eval: true });
      w.once('message', ok); w.once('error', bad);
      w.unref();
    } else {
      const url = URL.createObjectURL(new Blob([HELPER_WEB], { type: 'text/javascript' }));
      w = new Worker(url);
      w.onmessage = ok; w.onerror = bad;
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
    w.postMessage(msg);
  });
}

async function createThreaded(size, threads) {
  cache.mt = cache.mt || WebAssembly.compile(decode(KERNELS_WASM_MT));
  const module = await cache.mt;
  const pages = pagesFor(size + threads * (STACK_BYTES + ALIGN_SLACK));
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
  const instance = await WebAssembly.instantiate(module, { env: { memory } });
  const workers = [];
  const k = wrap(instance, memory, {
    threads,
    dispose() { for (const w of workers) { try { w.terminate(); } catch { /* ignore */ } } workers.length = 0; },
  });
  try {
    const jobs = [];
    for (let tid = 1; tid < threads; tid++) {
      const stack = k.alloc(Uint8Array, STACK_BYTES);
      jobs.push(spawnHelper({ module, memory, tid, sp: stack.byteOffset + STACK_BYTES }));
    }
    const res = await Promise.allSettled(jobs);
    for (const r of res) if (r.status === 'fulfilled') workers.push(r.value);
    if (workers.length !== threads - 1) throw new Error('สร้างเธรดช่วยงานไม่ครบ');
    k.ex.set_helpers(threads - 1);
    return k;
  } catch (err) {
    k.dispose();
    throw err;
  }
}

/**
 * สร้างแบบ asynchronous — ใช้ได้ทุกที่รวมถึง main thread ของเบราว์เซอร์; คืน null ถ้าใช้ WebAssembly ไม่ได้
 * threads > 1 จะพยายามใช้หลายเธรด ถ้าไม่สำเร็จจะถอยไปใช้เธรดเดียว
 */
export async function createKernelsAsync(size, { threads = 1 } = {}) {
  if (!wasmOK()) return null;
  const n = Math.max(1, Math.min(threads | 0, maxThreads()));
  if (n > 1) {
    try { return await createThreaded(size, n); } catch (err) { console.warn('หลายเธรดใช้ไม่ได้ — ใช้เธรดเดียว:', err?.message || err); }
  }
  try {
    cache.st = cache.st || WebAssembly.compile(decode(KERNELS_WASM));
    const memory = new WebAssembly.Memory({ initial: pagesFor(size) });
    return wrap(await WebAssembly.instantiate(await cache.st, { env: { memory } }), memory);
  } catch {
    return null;
  }
}
