/*
 * models.js — คลังรุ่นคอยล์ร้อน Daikin VRV 6A (RXQ-BY1S) และสมการสมรรถนะเทียบอุณหภูมิลมเข้าคอยล์
 *
 * ข้อมูลรุ่นจาก catalog EDTRTH342529A หน้า Specifications (ชุดเดียวกับ CDU Noise Map)
 *   ขนาดโมดูล H × W × D = 1,660 × W × 765 mm · ชุดผสมเว้นระยะระหว่างโมดูล 100 mm
 *   ลมเข้า: ด้านหลังและด้านข้างทั้งสอง · ลมออก: พัดลมด้านบน
 * EER ใช้ค่าเฉลี่ย 3.5 ทุกรุ่น (catalog ไม่ได้ใช้ในแบบจำลองนี้) — แก้อัตราลมได้รายเครื่องในแผงคุณสมบัติ
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

export const SERIES = 'VRV 6A';
export const SERIES_CODE = 'RXQ-BY1S';

function build() {
  const list = [];
  for (const hp of Object.keys(MODULES).map(Number)) list.push(makeModel(hp, [hp], MODULES[hp].kw));
  for (const hp of Object.keys(COMBOS).map(Number)) list.push(makeModel(hp, COMBOS[hp][1], COMBOS[hp][0]));
  return list;
}

function makeModel(hp, mods, kw) {
  const ms = mods.map(m => MODULES[m]);
  const kwSum = ms.reduce((s, m) => s + m.kw, 0);
  const cmm = ms.reduce((s, m) => s + m.cmm, 0);
  const width = ms.reduce((s, m) => s + m.w, 0) + MODULE_GAP * (ms.length - 1);
  return {
    id: `RXQ${hp}BY1S`,
    hp, kw, cmm,
    eer: EER,
    kwScale: kw / kwSum,         // ปรับ kW รายโมดูลให้รวมกันเท่า capacity ชุดผสมใน catalog
    modules: mods,
    width,                       // mm รวมทั้งชุด
    fans: ms.reduce((s, m) => s + m.fans, 0),
  };
}

export const MODELS = build();
export const MODEL_BY_ID = Object.fromEntries(MODELS.map(m => [m.id, m]));

export function getModel(id) { return MODEL_BY_ID[id] || MODEL_BY_ID.RXQ16BY1S; }

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
  return m.modules.map(hp => {
    const s = MODULES[hp];
    const w = s.w / 1000;
    const r = { hp, kw: s.kw * m.kwScale, cmm: s.cmm * scale, eer: s.eer, fans: s.fans, w, x0: x, x1: x + w };
    x += w + MODULE_GAP / 1000;
    return r;
  });
}

export function unitSize(unit) {
  const m = getModel(unit.model);
  return { w: m.width / 1000, h: MODULE_H / 1000, d: MODULE_D / 1000 };
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
