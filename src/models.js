/*
 * models.js — คลังรุ่นคอยล์ร้อน Daikin VRV และสมการสมรรถนะเทียบอุณหภูมิลมเข้าคอยล์
 *
 * ซีรีส์ที่รองรับ
 *   VRV 6A   (RXQ-BY1S)  catalog EDTRTH342529A — เป่าลมขึ้นด้านบน (top discharge)
 *     ขนาดโมดูล H × W × D = 1,660 × W × 765 mm · ชุดผสมเว้นระยะระหว่างโมดูล 100 mm
 *     ลมเข้า: ด้านหลังและด้านข้างทั้งสอง · ลมออก: พัดลมด้านบน
 *   VRV IV S (RXMQ-AVE/BVM) catalog EDTRMT332049  — เป่าลมออกด้านหน้า (side discharge) 990 × 940 × 320 mm
 *   VRV S Hi (RSUQ-AYM)     catalog EDTRMT332104A — เป่าลมออกด้านหน้า (side discharge) 870 × 1,100 × 460 mm
 *     ลมเข้า: ด้านหลังและด้านซ้าย (มองจากด้านหน้า — ด้านขวาเป็นแผงบริการ/ท่อน้ำยา) · ลมออก: พัดลมหน้าเครื่อง
 *     ตำแหน่งและขนาดหน้ากากพัดลมประมาณจากแบบ Dimensions ของ catalog
 *   Split type FTKB-A (คอยล์ร้อน RKB09/12AV2S) catalog EDTTH042558 — เป่าลมออกด้านหน้า 461 × 650 × 244 mm
 *     EER ใช้ COP ที่พิกัดจาก catalog (3.09 / 3.10)
 *   Split type คอยล์ร้อน (CDU) RKB15–24ZV2S, RKC-ZV2S, RKD-ZV2S, RKF-YV2S, RKM-YV2S, RKQ-YV2S, RKZ-YV2S, RKE-YV2S
 *     — Specification ของ Daikin · เก็บเฉพาะคอยล์ร้อน (ไม่รวมคอยล์เย็น) · ขนาดตัวเครื่องต่างกันรายรุ่น 4 แบบ (ดู SPLIT_BODY)
 *     อัตราลมใช้ค่า H ของคอยล์ร้อน · EER ใช้ COP ที่พิกัด
 *   Sky Air Premium RZF-DV2S/DY2S (+ RZFS38DY2S) — Specification EDTH282362
 *   Sky Air Standard RZFC-EV2S/EY2S             — Specification RZFC-EV2S
 *     — เก็บเฉพาะคอยล์ร้อน (CDU) · kW และ EER ใช้ค่าที่จับคู่กับคอยล์เย็นแบบ Cassette (FCTF / FCFC;
 *       RZFS38DY2S ใช้คู่ FCF(S)) · อัตราลมของคอยล์ร้อนจาก Specification · ตัวเครื่อง 3 ขนาด (L / XL / XXL)
 * EER ของ VRV ใช้ค่าเฉลี่ย 3.5 ทุกรุ่น (catalog ไม่ได้ใช้ในแบบจำลองนี้) — แก้อัตราลมได้รายเครื่องในแผงคุณสมบัติ
 * VRV 6A: capacity และกำลังไฟเทียบอุณหภูมิลมเข้าคอยล์ใช้ตาราง Cooling Capacity ของ Daikin (vrv6a-capacity.js)
 *   ตาม Combination ratio ของแต่ละเครื่อง (ค่าเริ่มต้น 100 %) — รุ่นอื่นใช้สมการเส้นตรงใน DEFAULT_PERF
 */

import { L } from './i18n.js';
import { VRV6A_CAP } from './vrv6a-capacity.js';
const EER = 3.5;

/** โมดูลเดี่ยว — ความกว้างเป็นมิลลิเมตร อัตราลมเป็น m³/min */
export const MODULES = {
  8:  { hp: 8,  kw: 22.4, cmm: 158, w: 930,  fans: 1, eer: EER },
  10: { hp: 10, kw: 28.0, cmm: 174, w: 930,  fans: 1, eer: EER },
  12: { hp: 12, kw: 33.5, cmm: 185, w: 930,  fans: 1, eer: EER },
  14: { hp: 14, kw: 40.0, cmm: 237, w: 1240, fans: 2, eer: EER },
  16: { hp: 16, kw: 45.0, cmm: 266, w: 1240, fans: 2, eer: EER },
  18: { hp: 18, kw: 50.0, cmm: 258, w: 1240, fans: 2, eer: EER },
  20: { hp: 20, kw: 56.0, cmm: 306, w: 1240, fans: 2, eer: EER },
  22: { hp: 22, kw: 61.5, cmm: 375, w: 1750, fans: 2, eer: EER },
  24: { hp: 24, kw: 67.0, cmm: 390, w: 1750, fans: 2, eer: EER },
  26: { hp: 26, kw: 73.0, cmm: 411, w: 1750, fans: 2, eer: EER },
};

