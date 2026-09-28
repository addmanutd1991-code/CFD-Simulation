/* worker.js — ห่อ engine ให้ทำงานใน Web Worker */
import { createEngine } from './engine.js';

const engine = createEngine((msg, transfer) => self.postMessage(msg, transfer || []));
self.onmessage = (e) => engine.handle(e.data);
