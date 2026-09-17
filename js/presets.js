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

  'cdu-wall': {
    label: 'คอยล์ร้อน 2 ตัวชิดกำแพง (ตรวจ Short-circuit)',
    mode: 'outdoor', ambient: 35, mesh: 0.15, wind: { speed: 0.5, dirDeg: 0 },
    room: { W: 7.0, H: 4.0, D: 5.0 },
    devices: [
      { type: 'box', name: 'กำแพงอาคาร', pos: { x: 3.5, z: 0.45 }, yaw: 0, size: { x: 6.6, y: 4.0, z: 0.3 } },
      { type: 'outdoor', name: 'CDU-1', pos: { x: 2.3, z: 1.1 }, yaw: 180, btu: 24000, discharge: 'front', mountY: 0.45 },
      { type: 'outdoor', name: 'CDU-2', pos: { x: 4.7, z: 1.1 }, yaw: 180, btu: 24000, discharge: 'front', mountY: 0.45 },
      { type: 'box', name: 'รั้วบังตา', pos: { x: 3.5, z: 2.6 }, yaw: 0, size: { x: 6.0, y: 1.8, z: 0.15 } },
    ],
  },
};