export const MODULE_H = 1660;   // mm
export const MODULE_D = 765;    // mm
export const MODULE_GAP = 100;  // mm — ระยะห่างระหว่างโมดูลในชุดผสม
export const FAN_AREA = 0.36;   // m² — พื้นที่หน้าตะแกรงพัดลมต่อหนึ่งใบพัด (Ø ~0.68 m)

/** ชุดผสม: HP รวม → [capacity kW ตาม catalog, โมดูลที่ใช้] */
const COMBOS = {
  28: [78.5, [12, 16]], 30: [83.5, [12, 18]], 32: [89.5, [12, 20]], 34: [95.0, [16, 18]],
  36: [100.0, [18, 18]], 38: [106.0, [18, 20]], 40: [112.0, [20, 20]], 42: [117.0, [18, 24]],
  44: [123.0, [18, 26]], 46: [129.0, [20, 26]], 48: [134.0, [22, 26]], 50: [140.0, [24, 26]],
  52: [146.0, [26, 26]],
  54: [150.0, [18, 18, 18]], 56: [156.0, [18, 18, 20]], 58: [162.0, [18, 20, 20]], 60: [168.0, [20, 20, 20]],
  62: [173.0, [20, 20, 22]], 64: [179.0, [20, 20, 24]], 66: [185.0, [20, 20, 26]], 68: [190.0, [20, 22, 26]],
  70: [196.0, [20, 24, 26]], 72: [202.0, [20, 26, 26]], 74: [207.0, [22, 26, 26]], 76: [213.0, [24, 26, 26]],
  78: [219.0, [26, 26, 26]],
};

/**
 * ซีรีส์เป่าลมหน้าเครื่อง (side discharge): ขนาดตัวเครื่องและหน้ากากพัดลม
 *   fan.lx  = ศูนย์กลางพัดลมตามความกว้าง (ม., เทียบกึ่งกลางเครื่อง, ลบ = ซ้ายเมื่อมองจากด้านหน้า)
 *   fan.y   = ความสูงศูนย์กลางพัดลมจากฐานเครื่อง (ม.)
 *   fan.s   = ขนาดหน้ากากพัดลมสี่เหลี่ยมจัตุรัส (ม.) — ใช้เป็นหน้าตัดของ Hood
 *   fan.dia = เส้นผ่านศูนย์กลางช่องลมออกของพัดลม (ม.)
 */
const FRONT_SERIES = {
  IVS: {
    label: 'VRV IV S', code: 'RXMQ', h: 990, w: 940, d: 320,
    fan: { lx: -0.10, y: 0.50, s: 0.60, dia: 0.55 },
    units: [
      { id: 'RXMQ4AVE', hp: 4, kw: 11.2, cmm: 76 },
      { id: 'RXMQ5BVM', hp: 5, kw: 14.0, cmm: 81 },
      { id: 'RXMQ6BVM', hp: 6, kw: 16.0, cmm: 80 },
    ],
  },
  SHI: {
    label: 'VRV S Hi', code: 'RSUQ-AYM', h: 870, w: 1100, d: 460,
    fan: { lx: -0.15, y: 0.44, s: 0.70, dia: 0.64 },
    units: [
      { id: 'RSUQ7AYM', hp: 7, kw: 20.0, cmm: 123 },
      { id: 'RSUQ8AYM', hp: 8, kw: 22.4, cmm: 123 },
      { id: 'RSUQ9AYM', hp: 9, kw: 24.0, cmm: 137 },
    ],
  },
  FTKB: {
    label: 'FTKB-A', code: 'RKB-AV2S', h: 461, w: 650, d: 244,
    fan: { lx: -0.07, y: 0.23, s: 0.42, dia: 0.40 },
    units: [
      { id: 'RKB09AV2S', indoor: 'FTKB09AV2S', hp: 1, kw: 2.7, cmm: 26.0, eer: 3.09 },
      { id: 'RKB12AV2S', indoor: 'FTKB12AV2S', hp: 1.5, kw: 3.6, cmm: 26.9, eer: 3.10 },
    ],
  },
};

