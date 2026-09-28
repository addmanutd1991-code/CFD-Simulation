/* colormap.js — แถบสีของผลลัพธ์ (น้ำเงิน → ฟ้า → เหลือง → ส้ม → แดง) ใช้ร่วมกันทั้ง 3D และแถบสเกล */

export const STOPS = [
  [0.00, 38, 70, 178],
  [0.18, 42, 128, 216],
  [0.36, 80, 190, 225],
  [0.52, 186, 226, 150],
  [0.66, 248, 222, 92],
  [0.82, 246, 146, 58],
  [1.00, 208, 40, 48],
];

export function rgb(t) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const a = STOPS[i - 1], b = STOPS[i], f = (t - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
    }
  }
  const l = STOPS[STOPS.length - 1];
  return [l[1], l[2], l[3]];
}

export function cssGradient() {
  return 'linear-gradient(90deg,' + STOPS.map(s => `rgb(${s[1]},${s[2]},${s[3]}) ${s[0] * 100}%`).join(',') + ')';
}

/** ตัวแปรที่แสดงผลได้ พร้อมหน่วยและวิธีกำหนดช่วงสเกล */
export const FIELDS = {
  T: { label: 'อุณหภูมิ', unit: '°C', digits: 1 },
  dT: { label: 'อุณหภูมิเกินอากาศภายนอก', unit: 'K', digits: 1 },
  C: { label: 'สัดส่วนลมร้อนจาก CDU', unit: '%', digits: 0 },
  V: { label: 'ความเร็วลม', unit: 'm/s', digits: 2 },
};
