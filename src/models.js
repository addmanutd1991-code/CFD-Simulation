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
 * EER ของ VRV ใช้ค่าเฉลี่ย 3.5 ทุกรุ่น (catalog ไม่ได้ใช้ในแบบจำลองนี้) — แก้อัตราลมได้รายเครื่องในแผงคุณสมบัติ
 */

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
      const eer = u.eer || EER;
      const spec = { hp: u.hp, kw: u.kw, cmm: u.cmm, w: sr.w, fans: 1, eer };
      list.push({
        id: u.id, indoor: u.indoor || null, series: key, discharge: 'front',
        hp: u.hp, kw: u.kw, cmm: u.cmm, eer, kwScale: 1,
        modules: [u.hp], mods: [spec],
        width: sr.w, height: sr.h, depth: sr.d, fans: 1,
        fan: { ...sr.fan },
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
  let x = -total / 2;
  return m.mods.map(s => {
    const w = s.w / 1000;
    const r = { hp: s.hp, kw: s.kw * m.kwScale, cmm: s.cmm * scale, eer: s.eer, fans: s.fans, w, x0: x, x1: x + w };
    x += w + MODULE_GAP / 1000;
    return r;
  });
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
 * สมรรถนะของโมดูลที่อุณหภูมิลมเข้าคอยล์ Tin
 *   capF  = 1 − kCap·(Tin − Tref)          (ตัดช่วง 0.4 – 1.10)
 *   powF  = 1 + kPow·(Tin − Tref)
 *   Qrej  = Qcool·capF + (Qcool/EER)·powF   — ความร้อนที่คอยล์ร้อนต้องระบายทิ้ง
 */
export function modulePerf(kw, eer, Tin, perf = DEFAULT_PERF) {
  const d = Tin - perf.Tref;
  const capF = Math.min(1.10, Math.max(0.4, 1 - perf.kCap * d));
  const powF = Math.max(0.6, 1 + perf.kPow * d);
  const qCool = kw * 1000 * capF;
  const pIn = kw * 1000 / eer * powF;
  return { capF, powF, qCool, pIn, qRej: qCool + pIn };
}

/** ระดับความรุนแรงจากอุณหภูมิลมเข้าคอยล์ที่สูงขึ้นเทียบอากาศภายนอก */
export function status(dT, Tin, perf = DEFAULT_PERF) {
  if (Tin >= perf.Tlimit) return { key: 'trip', label: 'เกินขอบเขตทำงาน', short: 'ตัด HP' };
  if (dT >= 3) return { key: 'bad', label: 'ลมร้อนวนกลับมาก', short: 'วิกฤต' };
  if (dT >= 1) return { key: 'watch', label: 'ควรเฝ้าระวัง', short: 'เฝ้าระวัง' };
  return { key: 'ok', label: 'ปกติ', short: 'ปกติ' };
}

export const AIR_CP = 1007;
export function airRho(T) { return 101325 / (287.05 * (T + 273.15)); }