/**
 * ตัวเครื่องคอยล์ร้อน Split type (H × W × D mm) และหน้ากากพัดลมโดยประมาณ — ใช้ร่วมกันหลายรุ่น
 */
const SPLIT_BODY = {
  S: { h: 418, w: 695, d: 244, fan: { lx: -0.08, y: 0.21, s: 0.38, dia: 0.36 } },
  M: { h: 550, w: 675, d: 284, fan: { lx: -0.07, y: 0.27, s: 0.46, dia: 0.44 } },
  L: { h: 595, w: 845, d: 300, fan: { lx: -0.10, y: 0.29, s: 0.50, dia: 0.48 } },
  XL: { h: 695, w: 930, d: 350, fan: { lx: -0.12, y: 0.34, s: 0.58, dia: 0.55 } },
  XXL: { h: 990, w: 940, d: 320, fan: { lx: -0.10, y: 0.50, s: 0.60, dia: 0.55 } },  // ตัวเครื่องเดียวกับ VRV IV S
};
/** HP โดยประมาณจากรหัสขนาดในชื่อรุ่น (×1,000 Btu/h) — ไม่แสดงในเมนูของ Split type */
const HP_OF = { '09': 1, 12: 1.5, 13: 1.5, 15: 1.75, 18: 2, 24: 2.5, 30: 3, 36: 4, 38: 4, 42: 4.5, 48: 5 };
/** [รหัสรุ่น, kW, m³/min (H), COP, ตัวเครื่อง] */
function splitSeries(label, code, rows) {
  const units = rows.map(([id, kw, cmm, eer, b]) => ({ id, hp: HP_OF[id.match(/\d\d/)[0]], kw, cmm, eer, body: SPLIT_BODY[b] }));
  const b0 = units[0].body;
  return { label, code, h: b0.h, w: b0.w, d: b0.d, fan: b0.fan, units };
}
Object.assign(FRONT_SERIES, {
  RKB: splitSeries('Split RKB-ZV2S', 'RKB-ZV2S', [
    ['RKB15ZV2S', 4.4, 27.8, 3.12, 'M'], ['RKB18ZV2S', 5.3, 31.6, 3.05, 'M'], ['RKB24ZV2S', 6.0, 45.75, 3.03, 'L'],
  ]),
  RKC: splitSeries('Split RKC-ZV2S', 'RKC-ZV2S', [
    ['RKC09ZV2S', 2.7, 17.8, 3.25, 'S'], ['RKC12ZV2S', 3.6, 26.5, 3.21, 'M'], ['RKC15ZV2S', 4.4, 35.8, 3.33, 'L'],
    ['RKC18ZV2S', 5.3, 45.1, 3.19, 'L'], ['RKC24ZV2S', 7.1, 45.1, 3.18, 'L'],
  ]),
  RKD: splitSeries('Split RKD-ZV2S', 'RKD-ZV2S', [
    ['RKD09ZV2S', 2.7, 15.1, 3.14, 'S'], ['RKD12ZV2S', 3.6, 25.5, 3.19, 'M'], ['RKD15ZV2S', 4.4, 27.4, 3.14, 'M'],
    ['RKD18ZV2S', 5.3, 35.0, 3.05, 'M'], ['RKD24ZV2S', 6.0, 45.6, 3.03, 'L'],
  ]),
  RKF: splitSeries('Split RKF-YV2S', 'RKF-YV2S', [
    ['RKF09YV2S', 2.7, 17.8, 3.25, 'S'], ['RKF12YV2S', 3.6, 26.5, 3.21, 'M'], ['RKF15YV2S', 4.4, 35.8, 3.33, 'L'],
    ['RKF18YV2S', 5.3, 45.1, 3.19, 'L'], ['RKF24YV2S', 7.1, 45.1, 3.18, 'L'],
  ]),
  RKM: splitSeries('Split RKM-YV2S', 'RKM-YV2S', [
    ['RKM09YV2S', 2.7, 25.4, 4.15, 'M'], ['RKM12YV2S', 3.6, 26.5, 3.64, 'M'], ['RKM15YV2S', 4.4, 35.8, 3.93, 'L'],
    ['RKM18YV2S', 5.3, 35.8, 3.71, 'L'], ['RKM24YV2S', 7.1, 45.1, 3.33, 'L'],
  ]),
  RKQ: splitSeries('Split RKQ-YV2S', 'RKQ-YV2S', [
    ['RKQ09YV2S', 2.7, 15.1, 3.14, 'S'], ['RKQ12YV2S', 3.6, 25.5, 3.19, 'M'], ['RKQ15YV2S', 4.4, 27.4, 3.18, 'M'],
    ['RKQ18YV2S', 5.3, 35.0, 3.05, 'M'], ['RKQ24YV2S', 6.0, 45.6, 3.11, 'L'],
  ]),
  RKZ: splitSeries('Split RKZ-YV2S', 'RKZ-YV2S', [
    ['RKZ09YV2S', 2.7, 35.8, 5.19, 'L'], ['RKZ12YV2S', 3.6, 35.8, 4.80, 'L'], ['RKZ15YV2S', 4.4, 35.8, 4.11, 'L'],
    ['RKZ18YV2S', 5.3, 66.8, 4.02, 'XL'], ['RKZ24YV2S', 7.1, 66.8, 3.41, 'XL'],
  ]),
  RKE: splitSeries('Split RKE-YV2S', 'RKE-YV2S', [
    ['RKE09YV2S', 2.7, 15.1, 3.14, 'S'], ['RKE12YV2S', 3.6, 25.5, 3.19, 'M'], ['RKE18YV2S', 5.3, 35.0, 3.05, 'M'],
  ]),
  RZF: splitSeries('Sky Air Premium RZF', 'RZF-D', [
    ['RZF13DV2S', 4.1, 45, 5.43, 'L'], ['RZF18DV2S', 5.3, 45, 4.84, 'L'], ['RZF24DV2S', 7.0, 45, 3.86, 'L'],
    ['RZF30DV2S', 8.8, 65, 3.59, 'XL'], ['RZF36DV2S', 10.6, 70, 3.26, 'XXL'], ['RZF42DV2S', 12.3, 70, 2.96, 'XXL'],
    ['RZF48DV2S', 14.1, 70, 2.59, 'XXL'],
    ['RZF30DY2S', 8.8, 65, 3.59, 'XL'], ['RZF36DY2S', 10.6, 70, 3.26, 'XXL'], ['RZFS38DY2S', 11.3, 86, 3.61, 'XXL'],
    ['RZF42DY2S', 12.3, 70, 2.96, 'XXL'], ['RZF48DY2S', 14.1, 70, 2.59, 'XXL'],
  ]),
  RZFC: splitSeries('Sky Air Standard RZFC', 'RZFC-E', [
    ['RZFC13EV2S', 4.0, 35.8, 3.28, 'L'], ['RZFC18EV2S', 5.3, 35.8, 3.25, 'L'], ['RZFC24EV2S', 7.0, 44, 3.26, 'L'],
    ['RZFC30EV2S', 8.8, 65, 3.11, 'XL'], ['RZFC36EV2S', 10.6, 65, 3.10, 'XL'],
    ['RZFC30EY2S', 8.8, 65, 3.11, 'XL'], ['RZFC36EY2S', 10.6, 65, 3.10, 'XL'],
    ['RZFC42EY2S', 12.3, 70, 2.72, 'XXL'], ['RZFC48EY2S', 14.1, 70, 2.70, 'XXL'],
  ]),
});

