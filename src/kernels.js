/*
 * kernels.js — โหลดลูปหนักที่คอมไพล์เป็น WebAssembly (src/kernels.c → src/kernels-wasm.js)
 *
 * solver.js วางอาร์เรย์ทั้งหมดไว้ใน linear memory ของ WebAssembly แล้วเรียกฟังก์ชันใน kernels.c
 * ถ้าโหลดไม่ได้ (เบราว์เซอร์เก่า หรือ main thread ที่ห้ามคอมไพล์แบบ synchronous) จะใช้โค้ด
 * JavaScript ชุดเดิมใน solver.js ซึ่งให้ผลตรงกันทุกบิต เพียงแต่ช้ากว่า
 */

import { KERNELS_WASM } from './kernels-wasm.js';

const RESERVE = 1 << 20;   // สแตกและพื้นที่คงที่ของโมดูล (ต้องการจริงราว 64 KB)
let bytes = null, moduleSync = null, moduleAsync = null;

const getBytes = () => bytes || (bytes = Uint8Array.from(atob(KERNELS_WASM), ch => ch.charCodeAt(0)));
const newMemory = size => new WebAssembly.Memory({ initial: Math.ceil((size + RESERVE) / 65536) });

function wrap(instance, memory) {
  const ex = instance.exports;
  const limit = memory.buffer.byteLength;
  let off = ex.__heap_base.value;
  return {
    ex,
    /** จองอาร์เรย์ใน linear memory (หน่วยความจำไม่ขยายภายหลัง view จึงใช้ได้ตลอด) */
    alloc(T, n) {
      off = (off + 15) & ~15;
      const a = new T(memory.buffer, off, n);
      off += n * T.BYTES_PER_ELEMENT;
      if (off > limit) throw new Error('kernels: หน่วยความจำไม่พอ');
      return a;
    },
  };
}

/** ขนาดหน่วยความจำที่ต้องจองเพิ่มสำหรับอาร์เรย์ n ตัว (เผื่อการจัดแนว 16 ไบต์) */
export const ALIGN_SLACK = 16;

/** สร้างแบบ synchronous — ใช้ได้ใน Web Worker และ Node; คืน null ถ้าใช้ไม่ได้ */
export function createKernels(size) {
  if (globalThis.__CFD_NO_WASM__ || typeof WebAssembly !== 'object') return null;
  try {
    moduleSync = moduleSync || new WebAssembly.Module(getBytes());
    const memory = newMemory(size);
    return wrap(new WebAssembly.Instance(moduleSync, { env: { memory } }), memory);
  } catch {
    return null;
  }
}

/** สร้างแบบ asynchronous — ใช้ได้ทุกที่รวมถึง main thread ของเบราว์เซอร์; คืน null ถ้าใช้ไม่ได้ */
export async function createKernelsAsync(size) {
  if (globalThis.__CFD_NO_WASM__ || typeof WebAssembly !== 'object') return null;
  try {
    moduleAsync = moduleAsync || WebAssembly.compile(getBytes());
    const memory = newMemory(size);
    return wrap(await WebAssembly.instantiate(await moduleAsync, { env: { memory } }), memory);
  } catch {
    return null;
  }
}
