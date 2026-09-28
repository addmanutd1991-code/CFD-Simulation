/*
 * presets.js — ตัวอย่างงานสำเร็จรูป ใช้เป็นจุดตั้งต้นของการจำลอง
 * โครงสร้างเดียวกับไฟล์โปรเจกต์ที่บันทึก/เปิดได้
 */

export const PRESETS = {
  bedroom: {
    label: 'ห้องนอน + แอร์ติดผนัง',
    mode: 'indoor', ambient: 32, mesh: 0.15,
    room: { W: 4.0, H: 2.6, D: 3.5 },
    devices: [
      { type: 'wall', pos: { x: 0.14, z: 1.75 }, yaw: 0, btu: 12000, vane: 20, mountY: 2.10, setpoint: 25 },
      { type: 'box', name: 'เตียงนอน', pos: { x: 2.3, z: 1.75 }, yaw: 0, size: { x: 2.0, y: 0.55, z: 1.6 } },
      { type: 'heat', name: 'ผู้นอน 2 คน', pos: { x: 2.3, z: 1.75 }, yaw: 0, size: { x: 1.8, y: 0.35, z: 1.4 }, mountY: 0.75, watts: 160 },
    ],
  },

  meeting: {
    label: 'ห้องประชุม + คาสเซ็ท 2 ตัว',
    mode: 'indoor', ambient: 33, mesh: 0.15,
    room: { W: 8.0, H: 2.8, D: 6.0 },
    devices: [
      { type: 'cassette', pos: { x: 2.6, z: 3.0 }, yaw: 0, btu: 24000, vane: 35, setpoint: 24 },
      { type: 'cassette', pos: { x: 5.4, z: 3.0 }, yaw: 0, btu: 24000, vane: 35, setpoint: 24 },
      { type: 'box', name: 'โต๊ะประชุม', pos: { x: 4.0, z: 3.0 }, yaw: 0, size: { x: 3.4, y: 0.75, z: 1.4 } },
      { type: 'heat', name: 'ผู้เข้าประชุม 12 คน', pos: { x: 4.0, z: 3.0 }, yaw: 0, size: { x: 4.0, y: 1.1, z: 2.4 }, mountY: 0.9, watts: 1320 },
      { type: 'heat', name: 'โปรเจกเตอร์ + จอ', pos: { x: 7.3, z: 3.0 }, yaw: 0, size: { x: 0.4, y: 1.2, z: 2.0 }, mountY: 1.6, watts: 450 },
    ],
  },

  shop: {
    label: 'ร้านค้า + แอร์ตั้งพื้น',
    mode: 'indoor', ambient: 34, mesh: 0.15,
    room: { W: 6.0, H: 3.2, D: 9.0 },
    devices: [
      { type: 'floor', pos: { x: 0.45, z: 2.0 }, yaw: 0, btu: 36000, vane: 15, setpoint: 25 },
      { type: 'floor', pos: { x: 5.55, z: 6.5 }, yaw: 180, btu: 36000, vane: 15, setpoint: 25 },
      { type: 'box', name: 'ชั้นวางสินค้า A', pos: { x: 2.2, z: 4.5 }, yaw: 0, size: { x: 0.7, y: 1.9, z: 5.0 } },
      { type: 'box', name: 'ชั้นวางสินค้า B', pos: { x: 3.9, z: 4.5 }, yaw: 0, size: { x: 0.7, y: 1.9, z: 5.0 } },
      { type: 'heat', name: 'ไฟส่องสว่าง', pos: { x: 3.0, z: 4.5 }, yaw: 0, size: { x: 5.0, y: 0.3, z: 7.5 }, mountY: 2.9, watts: 900 },
    ],
  },

  'vrv-wall': {
    label: 'คอยล์ร้อน VRV 6A 2 ระบบชิดกำแพง (ตรวจ Short-circuit)',
    mode: 'outdoor', ambient: 35, mesh: 0.15, wind: { speed: 0.5, dirDeg: 0 },
    room: { W: 9.0, H: 4.5, D: 6.0 },
    devices: [
      { type: 'box', name: 'กำแพงอาคาร', pos: { x: 4.5, z: 0.30 }, yaw: 0, size: { x: 8.6, y: 4.5, z: 0.30 } },
      // หมุน 270° ให้ด้านหน้า (แผงปิด) หันออกจากกำแพง — คอยล์ด้านหลังห่างกำแพง 50 ซม.
      { type: 'outdoor', name: 'VRV-1', pos: { x: 2.4, z: 1.33 }, yaw: 270, model: 'RXQ34BY1S' },
      { type: 'outdoor', name: 'VRV-2', pos: { x: 6.4, z: 1.33 }, yaw: 270, model: 'RXQ28BY1S' },
      { type: 'box', name: 'รั้วบังตา', pos: { x: 4.5, z: 3.2 }, yaw: 0, size: { x: 8.0, y: 1.8, z: 0.15 } },
    ],
  },

  // ผังเดียวกับตัวอย่างใน CDU Airflow CFD: ลานวางเครื่อง 24 × 16 ม. อากาศ 35 °C ไม่มีลม
  // คอยล์ร้อน VRV 6A สองแถวหันด้านหน้าเข้าหากัน ด้านหลังชิด louver พื้นที่เปิด 50 %
  // yaw 270 = ด้านหน้าหัน +Z, yaw 90 = ด้านหน้าหัน −Z (ลมเข้าด้านหลังและด้านข้าง ลมออกด้านบน)
  'vrv-yard': {
    label: 'ลานคอยล์ร้อน VRV 6A 6 ชุด + louver',
    mode: 'outdoor', ambient: 35, mesh: 0.25, wind: { speed: 0, dirDeg: 180 },
    room: { W: 24, H: 8, D: 16 },
    devices: [
      { type: 'box', name: 'ห้องเครื่อง / ช่องบันได', pos: { x: 2.5, z: 8 }, yaw: 0, size: { x: 5, y: 4.5, z: 16 } },
      { type: 'louver', name: 'Louver ด้านเหนือ', pos: { x: 13, z: 3 }, yaw: 0, size: { x: 14, y: 2.4, z: 0.1 }, free: 50 },
      { type: 'louver', name: 'Louver ด้านตะวันออก', pos: { x: 20, z: 8 }, yaw: 0, size: { x: 0.1, y: 2.4, z: 10 }, free: 50 },
      { type: 'louver', name: 'Louver ด้านใต้', pos: { x: 13, z: 13 }, yaw: 0, size: { x: 14, y: 2.4, z: 0.1 }, free: 50 },
      { type: 'outdoor', name: 'CDU-1', model: 'RXQ20BY1S', pos: { x: 9, z: 4.4 }, yaw: 270 },
      { type: 'outdoor', name: 'CDU-2', model: 'RXQ28BY1S', pos: { x: 13, z: 4.4 }, yaw: 270 },
      { type: 'outdoor', name: 'CDU-3', model: 'RXQ20BY1S', pos: { x: 17, z: 4.4 }, yaw: 270 },
      { type: 'outdoor', name: 'CDU-4', model: 'RXQ16BY1S', pos: { x: 9, z: 11.6 }, yaw: 90 },
      { type: 'outdoor', name: 'CDU-5', model: 'RXQ28BY1S', pos: { x: 13, z: 11.6 }, yaw: 90 },
      { type: 'outdoor', name: 'CDU-6', model: 'RXQ16BY1S', pos: { x: 17, z: 11.6 }, yaw: 90 },
    ],
  },
};