/** หมวดหมู่เครื่อง — เมนูเลือกรุ่นแยก VRV กับ Split type */
export const CATEGORIES = [
  { key: 'vrv', label: 'VRV' },
  { key: 'split', label: 'Split type' },
];

/** รายชื่อซีรีส์ตามลำดับที่แสดงในเมนูเลือกรุ่น */
export const SERIES = [
  { key: '6A', cat: 'vrv', label: 'VRV 6A', code: 'RXQ-BY1S', discharge: 'top', catalog: 'EDTRTH342529A' },
  { key: 'IVS', cat: 'vrv', label: 'VRV IV S', code: 'RXMQ', discharge: 'front', catalog: 'EDTRMT332049' },
  { key: 'SHI', cat: 'vrv', label: 'VRV S Hi', code: 'RSUQ-AYM', discharge: 'front', catalog: 'EDTRMT332104A' },
  { key: 'FTKB', cat: 'split', label: 'Split FTKB-A', code: 'RKB-AV2S', discharge: 'front', catalog: 'EDTTH042558' },
  { key: 'RKB', cat: 'split', label: 'Split RKB-ZV2S', code: 'RKB-ZV2S', discharge: 'front', catalog: 'RKB15-24 Specification' },
  { key: 'RKC', cat: 'split', label: 'Split RKC-ZV2S', code: 'RKC-ZV2S', discharge: 'front', catalog: 'RKC-ZV2S Specification' },
  { key: 'RKD', cat: 'split', label: 'Split RKD-ZV2S', code: 'RKD-ZV2S', discharge: 'front', catalog: 'RKD-ZV2S Specification' },
  { key: 'RKF', cat: 'split', label: 'Split RKF-YV2S', code: 'RKF-YV2S', discharge: 'front', catalog: 'RKF-YV2S Specification' },
  { key: 'RKM', cat: 'split', label: 'Split RKM-YV2S', code: 'RKM-YV2S', discharge: 'front', catalog: 'RKM-YV2S Specification' },
  { key: 'RKQ', cat: 'split', label: 'Split RKQ-YV2S', code: 'RKQ-YV2S', discharge: 'front', catalog: 'RKQ-YV2S Specification' },
  { key: 'RKZ', cat: 'split', label: 'Split RKZ-YV2S', code: 'RKZ-YV2S', discharge: 'front', catalog: 'RKZ-YV2S Specification' },
  { key: 'RKE', cat: 'split', label: 'Split RKE-YV2S', code: 'RKE-YV2S', discharge: 'front', catalog: 'RKE-YV2S Specification' },
  { key: 'RZF', cat: 'split', label: 'Sky Air Premium RZF', code: 'RZF-D', discharge: 'front', catalog: 'EDTH282362' },
  { key: 'RZFC', cat: 'split', label: 'Sky Air Standard RZFC', code: 'RZFC-E', discharge: 'front', catalog: 'RZFC-EV2S Specification' },
];
export function seriesOf(model) { return SERIES.find(s => s.key === model.series) || SERIES[0]; }

