/*
 * catalog.js — ข้อมูลคอยล์ร้อน Daikin VRV 6A (RXQ-BY1S)
 * จาก catalog EDTRTH342529A หน้า Specifications — ชุดเดียวกับ CDU Noise Map / CDU Airflow CFD
 *
 *   ขนาดโมดูล H × W × D = 1,660 × W × 765 mm
 *   ลมเข้า: ด้านหลังและด้านข้างทั้งสอง   ลมออก: พัดลมด้านบน
 *   ความร้อนระบาย = capacity × (1 + 1/EER)
 */

export const VRV_HT = 1.66;    // m — ความสูงโมดูล
export const VRV_DEP = 0.765;  // m — ความลึกโมดูล
export const VRV_GAP = 0.10;   // m — ช่องว่างระหว่างโมดูลในชุดผสม

/** [รุ่น, capacity ทำความเย็น kW, โมดูลที่ประกอบเป็นชุด] */
const MODELS = [
  ['RXQ8BY1S', 22.4, ['RXQ8BY1S']], ['RXQ10BY1S', 28.0, ['RXQ10BY1S']], ['RXQ12BY1S', 33.5, ['RXQ12BY1S']],
  ['RXQ14BY1S', 40.0, ['RXQ14BY1S']], ['RXQ16BY1S', 45.0, ['RXQ16BY1S']], ['RXQ18BY1S', 50.0, ['RXQ18BY1S']],
  ['RXQ20BY1S', 56.0, ['RXQ20BY1S']], ['RXQ22BY1S', 61.5, ['RXQ22BY1S']], ['RXQ24BY1S', 67.0, ['RXQ24BY1S']],
  ['RXQ26BY1S', 73.0, ['RXQ26BY1S']],
  ['RXQ28BY1S', 78.5, ['RXQ12BY1S', 'RXQ16BY1S']], ['RXQ30BY1S', 83.5, ['RXQ12BY1S', 'RXQ18BY1S']],
  ['RXQ32BY1S', 89.5, ['RXQ12BY1S', 'RXQ20BY1S']], ['RXQ34BY1S', 95.0, ['RXQ16BY1S', 'RXQ18BY1S']],
  ['RXQ36BY1S', 100.0, ['RXQ18BY1S', 'RXQ18BY1S']], ['RXQ38BY1S', 106.0, ['RXQ18BY1S', 'RXQ20BY1S']],
  ['RXQ40BY1S', 112.0, ['RXQ20BY1S', 'RXQ20BY1S']], ['RXQ42BY1S', 117.0, ['RXQ18BY1S', 'RXQ24BY1S']],
  ['RXQ44BY1S', 123.0, ['RXQ18BY1S', 'RXQ26BY1S']], ['RXQ46BY1S', 129.0, ['RXQ20BY1S', 'RXQ26BY1S']],
  ['RXQ48BY1S', 134.0, ['RXQ22BY1S', 'RXQ26BY1S']], ['RXQ50BY1S', 140.0, ['RXQ24BY1S', 'RXQ26BY1S']],
  ['RXQ52BY1S', 146.0, ['RXQ26BY1S', 'RXQ26BY1S']],
  ['RXQ54BY1S', 150.0, ['RXQ18BY1S', 'RXQ18BY1S', 'RXQ18BY1S']], ['RXQ56BY1S', 156.0, ['RXQ18BY1S', 'RXQ18BY1S', 'RXQ20BY1S']],
  ['RXQ58BY1S', 162.0, ['RXQ18BY1S', 'RXQ20BY1S', 'RXQ20BY1S']], ['RXQ60BY1S', 168.0, ['RXQ20BY1S', 'RXQ20BY1S', 'RXQ20BY1S']],
  ['RXQ62BY1S', 173.0, ['RXQ20BY1S', 'RXQ20BY1S', 'RXQ22BY1S']], ['RXQ64BY1S', 179.0, ['RXQ20BY1S', 'RXQ20BY1S', 'RXQ24BY1S']],
  ['RXQ66BY1S', 185.0, ['RXQ20BY1S', 'RXQ20BY1S', 'RXQ26BY1S']], ['RXQ68BY1S', 190.0, ['RXQ20BY1S', 'RXQ22BY1S', 'RXQ26BY1S']],
  ['RXQ70BY1S', 196.0, ['RXQ20BY1S', 'RXQ24BY1S', 'RXQ26BY1S']], ['RXQ72BY1S', 202.0, ['RXQ20BY1S', 'RXQ26BY1S', 'RXQ26BY1S']],
  ['RXQ74BY1S', 207.0, ['RXQ22BY1S', 'RXQ26BY1S', 'RXQ26BY1S']], ['RXQ76BY1S', 213.0, ['RXQ24BY1S', 'RXQ26BY1S', 'RXQ26BY1S']],
  ['RXQ78BY1S', 219.0, ['RXQ26BY1S', 'RXQ26BY1S', 'RXQ26BY1S']],
];

export const VRV_MODELS = Object.fromEntries(MODELS.map(([n, kw, m]) => [n, { n, kw, m }]));

/** ต่อโมดูลตามขนาด HP: ความกว้าง (m), ปริมาณลม (m³/min), จำนวนพัดลม */
const MOD_W = { 8: 0.93, 10: 0.93, 12: 0.93, 14: 1.24, 16: 1.24, 18: 1.24, 20: 1.24, 22: 1.75, 24: 1.75, 26: 1.75 };
const MOD_AIR = { 8: 158, 10: 174, 12: 185, 14: 237, 16: 266, 18: 258, 20: 306, 22: 375, 24: 390, 26: 411 };
const MOD_FANS = { 8: 1, 10: 1, 12: 1, 14: 2, 16: 2, 18: 2, 20: 2, 22: 2, 24: 2, 26: 2 };

const hpOf = n => +n.match(/\d+/)[0];

/** ข้อมูลโมดูลเดี่ยวตาม HP: { w, fans, kw, cmm } — kw จากรุ่นโมดูลเดี่ยวใน catalog */
export const VRV_MODULES = Object.fromEntries(Object.keys(MOD_W).map(hp => [hp, {
  w: MOD_W[hp], fans: MOD_FANS[hp], cmm: MOD_AIR[hp], kw: VRV_MODELS[`RXQ${hp}BY1S`].kw,
}]));
export const VRV_HP = Object.keys(MOD_W).map(Number);

export const VRV_DEFAULTS = { eer: 3.5, derate: 2, lim: 46 };

/** รายการ HP ของโมดูลที่ประกอบเป็นชุด เช่น RXQ28BY1S → [12, 16] */
export function modulesOf(model) {
  return (VRV_MODELS[model] || VRV_MODELS.RXQ20BY1S).m.map(hpOf);
}

/** หาชื่อชุดใน catalog ที่ตรงกับรายการโมดูล (ไม่ตรง = null คือชุดกำหนดเอง) */
export function modelOf(modules) {
  const key = [...modules].sort((a, b) => a - b).join('+');
  for (const [n, s] of Object.entries(VRV_MODELS)) {
    if (s.m.map(hpOf).sort((a, b) => a - b).join('+') === key) return n;
  }
  return null;
}

export function vrvLabel(model) {
  const s = VRV_MODELS[model];
  if (!s) return model;
  const combo = s.m.length > 1 ? ` = ${s.m.map(n => n.replace('BY1S', '')).join(' + ')}` : '';
  return `${model} · ${s.kw} kW${combo}`;
}
