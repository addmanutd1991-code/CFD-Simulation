/*
 * viewer.js — การแสดงผล 3 มิติด้วย three.js
 * รับผิดชอบ: กล้อง/มุมมอง, รูปทรงอุปกรณ์, ระนาบตัดสี, เวกเตอร์ลม, อนุภาคลม, การเลือกและลากวัตถุ
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TYPES, toWorldBox, toWorldDir, worldFootprint } from './devices.js';

/* แถบสี coolwarm — ใช้ร่วมกับแถบสีใน CSS */
const RAMP = [
  [0.000, 59, 76, 192], [0.125, 89, 119, 227], [0.250, 123, 159, 249],
  [0.375, 163, 194, 252], [0.500, 201, 215, 240], [0.625, 237, 209, 194],
  [0.750, 247, 168, 137], [0.875, 231, 116, 91], [1.000, 180, 4, 38],
];

export function colorAt(t) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  for (let i = 1; i < RAMP.length; i++) {
    if (t <= RAMP[i][0]) {
      const a = RAMP[i - 1], b = RAMP[i];
      const f = (t - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
    }
  }
  return [180, 4, 38];
}

const MAX_VEC = 4000;
const MAX_PART = 2200;

export class Viewer {
  constructor(el) {
    this.el = el;
    this.devMeshes = new Map();
    this.selected = null;
    this.onSelect = null;
    this.onDragEnd = null;
    this.dims = { W: 5, H: 2.7, D: 4 };

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x11141a);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 500);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    el.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;

    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x2a2f3a, 2.0));
    const dl = new THREE.DirectionalLight(0xffffff, 1.5);
    dl.position.set(6, 12, 8);
    this.scene.add(dl);

    this.world = new THREE.Group();
    this.scene.add(this.world);

    this.roomGroup = new THREE.Group();
    this.deviceGroup = new THREE.Group();
    this.world.add(this.roomGroup, this.deviceGroup);

    this.#initSlice();
    this.#initVectors();
    this.#initParticles();
    this.#initPicking();

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();

    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
  }

  resize() {
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /* ───────── ห้อง / โดเมน ───────── */

  setRoom(W, H, D, openSides) {
    const key = `${W}|${H}|${D}|${openSides}`;
    const refit = this._roomKey !== key;
    this._roomKey = key;
    this.dims = { W, H, D };
    this.roomGroup.clear();

    const g = new THREE.BoxGeometry(W, H, D);
    g.translate(W / 2, H / 2, D / 2);
    const wire = new THREE.LineSegments(
      new THREE.EdgesGeometry(g),
      new THREE.LineBasicMaterial({ color: openSides ? 0x4a5468 : 0x6d7a93 })
    );
    this.roomGroup.add(wire);

    if (!openSides) {
      const shell = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
        color: 0x2a3244, transparent: true, opacity: 0.10, side: THREE.BackSide,
      }));
      this.roomGroup.add(shell);
    }

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(W, D),
      new THREE.MeshStandardMaterial({ color: openSides ? 0x39414f : 0x424c60, roughness: 0.95 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(W / 2, 0, D / 2);
    this.roomGroup.add(floor);
    this.floorMesh = floor;

    const grid = new THREE.GridHelper(Math.max(W, D), Math.round(Math.max(W, D)), 0x55607a, 0x39414f);
    grid.position.set(W / 2, 0.003, D / 2);
    this.roomGroup.add(grid);

    if (refit) this.viewFit();
  }

  /* ───────── อุปกรณ์ ───────── */

  syncDevices(devices) {
    const alive = new Set(devices.map(d => d.id));
    for (const [id, m] of this.devMeshes) {
      if (!alive.has(id)) { this.deviceGroup.remove(m); this.devMeshes.delete(id); }
    }
    for (const d of devices) {
      let m = this.devMeshes.get(d.id);
      if (m && m.userData.sig !== signature(d)) { this.deviceGroup.remove(m); this.devMeshes.delete(d.id); m = null; }
      if (!m) {
        m = buildDeviceMesh(d);
        this.deviceGroup.add(m);
        this.devMeshes.set(d.id, m);
      }
      m.position.set(d.pos.x, d.pos.y, d.pos.z);
      m.rotation.y = -d.yaw * Math.PI / 180;
      m.userData.dev = d;
      const isSel = this.selected === d.id;
      if (m.userData.outline) m.userData.outline.visible = isSel;
      m.traverse(o => { if (o.isMesh && o.userData.dim !== undefined) o.material.opacity = d.on === false ? 0.35 : o.userData.dim; });
    }
  }

  setSelected(id) {
    this.selected = id;
    for (const [mid, m] of this.devMeshes) {
      if (m.userData.outline) m.userData.outline.visible = mid === id;
    }
  }

  /* ───────── ระนาบตัดสี ───────── */

  #initSlice() {
    this.sliceTex = null;
    this.sliceMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
    );
    this.sliceMesh.visible = false;
    this.sliceMesh.renderOrder = 1;
    this.world.add(this.sliceMesh);
  }

  updateSlice(sl, lo, hi) {
    const { cols, rows, data, solid, axis, pos } = sl;
    if (!this.sliceTex || this.sliceTex.image.width !== cols || this.sliceTex.image.height !== rows) {
      const buf = new Uint8Array(cols * rows * 4);
      this.sliceTex = new THREE.DataTexture(buf, cols, rows, THREE.RGBAFormat);
      this.sliceTex.minFilter = THREE.LinearFilter;
      this.sliceTex.magFilter = THREE.LinearFilter;
      this.sliceMesh.material.map = this.sliceTex;
      this.sliceMesh.material.needsUpdate = true;
    }
    const buf = this.sliceTex.image.data;
    const span = Math.max(1e-6, hi - lo);
    for (let i = 0; i < cols * rows; i++) {
      const c = colorAt((data[i] - lo) / span);
      const o = i * 4;
      if (solid[i]) { buf[o] = 90; buf[o + 1] = 98; buf[o + 2] = 112; buf[o + 3] = 235; }
      else { buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = 230; }
    }
    this.sliceTex.needsUpdate = true;

    const { W, H, D } = this.dims;
    const m = this.sliceMesh;
    const key = `${axis}|${W}|${H}|${D}`;
    if (m.userData.key !== key) {
      m.geometry.dispose();
      m.geometry = axis === 'Y' ? new THREE.PlaneGeometry(W, D)
        : axis === 'X' ? new THREE.PlaneGeometry(D, H)
          : new THREE.PlaneGeometry(W, H);
      m.rotation.set(0, 0, 0);
      if (axis === 'Y') m.rotation.x = Math.PI / 2;
      else if (axis === 'X') m.rotation.y = -Math.PI / 2;
      m.userData.key = key;
    }
    if (axis === 'Y') m.position.set(W / 2, pos, D / 2);
    else if (axis === 'X') m.position.set(pos, H / 2, D / 2);
    else m.position.set(W / 2, H / 2, pos);
    m.visible = true;
  }

  hideSlice() { this.sliceMesh.visible = false; }

  /* ───────── เวกเตอร์ลม ───────── */

  #initVectors() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_VEC * 6), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_VEC * 6), 3));
    this.vecGeo = g;
    this.vectors = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }));
    this.vectors.visible = false;
    this.vectors.renderOrder = 2;
    this.world.add(this.vectors);
  }

  updateVectors(solver, axis, posT, vmax) {
    const pos = this.vecGeo.attributes.position.array;
    const col = this.vecGeo.attributes.color.array;
    const { W, H, D } = this.dims;
    const h = solver.h;
    const stride = Math.max(1, Math.round(0.28 / h));
    const step = h * stride;
    // ความเร็วที่หัวจ่ายลมสูงกว่าลมในห้องหลายเท่า ถ้าปรับสเกลตรง ๆ เวกเตอร์ในห้อง
    // จะสั้นจนมองไม่เห็น จึงกำหนดความยาวขั้นต่ำไว้และให้สีเป็นตัวบอกความเร็วแทน
    const ref = Math.max(0.3, vmax);
    const v = [0, 0, 0];
    let n = 0;

    const emit = (x, y, z) => {
      if (n >= MAX_VEC) return;
      if (solver.isSolidAt(x, y, z)) return;
      solver.sampleVel(x, y, z, v);
      const s = Math.hypot(v[0], v[1], v[2]);
      if (s < 0.015) return;
      const len = step * (0.35 + 0.6 * Math.min(1, s / ref)) / s;
      const o = n * 6;
      pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
      pos[o + 3] = x + v[0] * len; pos[o + 4] = y + v[1] * len; pos[o + 5] = z + v[2] * len;
      const c = colorAt(Math.min(1, Math.sqrt(s / ref)));
      for (let q = 0; q < 2; q++) {
        col[o + q * 3] = 0.35 + 0.65 * c[0] / 255;
        col[o + q * 3 + 1] = 0.35 + 0.65 * c[1] / 255;
        col[o + q * 3 + 2] = 0.35 + 0.65 * c[2] / 255;
      }
      n++;
    };

    if (axis === 'Y') {
      const y = posT * H;
      for (let z = step / 2; z < D; z += step) for (let x = step / 2; x < W; x += step) emit(x, y, z);
    } else if (axis === 'X') {
      const x = posT * W;
      for (let y = step / 2; y < H; y += step) for (let z = step / 2; z < D; z += step) emit(x, y, z);
    } else {
      const z = posT * D;
      for (let y = step / 2; y < H; y += step) for (let x = step / 2; x < W; x += step) emit(x, y, z);
    }

    this.vecGeo.setDrawRange(0, n * 2);
    this.vecGeo.attributes.position.needsUpdate = true;
    this.vecGeo.attributes.color.needsUpdate = true;
    this.vectors.visible = n > 0;
  }

  hideVectors() { this.vectors.visible = false; }

  /* ───────── อนุภาคลม ───────── */

  #initParticles() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PART * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_PART * 3), 3));
    this.partGeo = g;
    this.partLife = new Float32Array(MAX_PART);
    this.particles = new THREE.Points(g, new THREE.PointsMaterial({
      size: 0.055, vertexColors: true, transparent: true, opacity: 0.9,
      sizeAttenuation: true, depthWrite: false,
    }));
    this.particles.visible = false;
    this.particles.renderOrder = 3;
    this.world.add(this.particles);
    this.partCount = 0;
    this.seeds = [];
  }

  setSeeds(seeds) { this.seeds = seeds; }

  #respawn(i, pos) {
    const { W, H, D } = this.dims;
    const o = i * 3;
    if (this.seeds.length && Math.random() < 0.82) {
      const s = this.seeds[(Math.random() * this.seeds.length) | 0];
      pos[o] = s[0] + (Math.random() - 0.5) * 0.12;
      pos[o + 1] = s[1] + (Math.random() - 0.5) * 0.12;
      pos[o + 2] = s[2] + (Math.random() - 0.5) * 0.12;
    } else {
      pos[o] = Math.random() * W; pos[o + 1] = Math.random() * H; pos[o + 2] = Math.random() * D;
    }
    this.partLife[i] = 1.5 + Math.random() * 6;
  }

  updateParticles(solver, dt, vmax) {
    const want = Math.min(MAX_PART, this.seeds.length ? MAX_PART : 900);
    const pos = this.partGeo.attributes.position.array;
    const col = this.partGeo.attributes.color.array;
    const { W, H, D } = this.dims;
    if (this.partCount < want) {
      for (let i = this.partCount; i < want; i++) this.#respawn(i, pos);
      this.partCount = want;
    }
    const v = [0, 0, 0];
    for (let i = 0; i < this.partCount; i++) {
      const o = i * 3;
      this.partLife[i] -= dt;
      solver.sampleVel(pos[o], pos[o + 1], pos[o + 2], v);
      const s = Math.hypot(v[0], v[1], v[2]);
      pos[o] += v[0] * dt; pos[o + 1] += v[1] * dt; pos[o + 2] += v[2] * dt;
      const out = pos[o] < 0 || pos[o] > W || pos[o + 1] < 0 || pos[o + 1] > H || pos[o + 2] < 0 || pos[o + 2] > D;
      if (out || this.partLife[i] <= 0 || s < 0.008 || solver.isSolidAt(pos[o], pos[o + 1], pos[o + 2])) {
        this.#respawn(i, pos);
      }
      // ใช้รากที่สองของอัตราส่วนความเร็ว เพื่อให้อนุภาคในห้องยังมีสีชัด
      // ไม่ถูกความเร็วที่หัวจ่ายลมกลบจนกลายเป็นจุดดำ
      const c = colorAt(Math.min(1, Math.sqrt(s / Math.max(0.35, vmax))));
      col[o] = c[0] / 255; col[o + 1] = c[1] / 255; col[o + 2] = c[2] / 255;
    }
    this.partGeo.setDrawRange(0, this.partCount);
    this.partGeo.attributes.position.needsUpdate = true;
    this.partGeo.attributes.color.needsUpdate = true;
    this.particles.visible = true;
  }

  hideParticles() { this.particles.visible = false; }

  /* ───────── การเลือกและลากวัตถุ ───────── */

  #initPicking() {
    const dom = this.renderer.domElement;
    const plane = new THREE.Plane();
    const hit = new THREE.Vector3();
    let dragging = null, grabOff = new THREE.Vector3(), moved = false;

    const setPointer = (e) => {
      const r = dom.getBoundingClientRect();
      this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    };

    dom.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      setPointer(e);
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const hits = this.raycaster.intersectObjects(this.deviceGroup.children, true);
      if (!hits.length) { if (this.onSelect) this.onSelect(null); return; }
      let root = hits[0].object;
      while (root.parent && !root.userData.dev) root = root.parent;
      const dev = root.userData.dev;
      if (!dev) return;
      if (this.onSelect) this.onSelect(dev.id);

      plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, dev.pos.y, 0));
      if (this.raycaster.ray.intersectPlane(plane, hit)) {
        grabOff.set(dev.pos.x - hit.x, 0, dev.pos.z - hit.z);
        dragging = dev;
        moved = false;
        // OrbitControls จับตัวชี้ไว้แล้ว จึงเพียงปิดการหมุนกล้องระหว่างลาก
        this.controls.enabled = false;
      }
    });

    dom.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      setPointer(e);
      this.raycaster.setFromCamera(this.pointer, this.camera);
      if (!this.raycaster.ray.intersectPlane(plane, hit)) return;
      const fp = worldFootprint(dragging);
      const { W, D } = this.dims;
      dragging.pos.x = clamp(hit.x + grabOff.x, fp.x / 2, W - fp.x / 2);
      dragging.pos.z = clamp(hit.z + grabOff.z, fp.z / 2, D - fp.z / 2);
      const m = this.devMeshes.get(dragging.id);
      if (m) m.position.set(dragging.pos.x, dragging.pos.y, dragging.pos.z);
      moved = true;
    });

    const end = () => {
      if (!dragging) return;
      const d = dragging;
      dragging = null;
      this.controls.enabled = true;
      if (moved && this.onDragEnd) this.onDragEnd(d);
    };
    dom.addEventListener('pointerup', end);
    dom.addEventListener('pointercancel', end);
  }

  /* ───────── มุมมอง ───────── */

  viewFit() {
    const { W, H, D } = this.dims;
    const r = Math.max(W, H, D);
    this.controls.target.set(W / 2, H / 2, D / 2);
    this.camera.position.set(W / 2 + r * 1.05, H / 2 + r * 0.85, D / 2 + r * 1.25);
    this.controls.update();
  }

  viewPreset(which) {
    const { W, H, D } = this.dims;
    const r = Math.max(W, H, D);
    this.controls.target.set(W / 2, H / 2, D / 2);
    if (which === 'top') this.camera.position.set(W / 2, H / 2 + r * 2.0, D / 2 + 0.001);
    else if (which === 'front') this.camera.position.set(W / 2, H / 2, D / 2 + r * 2.0);
    else this.camera.position.set(W / 2 + r * 1.05, H / 2 + r * 0.85, D / 2 + r * 1.25);
    this.controls.update();
  }
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

