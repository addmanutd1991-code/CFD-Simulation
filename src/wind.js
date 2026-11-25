/*
 * wind.js — โปรไฟล์ความเร็วลมตามความสูง (power law) ที่ขอบต้นลม
 *
 *   V(z) = Vref · (z / zref)^α      z = ระดับพื้นที่วางเครื่องเหนือพื้นดิน + ความสูงในโดเมน
 *
 * Vref คือความเร็วลมที่ผู้ใช้กรอก (วัดที่ความสูงอ้างอิง zref เหนือพื้นดิน ค่าเริ่มต้น 10 ม. ตามข้อมูลอุตุนิยมวิทยา)
 * α ตามสภาพพื้นที่ (ค่าประมาณทั่วไปของ power law, Davenport / ASCE 7):
 *   โล่ง 0.14 · ชานเมือง 0.22 · เมือง 0.30 · ใจกลางเมือง / ตึกสูงหนาแน่น 0.40
 * 'uniform' = ความเร็วเท่ากันทุกระดับ (แบบเดิม)
 */

export const WIND_PROFILES = {
  uniform: { alpha: 0, th: 'สม่ำเสมอทุกระดับ (แบบเดิม)', en: 'Uniform at all heights (legacy)' },
  open: { alpha: 0.14, th: 'พื้นที่โล่ง (α 0.14)', en: 'Open terrain (α 0.14)' },
  suburban: { alpha: 0.22, th: 'ชานเมือง (α 0.22)', en: 'Suburban (α 0.22)' },
  urban: { alpha: 0.30, th: 'เมือง (α 0.30)', en: 'Urban (α 0.30)' },
  center: { alpha: 0.40, th: 'ใจกลางเมือง ตึกสูงหนาแน่น (α 0.40)', en: 'City centre, dense high-rise (α 0.40)' },
};

/** ความสูงต่ำสุด (ม. เหนือพื้นดิน) ที่ใช้ในสูตร — ใกล้พื้นมาก power law ให้ความเร็วเข้าใกล้ศูนย์ */
export const WIND_ZMIN = 1;

/**
 * ฟังก์ชันตัวคูณความเร็ว f(y) — y = ความสูงในโดเมน (ม. เหนือพื้นของโดเมน)
 * wind = { profile, refHeight, groundElev }
 */
export function windFactorFn(wind = {}) {
  const a = (WIND_PROFILES[wind.profile] || WIND_PROFILES.uniform).alpha;
  if (!(a > 0)) return () => 1;
  const zref = Math.max(1, Number(wind.refHeight) || 10);
  const g = Math.max(0, Number(wind.groundElev) || 0);
  return (y) => Math.pow(Math.max(WIND_ZMIN, g + Math.max(0, y)) / zref, a);
}

/** ค่าพารามิเตอร์ลมจากฉาก (ส่งให้ solver) */
export function windParams(site) {
  return { profile: site.windProfile || 'uniform', refHeight: site.windRefH ?? 10, groundElev: site.groundElev ?? 0 };
}
