/*
 * models.js — คลังรุ่นคอยล์ร้อน Daikin VRV และสมการสมรรถนะเทียบอุณหภูมิลมเข้าคอยล์
 *
 * ตัวเลขในตารางเป็นค่าอ้างอิงโดยประมาณสำหรับงานเปรียบเทียบผังการวางเครื่อง
 * ก่อนใช้งานจริงให้ตรวจกับ Engineering Databook ของรุ่นที่ใช้ และแก้อัตราลม
 * ได้รายเครื่องในแผงคุณสมบัติ
 */

/** โมดูลเดี่ยว — ขนาดเป็นมิลลิเมตร อัตราลมเป็น m³/min */
export const MODULES = {
  6:  { hp: 6,  kw: 16.0, cmm: 162, w: 930,  fans: 1, eer: 4.0 },
  8:  { hp: 8,  kw: 22.4, cmm: 175, w: 930,  fans: 1, eer: 3.9 },
  10: { hp: 10, kw: 28.0, cmm: 185, w: 930,  fans: 1, eer: 3.6 },
  12: { hp: 12, kw: 33.5, cmm: 223, w: 1240, fans: 2, eer: 3.7 },
  14: { hp: 14, kw: 40.0, cmm: 260, w: 1240, fans: 2, eer: 3.5 },
  16: { hp: 16, kw: 45.0, cmm: 251, w: 1240, fans: 2, eer: 3.3 },
  18: { hp: 18, kw: 50.0, cmm: 261, w: 1240, fans: 2, eer: 3.2 },
  20: { hp: 20, kw: 56.0, cmm: 271, w: 1240, fans: 2, eer: 3.1 },
};

export const MODULE_H = 1657;   // mm
export const MODULE_D = 765;    // mm
export const MODULE_GAP = 20;   // mm — ระยะห่างระหว่างโมดูลในชุดคอมบิเนชัน
export const FAN_AREA = 0.36;   // m² — พื้นที่หน้าตะแกรงพัดลมต่อหนึ่งใบพัด (Ø ~0.68 m)

/** ชุดคอมบิเนชัน (HP รวม → โมดูลที่ใช้) */
const COMBOS = {
  22: [10, 12], 24: [8, 16], 26: [10, 16], 28: [12, 16], 30: [12, 18], 32: [16, 16],
  34: [16, 18], 36: [16, 20], 38: [8, 10, 20], 40: [10, 12, 18], 42: [10, 16, 16],
  44: [12, 16, 16], 46: [14, 16, 16], 48: [16, 16, 16], 50: [16, 16, 18],
  52: [16, 18, 18], 54: [18, 18, 18], 56: [16, 20, 20], 58: [18, 20, 20], 60: [20, 20, 20],
};

export const SERIES = 'VRV 6A';
export const SERIES_CODE = 'RXQ-BY1S';

function build() {
  const list = [];
  for (const hp of Object.keys(MODULES).map(Number)) list.push(makeModel(hp, [hp]));
  for (const hp of Object.keys(COMBOS).map(Number)) list.push(makeModel(hp, COMBOS[hp]));
  return list;
}

function makeModel(hp, mods) {
  const ms = mods.map(m => MODULES[m]);
  const kw = ms.reduce((s, m) => s + m.kw, 0);
  const cmm = ms.reduce((s, m) => s + m.cmm, 0);
  const powerKw = ms.reduce((s, m) => s + m.kw / m.eer, 0);
  const width = ms.reduce((s, m) => s + m.w, 0) + MODULE_GAP * (ms.length - 1);
  return {
    id: `RXQ${hp}BY1S`,
    hp, kw, cmm,
    eer: kw / powerKw,
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
    const r = { hp, kw: s.kw, cmm: s.cmm * scale, eer: s.eer, fans: s.fans, w, x0: x, x1: x + w };
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
  kCap: 0.013,   // สัดส่วนความสามารถทำความเย็นที่ลดลงต่อ 1 K
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