/**
 * ทิศทางลมร้อนออกจากเครื่องรุ่นเป่าหน้า (ใบเบี่ยงลมที่ติดกับเครื่อง — ไม่มีรูปทรงในแบบจำลอง)
 * เบี่ยง 45° จากแนวตั้งฉากหน้าเครื่อง มองจากด้านหน้าเครื่อง → เวกเตอร์ในแกนเฉพาะของเครื่อง
 */
export const DEFLECT_DIRS = {
  up: [0, 1, 0], down: [0, -1, 0], left: [-1, 0, 0], right: [1, 0, 0],
};
/** ทิศปากลมของ Hood หักฉาก 90° (รุ่นเป่าขึ้น) → เวกเตอร์ (lx, lz) ในแกนเฉพาะของเครื่อง (+lz = ด้านหน้า) */
export const HOOD_DIRS = { front: [0, 1], back: [0, -1], left: [-1, 0], right: [1, 0] };
/** Hood หัก 90° (ท่อโค้ง): ความสูงหน้าตัดท่อช่วงแนวนอน = ความลึกตัวเครื่อง แต่ไม่เกินความสูง Hood */
export function elbowOpen(unit) { return Math.min(Math.max(0, unit.duct || 0), unitSize(unit).d); }
/** ทิศปากลม Hood หัก 90° ที่ใช้จริง — ด้านข้างใช้ได้เฉพาะเครื่องโมดูลเดี่ยว */
export function elbowDir(unit) {
  const d = HOOD_DIRS[unit.hoodDir] ? unit.hoodDir : 'front';
  return getModel(unit.model).modules.length > 1 && (d === 'left' || d === 'right') ? 'front' : d;
}

function build() {
  const list = [];
  for (const hp of Object.keys(MODULES).map(Number)) list.push(makeModel(hp, [hp], MODULES[hp].kw));
  for (const hp of Object.keys(COMBOS).map(Number)) list.push(makeModel(hp, COMBOS[hp][1], COMBOS[hp][0]));
  for (const [key, sr] of Object.entries(FRONT_SERIES))
    for (const u of sr.units) {
      const eer = u.eer || EER, b = u.body || sr;
      const spec = { hp: u.hp, kw: u.kw, cmm: u.cmm, w: b.w, fans: 1, eer };
      list.push({
        id: u.id, indoor: u.indoor || null, series: key, discharge: 'front',
        hp: u.hp, kw: u.kw, cmm: u.cmm, eer, kwScale: 1,
        modules: [u.hp], mods: [spec],
        width: b.w, height: b.h, depth: b.d, fans: 1,
        fan: { ...b.fan },
      });
    }
  return list;
}