function signature(d) {
  return [d.type, d.yaw, d.size.x, d.size.y, d.size.z, d.vane, d.discharge, d.on].join('|');
}

/* ───────── การสร้างรูปทรงอุปกรณ์ ───────── */

function buildDeviceMesh(dev) {
  const def = TYPES[dev.type];
  const g = new THREE.Group();
  const s = dev.size;

  const bodyMat = new THREE.MeshStandardMaterial({
    color: def.color, roughness: 0.55, metalness: 0.08,
    transparent: true, opacity: def.kind === 'heat' ? 0.55 : 0.95,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(s.x, s.y, s.z), bodyMat);
  body.userData.dim = bodyMat.opacity;
  g.add(body);

  g.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(s.x, s.y, s.z)),
    new THREE.LineBasicMaterial({ color: 0x1a1f28, transparent: true, opacity: 0.5 })
  ));

  // หน้ากริลจ่ายลม / ลมกลับ วาดจากนิยามชุดเดียวกับที่ใช้คำนวณ
  for (const r of def.regions(dev)) {
    const b = r.box;
    const w = Math.max(0.03, b.x1 - b.x0), hh = Math.max(0.03, b.y1 - b.y0), dd = Math.max(0.03, b.z1 - b.z0);
    const isSupply = r.role === 'supply';
    const mat = new THREE.MeshStandardMaterial({
      color: isSupply ? (def.kind === 'cdu' ? 0xf0763c : 0x37c6f0) : 0x6b7589,
      emissive: isSupply ? (def.kind === 'cdu' ? 0x4a1c06 : 0x06384a) : 0x000000,
      roughness: 0.4, transparent: true, opacity: 0.95,
    });
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, hh, dd), mat);
    m.position.set((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2);
    m.userData.dim = 0.95;
    g.add(m);

    if (isSupply) {
      const dir = new THREE.Vector3(r.dir[0], r.dir[1], r.dir[2]).normalize();
      const arrow = new THREE.ArrowHelper(dir, m.position.clone(), 0.42,
        def.kind === 'cdu' ? 0xf0763c : 0x37c6f0, 0.13, 0.09);
      g.add(arrow);
    }
  }

  const out = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(s.x * 1.10 + 0.06, s.y * 1.10 + 0.06, s.z * 1.10 + 0.06)),
    new THREE.LineBasicMaterial({ color: 0x2f9bdb, depthTest: false })
  );
  out.renderOrder = 5;
  out.visible = false;
  g.add(out);
  g.userData.outline = out;
  g.userData.sig = signature(dev);
  g.userData.dev = dev;
  return g;
}

/** จุดปล่อยอนุภาคลม — กึ่งกลางหน้าจ่ายลมของทุกเครื่องที่เปิดอยู่ */
export function supplySeeds(devices) {
  const seeds = [];
  for (const d of devices) {
    const def = TYPES[d.type];
    if ((def.kind !== 'ac' && def.kind !== 'cdu') || !d.on) continue;
    for (const r of def.regions(d)) {
      if (r.role !== 'supply') continue;
      const b = toWorldBox(d, r.box);
      const dir = toWorldDir(d, r.dir);
      seeds.push([
        (b.x0 + b.x1) / 2 + dir[0] * 0.10,
        (b.y0 + b.y1) / 2 + dir[1] * 0.10,
        (b.z0 + b.z1) / 2 + dir[2] * 0.10,
      ]);
    }
  }
  return seeds;
}
