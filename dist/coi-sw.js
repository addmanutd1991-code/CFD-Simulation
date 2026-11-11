/*
 * coi-sw.js — service worker ที่เติมส่วนหัว COOP/COEP ให้ทุกการตอบกลับ ทำให้หน้าเว็บเป็น
 * "cross-origin isolated" โดยไม่ต้องตั้งค่าเว็บเซิร์ฟเวอร์ → เบราว์เซอร์ยอมให้ใช้ SharedArrayBuffer
 * ซึ่ง solver ต้องใช้เพื่อคำนวณหลายเธรด (ดู src/kernels.js)
 *
 * ทำงานเฉพาะเมื่อเปิดผ่าน http(s) (เช่น npm run serve หรือ GitHub Pages) — เปิดไฟล์ด้วย file://
 * ใช้ service worker ไม่ได้ โปรแกรมจะคำนวณเธรดเดียวตามเดิม
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  e.respondWith(fetch(req).then((res) => {
    if (res.status === 0) return res;   // การตอบกลับแบบ opaque แก้ส่วนหัวไม่ได้
    const headers = new Headers(res.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }));
});