function makeModel(hp, mods, kw) {
  const ms = mods.map(m => MODULES[m]);
  const kwSum = ms.reduce((s, m) => s + m.kw, 0);
  const cmm = ms.reduce((s, m) => s + m.cmm, 0);
  const width = ms.reduce((s, m) => s + m.w, 0) + MODULE_GAP * (ms.length - 1);
  return {
    id: `RXQ${hp}BY1S`,
    series: '6A', discharge: 'top',
    hp, kw, cmm,
    eer: EER,
    kwScale: kw / kwSum,         // ปรับ kW รายโมดูลให้รวมกันเท่า capacity ชุดผสมใน catalog
    modules: mods,               // HP ของแต่ละโมดูล
    mods: ms,                    // ข้อมูลของแต่ละโมดูล
    width,                       // mm รวมทั้งชุด
    height: MODULE_H, depth: MODULE_D,
    fans: ms.reduce((s, m) => s + m.fans, 0),
  };
}

export const MODELS = build();
export const MODEL_BY_ID = Object.fromEntries(MODELS.map(m => [m.id, m]));

export function getModel(id) { return MODEL_BY_ID[id] || MODEL_BY_ID.RXQ16BY1S; }

/** เครื่องเป่าลมออกด้านหน้า (VRV IV S / VRV S Hi) หรือไม่ */
export function isFront(unit) { return getModel(unit.model).discharge === 'front'; }

/**
 * โมดูลของเครื่องหนึ่งชุด เรียงตามแกน x เฉพาะตัว (จากซ้ายไปขวาเมื่อมองจากด้านหน้า)
 * คืนค่า [{hp, kw, cmm, eer, w(m), fans, x0, x1 (m, เทียบกึ่งกลางชุด)}]
 * ถ้าผู้ใช้แก้อัตราลมรวม จะเกลี่ยตามสัดส่วนอัตราลมเดิมของแต่ละโมดูล
 */
export function unitModules(unit) {
  const m = getModel(unit.model);
  const scale = unit.airflow ? unit.airflow / m.cmm : 1;
  const total = m.width / 1000;
  const combo = unitCombo(unit);
  let x = -total / 2;
  return m.mods.map(s => {
    const w = s.w / 1000;
    const kw = s.kw * m.kwScale;
    // VRV 6A: ใช้ตารางของทั้งระบบถ้ามี (8 – 38 HP) ไม่เช่นนั้นใช้ตารางของโมดูลเอง
    const tblHp = m.series === '6A' ? (VRV6A_CAP.data[m.hp] ? m.hp : s.hp) : null;
    const cap = tblHp && VRV6A_CAP.data[tblHp] ? { hp: tblHp, combo } : null;
    const kwRef = cap ? kw * vrv6aCap(cap.hp, combo, VRV6A_RATED_T).tc / vrv6aCap(cap.hp, 100, VRV6A_RATED_T).tc : kw;
    const r = { hp: s.hp, kw, kwRef, cap, cmm: s.cmm * scale, eer: s.eer, fans: s.fans, w, x0: x, x1: x + w };
    x += w + MODULE_GAP / 1000;
    return r;
  });
}

/* ───────── ตาราง Capacity VRV 6A ตาม Combination ratio ───────── */

export const COMBO_DEFAULT = 100, COMBO_MIN = 10, COMBO_MAX = 130;
/** อุณหภูมิอากาศภายนอกที่พิกัดของตาราง (°CDB) — capacity ที่ 35 °C / 19 °CWB / 100 % = kW ใน catalog */
export const VRV6A_RATED_T = 35;

/** เครื่องนี้ใช้ตาราง capacity VRV 6A หรือไม่ */
export function hasCapTable(unit) { return getModel(unit.model).series === '6A'; }

/** Combination ratio ของเครื่อง (%) — ไม่ได้กำหนด = 100 % */
export function unitCombo(unit) {
  const c = Number(unit?.combo);
  return unit?.combo != null && isFinite(c) ? Math.min(COMBO_MAX, Math.max(COMBO_MIN, c)) : COMBO_DEFAULT;
}

/** หาค่าบนเส้นตรงระหว่างจุดตาราง (นอกช่วงใช้ค่าปลาย) */
function lerpAt(xs, x) {
  if (x <= xs[0]) return [0, 0, 0];
  const n = xs.length - 1;
  if (x >= xs[n]) return [n, n, 0];
  let i = 0;
  while (xs[i + 1] < x) i++;
  return [i, i + 1, (x - xs[i]) / (xs[i + 1] - xs[i])];
}

/**
 * TC / PI (kW) ของ VRV 6A จากตาราง ที่ HP ของระบบ, Combination ratio (%) และอุณหภูมิลมเข้าคอยล์ร้อน T (°CDB)
 * ห้องฝั่งคอยล์เย็น 19 °CWB · หาค่าระหว่างจุดตารางแบบเส้นตรงทั้งแกน combination และอุณหภูมิ
 * T ต่ำกว่า 10 °C / สูงกว่า 52 °C ใช้ค่าที่ขอบตาราง
 */
export function vrv6aCap(hp, combo, T) {
  const d = VRV6A_CAP.data[hp];
  if (!d) return null;
  const [c0, c1, fc] = lerpAt(VRV6A_CAP.combos, combo);
  const [t0, t1, ft] = lerpAt(VRV6A_CAP.temps, T);
  const at = (tbl) => {
    const row = (c) => tbl[c][t0] + (tbl[c][t1] - tbl[c][t0]) * ft;
    return row(c0) + (row(c1) - row(c0)) * fc;
  };
  return { tc: at(d.tc), pi: at(d.pi) };
}

/** ช่วงความสูงของคอยล์ดูดลม (สัดส่วนความสูงเครื่อง) — ใช้ทั้งตัวคำนวณและภาพแสดงด้านดูด */
export const COIL_LO = 0.08, COIL_HI = 0.92;

/**
 * ด้านที่คอยล์ดูดลมเข้า ในแกนเฉพาะของเครื่อง (ตรงกับ mesher.js)
 *   เป่าขึ้น (VRV 6A): หลัง + ซ้าย + ขวา   ·   เป่าหน้า: หลัง + ซ้าย
 *   ถ้าด้านเหล่านี้ถูกบังหมด ตัวคำนวณจะใช้ช่องด้านหน้าแทน
 */
export function suctionSides(unit) {
  return getModel(unit.model).discharge === 'front' ? ['back', 'left'] : ['back', 'left', 'right'];
}

/** ขาตั้ง CDU: ใส่เฉพาะ VRV 6A และเมื่อระยะยกจากพื้นรองรับไม่เกิน 10 ซม. — สูงกว่านี้เครื่องลอยเหนือพื้น (ลมผ่านใต้เครื่องได้) */
export const STAND_MAX = 0.10;
export function hasStand(unit, gap) {
  return getModel(unit.model).series === '6A' && gap > 0.01 && gap <= STAND_MAX + 1e-6;
}

export function unitSize(unit) {
  const m = getModel(unit.model);
  return { w: m.width / 1000, h: m.height / 1000, d: m.depth / 1000 };
}

/**
 * กล่องของเครื่องรวม Hood ในแกนเฉพาะของเครื่อง (ม.): lx ตามความกว้าง, lz ไปทางด้านหน้า, top = ความสูงเหนือฐาน
 *   รุ่นเป่าหน้า: Hood ยื่นออกด้านหน้า (duct = ความยาว)
 *   รุ่นเป่าขึ้น: Hood สูงเหนือเครื่อง (duct = ความสูง) · Hood หัก 90° ยื่นพ้นตัวเครื่องตามทิศปากลมอีก hoodOut
 */
export function unitLocalBox(unit) {
  const m = getModel(unit.model), s = unitSize(unit);
  const L = Math.max(0, unit.duct || 0);
  const b = { lx0: -s.w / 2, lx1: s.w / 2, lz0: -s.d / 2, lz1: s.d / 2, top: s.h };
  if (m.discharge === 'front') { b.lz1 += L; return b; }
  b.top += L;
  if (L > 0 && unit.hoodType === 'elbow') {
    const [vx, vz] = HOOD_DIRS[elbowDir(unit)], out = Math.max(0, unit.hoodOut || 0);
    if (vx < 0) b.lx0 -= out; else if (vx > 0) b.lx1 += out;
    if (vz < 0) b.lz0 -= out; else if (vz > 0) b.lz1 += out;
  }
  return b;
}

/**
 * กรอบสี่เหลี่ยมตามแกนโลก (AABB) ของเครื่องรวม Hood — rot เป็นพหุคูณของ 90°
 * ด้านหน้าเครื่องหันไป +z เมื่อ rot = 0
 */
export function unitExtent(unit) {
  const b = unitLocalBox(unit);
  const rot = (((unit.rot || 0) % 360) + 360) % 360;
  const a = rot * Math.PI / 180, c = Math.round(Math.cos(a)), sn = Math.round(Math.sin(a));
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const px of [b.lx0, b.lx1]) for (const pz of [b.lz0, b.lz1]) {
    const wx = unit.x + px * c + pz * sn, wz = unit.z - px * sn + pz * c;
    x0 = Math.min(x0, wx); x1 = Math.max(x1, wx); z0 = Math.min(z0, wz); z1 = Math.max(z1, wz);
  }
  const y0 = unit.elev || 0;
  return { x0, x1, z0, z1, y0, y1: y0 + b.top };
}

export const DEFAULT_PERF = {
  Tref: 35,      // °C — อุณหภูมิลมเข้าคอยล์ที่พิกัด (rated)
  kCap: 0.02,    // สัดส่วนความสามารถทำความเย็นที่ลดลงต่อ 1 K (2 %/K เท่ากับ CDU Airflow CFD)
  kPow: 0.025,   // สัดส่วนกำลังไฟฟ้าที่เพิ่มขึ้นต่อ 1 K
  Tlimit: 46,    // °C — ขอบเขตการทำงานด้านสูงของอุณหภูมิลมเข้า (ตรวจกับ Databook)
};

/**
 * สมรรถนะของโมดูล mod ({kw, eer, cap?}) ที่อุณหภูมิลมเข้าคอยล์ Tin
 *   VRV 6A (mod.cap = {hp, combo}) — ตาราง Cooling Capacity ของ Daikin
 *     Qcool = kw·TC(combo, Tin)/TC(100 %, 35 °C)   Pin = kw·PI(combo, Tin)/TC(100 %, 35 °C)
 *     capF  = TC(combo, Tin) / TC(combo, 35 °C)     — เทียบ capacity ของ combination เดียวกันที่อากาศ 35 °C
 *   รุ่นอื่น — สมการเส้นตรง
 *     capF  = 1 − kCap·(Tin − Tref)          (ตัดช่วง 0.4 – 1.10)
 *     powF  = 1 + kPow·(Tin − Tref)
 *   Qrej  = Qcool + Pin   — ความร้อนที่คอยล์ร้อนต้องระบายทิ้ง
 */
export function modulePerf(mod, Tin, perf = DEFAULT_PERF) {
  const { kw, eer, cap } = mod;
  if (cap && VRV6A_CAP.data[cap.hp]) {
    const rated = vrv6aCap(cap.hp, 100, VRV6A_RATED_T), ref = vrv6aCap(cap.hp, cap.combo, VRV6A_RATED_T);
    const now = vrv6aCap(cap.hp, cap.combo, Tin);
    const qCool = kw * 1000 * now.tc / rated.tc;
    const pIn = kw * 1000 * now.pi / rated.tc;
    return { capF: now.tc / ref.tc, powF: now.pi / ref.pi, qCool, pIn, qRej: qCool + pIn };
  }
  const d = Tin - perf.Tref;
  const capF = Math.min(1.10, Math.max(0.4, 1 - perf.kCap * d));
  const powF = Math.max(0.6, 1 + perf.kPow * d);
  const qCool = kw * 1000 * capF;
  const pIn = kw * 1000 / eer * powF;
  return { capF, powF, qCool, pIn, qRej: qCool + pIn };
}

/** ระดับความรุนแรงจากอุณหภูมิลมเข้าคอยล์ที่สูงขึ้นเทียบอากาศภายนอก */
export function status(dT, Tin, perf = DEFAULT_PERF) {
  if (Tin >= perf.Tlimit) return { key: 'trip', label: L('เกินขอบเขตทำงาน', 'Beyond operating limit'), short: L('ตัด HP', 'HP trip') };
  if (dT >= 3) return { key: 'bad', label: L('ลมร้อนวนกลับมาก', 'Heavy recirculation'), short: L('วิกฤต', 'Critical') };
  if (dT >= 1) return { key: 'watch', label: L('ควรเฝ้าระวัง', 'Needs attention'), short: L('เฝ้าระวัง', 'Watch') };
  return { key: 'ok', label: L('ปกติ', 'Normal'), short: L('ปกติ', 'Normal') };
}

export const AIR_CP = 1007;
export function airRho(T) { return 101325 / (287.05 * (T + 273.15)); }
