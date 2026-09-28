/*
 * viewer.js — มุมมองสามมิติ (three.js)
 *
 * หน้าที่: วาดวัตถุในฉาก ป้ายชื่อ ไม้บรรทัดบนพื้น ระนาบหน้าตัด อนุภาคลม ผิวลมร้อน (iso-surface)
 * และรับการโต้ตอบของผู้ใช้: เลือก/ลากย้ายวัตถุ วาง CDU ลากผนัง วาดอาคาร เลื่อนระนาบหน้าตัด
 *
 * ไม่แก้ข้อมูลฉากเอง ยกเว้นระหว่างลากวัตถุ (อัปเดตสด) — ส่งเหตุการณ์กลับผ่าน callbacks
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { unitModules, unitSize, getModel } from './models.js';
import { cduFootprint } from './scene.js';
import { rgb } from './colormap.js';

const ACCENT = 0x4fc3f7;
const SNAP = 0.1;
const MAX_STREAKS = 3200;

export class Viewer {
  constructor(host, cb) {
    this.host = host;
    this.cb = cb;
    this.tool = 'select';
    this.selectedId = null;
    this.scene3 = new THREE.Scene();
    this.objects = [];
    this.meshes = new Map();
    this.dom = null;
    this.results = null;
    this.section = { axis: 'x', pos: 0, show: true };
    this.display = { field: 'T', particles: true, iso: true, isoDT: 2, labels: false, range: null };

    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.setClearColor(0x1a2530);
    host.appendChild(r.domElement);
    r.domElement.classList.add('gl');

    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'labels hidden';   // ปิดป้ายชื่อเป็นค่าเริ่มต้น ไม่ให้บังผล
    host.appendChild(this.labelLayer);

    this.persp = new THREE.PerspectiveCamera(40, 1, 0.1, 2000);
    this.ortho = new THREE.OrthographicCamera(-10, 10, 10, -10, -500, 2000);
    this.camera = this.persp;
    this.view = '3d';
    this.controls = new OrbitControls(this.persp, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.screenSpacePanning = true;

    const hemi = new THREE.HemisphereLight(0xf1f6ff, 0x5d6670, 1.6);
    this.scene3.add(hemi);
    const sun = this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    this.scene3.add(sun, sun.target);

    this.gGround = new THREE.Group();
    this.gObjects = new THREE.Group();
    this.gHandles = new THREE.Group();
    this.gPreview = new THREE.Group();
    this.scene3.add(this.gGround, this.gObjects, this.gHandles, this.gPreview);

    this.#initSection();
    this.#initStreaks();
    this.#initIso();
    this.#initInput();

    this.ray = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.textures = makeTextures();

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.clock = new THREE.Clock();
    const tick = () => {
      requestAnimationFrame(tick);
      this.#frame(Math.min(0.05, this.clock.getDelta()));
    };
    requestAnimationFrame(tick);
  }

  /* ───────── ขนาด / กล้อง ───────── */

  resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this.#fitOrtho();
  }

  #fitOrtho() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1, a = w / h;
    const s = this.orthoSize || 20;
    this.ortho.left = -s * a / 2; this.ortho.right = s * a / 2;
    this.ortho.top = s / 2; this.ortho.bottom = -s / 2;
    this.ortho.updateProjectionMatrix();
  }

  setView(view) {
    this.view = view;
    const d = this.dom;
    if (!d) return;
    const cx = d.ox + d.W / 2, cz = d.oz + d.D / 2, cy = Math.min(d.H / 3, 3);
    const c = this.controls;
    if (view === '3d') {
      this.camera = this.persp;
      c.object = this.persp;
      const R = Math.max(d.W, d.D, d.H * 1.6) * 0.95;
      this.persp.position.set(cx - R * 0.55, R * 0.62, cz + R * 0.95);
      c.target.set(cx, cy, cz);
      c.enableRotate = true;
      c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    } else {
      this.camera = this.ortho;
      c.object = this.ortho;
      const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
      if (view === 'top') {
        this.orthoSize = Math.max(d.D, d.W * h / w) * 1.08;
        this.ortho.position.set(cx, 200, cz + 0.0001);
        this.ortho.up.set(0, 1, 0);
        c.target.set(cx, 0, cz);
      } else {
        this.orthoSize = Math.max(d.H * 1.25, d.W * h / w * 1.05);
        this.ortho.position.set(cx, d.H * 0.4, cz + 300);
        c.target.set(cx, d.H * 0.4, cz);
      }
      this.ortho.zoom = 1;
      this.#fitOrtho();
      c.enableRotate = false;
      c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    }
    this.camera.updateProjectionMatrix();
    c.update();
  }

  /* ───────── ฉาก ───────── */

  /** รับฉากทั้งหมด (อ้างอิงวัตถุจริง ใช้แก้สดระหว่างลาก) */
  setModel(scene, dom) {
    this.sceneData = scene;
    this.objects = scene.objects;
    const bcKey = JSON.stringify(scene.bc || {});
    const domChanged = !this.dom || this._bcKey !== bcKey || ['ox', 'oz', 'W', 'D', 'H'].some(k => Math.abs(this.dom[k] - dom[k]) > 1e-6);
    const first = !this.dom;
    this.dom = dom;
    this._bcKey = bcKey;
    if (domChanged) this.#buildGround();
    this.#buildWindArrow();
    this.#rebuildObjects();
    this.#updateSectionGeometry();
    if (first) this.setView(this.view);
  }

  setSelected(id) {
    this.selectedId = id;
    for (const [oid, g] of this.meshes) if (g.userData.outline) g.userData.outline.visible = oid === id;
    this.#buildHandles();
  }

  #rebuildObjects() {
    for (const g of this.meshes.values()) { this.gObjects.remove(g); disposeGroup(g); }
    this.meshes.clear();
    this.labelLayer.querySelectorAll('.lbl').forEach(e => e.remove());
    for (const o of this.objects) this.#addObjectMesh(o);
    this.setSelected(this.selectedId);
  }

  /** สร้างใหม่เฉพาะวัตถุเดียว (ใช้ระหว่างลาก) */
  refreshObject(o) {
    const old = this.meshes.get(o.id);
    if (old) { this.gObjects.remove(old); disposeGroup(old); old.userData.label?.remove(); }
    this.#addObjectMesh(o);
    this.setSelected(this.selectedId);
  }

  #addObjectMesh(o) {
    const g = o.type === 'cdu' ? this.#cduMesh(o) : o.type === 'wall' ? this.#wallMesh(o) : this.#buildingMesh(o);
    g.userData.objId = o.id;
    g.traverse(m => { if (m.isMesh) { m.userData.objId = o.id; } });
    // เส้นกรอบเมื่อถูกเลือก — วัดขนาดในพิกัดเฉพาะตัวของกลุ่ม (ปิดการหมุน/เลื่อนชั่วคราว)
    const pos0 = g.position.clone(), rot0 = g.rotation.y;
    g.position.set(0, 0, 0); g.rotation.y = 0; g.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(g);
    g.position.copy(pos0); g.rotation.y = rot0; g.updateMatrixWorld(true);
    const size = box.getSize(new THREE.Vector3()).addScalar(0.12), ctr = box.getCenter(new THREE.Vector3());
    const out = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z)),
      new THREE.LineBasicMaterial({ color: ACCENT, depthTest: false, transparent: true }));
    out.position.copy(ctr);
    out.renderOrder = 10;
    out.visible = false;
    out.raycast = () => {};
    g.add(out);
    g.userData.outline = out;
    // ป้ายชื่อ
    const lbl = document.createElement('div');
    lbl.className = 'lbl lbl-' + o.type;
    this.labelLayer.appendChild(lbl);
    g.userData.label = lbl;
    g.userData.anchor = g.localToWorld(new THREE.Vector3(ctr.x, box.max.y + 0.25, ctr.z));
    this.#fillLabel(o, lbl);
    this.gObjects.add(g);
    this.meshes.set(o.id, g);
  }

  #fillLabel(o, el) {
    let html;
    if (o.type === 'cdu') {
      html = `<b>${esc(o.name)}</b> · ${esc(getModel(o.model).id)}`;
      const r = this.results?.units?.find(u => u.id === o.id);
      if (r) html += `<span class="lbl-res st-${r.status.key}">${r.Tin.toFixed(1)} °C · +${r.dT.toFixed(1)} K</span>`;
    } else if (o.type === 'wall') {
      html = `${esc(o.name)} · ${fmt(o.height)} m · ${o.louver > 0 ? 'louver ' + o.louver + '%' : 'ทึบ'}`;
    } else html = `${esc(o.name)} · ${fmt(o.h)} m`;
    el.innerHTML = html;
  }

  refreshLabels() {
    for (const o of this.objects) {
      const g = this.meshes.get(o.id);
      if (g) this.#fillLabel(o, g.userData.label);
    }
  }

  #cduMesh(o) {
    const g = new THREE.Group();
    const sz = unitSize(o), mods = unitModules(o);
    const T = this.textures;
    const yb = o.elev || 0;
    if (yb > 0.01) {
      const pad = new THREE.Mesh(new THREE.BoxGeometry(sz.w + 0.1, yb, sz.d + 0.1),
        new THREE.MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.95 }));
      pad.position.y = yb / 2;
      pad.castShadow = pad.receiveShadow = true;
      g.add(pad);
    }
    const side = new THREE.MeshStandardMaterial({ map: T.coil, roughness: 0.7, metalness: 0.15 });
    const front = new THREE.MeshStandardMaterial({ map: T.front, roughness: 0.6, metalness: 0.1 });
    const top = new THREE.MeshStandardMaterial({ color: 0xe9ecef, roughness: 0.6 });
    const bottom = new THREE.MeshStandardMaterial({ color: 0x7c848c });
    const fanMat = new THREE.MeshStandardMaterial({ color: 0x23282e, roughness: 0.5 });
    const guardMat = new THREE.MeshStandardMaterial({ color: 0x8b939b, roughness: 0.4, metalness: 0.4, side: THREE.DoubleSide });
    for (const m of mods) {
      const w = m.x1 - m.x0;
      // ลำดับหน้าของ BoxGeometry: +x, −x, +y, −y, +z (หน้าเครื่อง), −z (หลัง)
      const body = new THREE.Mesh(new THREE.BoxGeometry(w, sz.h, sz.d), [side, side, top, bottom, front, side]);
      body.position.set((m.x0 + m.x1) / 2, yb + sz.h / 2, 0);
      body.castShadow = body.receiveShadow = true;
      g.add(body);
      for (let f = 0; f < m.fans; f++) {
        const fx = m.x0 + w * (f + 0.5) / m.fans;
        const disc = new THREE.Mesh(new THREE.CircleGeometry(0.33, 40), fanMat);
        disc.rotation.x = -Math.PI / 2;
        disc.position.set(fx, yb + sz.h + 0.006, 0);
        g.add(disc);
        for (const rr of [0.12, 0.22, 0.32]) {
          const ring = new THREE.Mesh(new THREE.RingGeometry(rr - 0.012, rr, 48), guardMat);
          ring.rotation.x = -Math.PI / 2;
          ring.position.set(fx, yb + sz.h + 0.012, 0);
          g.add(ring);
        }
        if (o.duct > 0) {
          const duct = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, o.duct, 32, 1, true),
            new THREE.MeshStandardMaterial({ color: 0xb8c0c8, roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide }));
          duct.position.set(fx, yb + sz.h + o.duct / 2, 0);
          duct.castShadow = true;
          g.add(duct);
        }
      }
    }
    // ลูกศรบอกด้านหน้าเครื่อง (ด้านบริการ) บนพื้น
    const arrow = new THREE.Mesh(arrowShape(0.28), new THREE.MeshBasicMaterial({ color: 0x4f5b66, transparent: true, opacity: 0.55 }));
    arrow.rotation.x = -Math.PI / 2;
    arrow.position.set(0, 0.012, sz.d / 2 + 0.3);
    g.add(arrow);
    g.position.set(o.x, 0, o.z);
    g.rotation.y = o.rot * Math.PI / 180;
    return g;
  }

  #wallMesh(o) {
    const g = new THREE.Group();
    const dx = o.x2 - o.x1, dz = o.z2 - o.z1, L = Math.max(0.01, Math.hypot(dx, dz));
    const louver = o.louver > 0;
    let mat;
    if (louver) {
      const tex = this.textures.louver.clone();
      tex.needsUpdate = true;
      tex.repeat.set(Math.max(1, L / 1.2), Math.max(1, o.height / 0.6));
      mat = new THREE.MeshStandardMaterial({
        map: tex, transparent: true, alphaTest: 0.05, roughness: 0.6, metalness: 0.3,
        side: THREE.DoubleSide, opacity: 0.95,
      });
    } else {
      mat = new THREE.MeshStandardMaterial({ color: 0xc9ced3, roughness: 0.9 });
    }
    const m = new THREE.Mesh(new THREE.BoxGeometry(L, o.height, Math.max(0.05, o.thick)), mat);
    m.castShadow = true; m.receiveShadow = true;
    m.position.y = (o.gap || 0) + o.height / 2;
    g.add(m);
    if (louver) {
      // เสาและคานกรอบ louver
      const frame = new THREE.MeshStandardMaterial({ color: 0x6f7982, roughness: 0.6, metalness: 0.3 });
      const nPost = Math.max(2, Math.round(L / 2.4) + 1);
      for (let p = 0; p < nPost; p++) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.06, o.height, 0.08), frame);
        post.position.set(-L / 2 + L * p / (nPost - 1), m.position.y, 0);
        g.add(post);
      }
      const capTop = new THREE.Mesh(new THREE.BoxGeometry(L, 0.05, 0.1), frame);
      capTop.position.y = (o.gap || 0) + o.height;
      g.add(capTop);
    }
    g.position.set((o.x1 + o.x2) / 2, 0, (o.z1 + o.z2) / 2);
    g.rotation.y = -Math.atan2(dz, dx);
    return g;
  }

  #buildingMesh(o) {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0xd4d8dc, roughness: 0.85 });
    const b = new THREE.Mesh(new THREE.BoxGeometry(o.w, o.h, o.d), mat);
    b.position.y = o.h / 2;
    b.castShadow = b.receiveShadow = true;
    g.add(b);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(b.geometry),
      new THREE.LineBasicMaterial({ color: 0x7d858d }));
    e.position.copy(b.position);
    e.raycast = () => {};
    g.add(e);
    g.position.set(o.x, 0, o.z);
    g.rotation.y = o.rot * Math.PI / 180;
    return g;
  }

  /* ───────── พื้น ไม้บรรทัด ทิศเหนือ ลม ───────── */

  #buildGround() {
    const d = this.dom;
    for (const c of [...this.gGround.children]) { this.gGround.remove(c); disposeGroup(c); }
    const { ox, oz, W, D, H } = d;
    // พื้นพร้อมเส้นกริด 1 ม. (วาดลง canvas)
    const ppm = Math.max(8, Math.min(48, Math.floor(4096 / Math.max(W, D))));
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(W * ppm); cv.height = Math.ceil(D * ppm);
    const x = cv.getContext('2d');
    x.fillStyle = '#e8ecef'; x.fillRect(0, 0, cv.width, cv.height);
    for (let m = Math.ceil(ox); m <= ox + W; m += 1) {
      const px = (m - ox) * ppm;
      x.strokeStyle = m % 5 === 0 ? 'rgba(80,95,110,0.45)' : 'rgba(80,95,110,0.18)';
      x.lineWidth = m % 5 === 0 ? 1.6 : 1;
      x.beginPath(); x.moveTo(px, 0); x.lineTo(px, cv.height); x.stroke();
    }
    for (let m = Math.ceil(oz); m <= oz + D; m += 1) {
      const pz = (m - oz) * ppm;
      x.strokeStyle = m % 5 === 0 ? 'rgba(80,95,110,0.45)' : 'rgba(80,95,110,0.18)';
      x.lineWidth = m % 5 === 0 ? 1.6 : 1;
      x.beginPath(); x.moveTo(0, pz); x.lineTo(cv.width, pz); x.stroke();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(ox + W / 2, 0, oz + D / 2);
    floor.receiveShadow = true;
    floor.userData.ground = true;
    this.gGround.add(floor);
    this.floor = floor;

    // ขอบโดเมนคำนวณ
    const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(W, H, D)),
      new THREE.LineBasicMaterial({ color: 0x8fb4cf, transparent: true, opacity: 0.35 }));
    box.position.set(ox + W / 2, H / 2, oz + D / 2);
    box.raycast = () => {};
    this.gGround.add(box);

    // ขอบโดเมนที่เป็นผนัง / สมมาตร แสดงเป็นพื้นผิวโปร่งแสง
    const bc = this.sceneData?.bc;
    if (bc) {
      const col = { wall: 0xa8b4c0, symmetry: 0x5fd39a };
      const faces = {
        xmin: [D, H, ox, H / 2, oz + D / 2, 0, Math.PI / 2], xmax: [D, H, ox + W, H / 2, oz + D / 2, 0, -Math.PI / 2],
        zmin: [W, H, ox + W / 2, H / 2, oz, 0, 0], zmax: [W, H, ox + W / 2, H / 2, oz + D, 0, Math.PI],
        ymax: [W, D, ox + W / 2, H, oz + D / 2, Math.PI / 2, 0],
      };
      for (const [f, [a, b, x0, y0, z0, rx, ry]] of Object.entries(faces)) {
        const t = bc[f]?.type;
        if (t !== 'wall' && t !== 'symmetry') continue;
        const m = new THREE.Mesh(new THREE.PlaneGeometry(a, b), new THREE.MeshBasicMaterial({
          color: col[t], transparent: true, opacity: t === 'wall' ? 0.16 : 0.12, side: THREE.DoubleSide, depthWrite: false,
        }));
        m.position.set(x0, y0, z0);
        m.rotation.set(rx, ry, 0, 'YXZ');
        m.raycast = () => {};
        m.renderOrder = 1;
        this.gGround.add(m);
        const e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), new THREE.LineBasicMaterial({ color: col[t], transparent: true, opacity: 0.7 }));
        e.position.copy(m.position); e.rotation.copy(m.rotation);
        e.raycast = () => {};
        this.gGround.add(e);
      }
    }

    // ไม้บรรทัด: ขอบด้านใต้ (แกน x) และขอบด้านตะวันออก (แกน z)
    const step = Math.max(W, D) > 40 ? 2 : 1;
    const tickMat = new THREE.LineBasicMaterial({ color: 0x9fb3c4 });
    const pts = [];
    for (let m = Math.ceil(ox / step) * step; m <= ox + W; m += step) {
      pts.push(m, 0.01, oz + D, m, 0.01, oz + D + 0.25);
      this.gGround.add(textSprite(String(m), m, 0.02, oz + D + 0.62));
    }
    for (let m = Math.ceil(oz / step) * step; m <= oz + D; m += step) {
      pts.push(ox + W, 0.01, m, ox + W + 0.25, 0.01, m);
      this.gGround.add(textSprite(String(m), ox + W + 0.62, 0.02, m));
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.gGround.add(new THREE.LineSegments(tg, tickMat));
    this.gGround.add(textSprite('x (ม.)', ox + W / 2, 0.02, oz + D + 1.3, 0.5, '#8fb4cf'));
    this.gGround.add(textSprite('z (ม.)', ox + W + 1.4, 0.02, oz + D / 2, 0.5, '#8fb4cf'));

    // ทิศเหนือ
    const n = new THREE.Mesh(arrowShape(0.9), new THREE.MeshBasicMaterial({ color: 0x3c5566 }));
    n.rotation.x = -Math.PI / 2;
    n.rotation.z = Math.PI;
    n.position.set(ox + 1.2, 0.015, oz + 1.6);
    this.gGround.add(n);
    this.gGround.add(textSprite('N', ox + 1.2, 0.02, oz + 0.5, 0.6, '#3c5566'));

    // พื้นรอบนอกโดเมน
    const outer = new THREE.Mesh(new THREE.PlaneGeometry(W + 400, D + 400),
      new THREE.MeshBasicMaterial({ color: 0x22303c }));
    outer.rotation.x = -Math.PI / 2;
    outer.position.set(ox + W / 2, -0.02, oz + D / 2);
    outer.raycast = () => {};
    this.gGround.add(outer);

    const R = Math.max(W, D);
    this.sun.position.set(ox + W * 0.2, R * 1.4, oz + D * 1.1);
    this.sun.target.position.set(ox + W / 2, 0, oz + D / 2);
    const sc = this.sun.shadow.camera;
    sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.near = 1; sc.far = R * 4;
    sc.updateProjectionMatrix();
  }

  #buildWindArrow() {
    if (this.windArrow) { this.gGround.remove(this.windArrow); disposeGroup(this.windArrow); this.windArrow = null; }
    const s = this.sceneData?.site;
    if (!s || !(s.windSpeed > 0.01) || !this.dom) return;
    const d = this.dom;
    const g = new THREE.Group();
    const a = new THREE.Mesh(arrowShape(1.6), new THREE.MeshBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.55 }));
    a.rotation.x = -Math.PI / 2;
    g.add(a);
    const lab = textSprite(`ลม ${s.windSpeed} m/s`, 0, 0.03, 1.5, 0.5, '#4fc3f7');
    g.add(lab);
    const r = s.windDir * Math.PI / 180;
    const vx = -Math.sin(r), vz = Math.cos(r);
    const R = Math.max(d.W, d.D) / 2 - 1.5;
    g.position.set(d.ox + d.W / 2 - vx * R, 0.02, d.oz + d.D / 2 - vz * R);
    g.rotation.y = Math.atan2(vx, vz);
    this.gGround.add(g);
    this.windArrow = g;
  }

  /* ───────── ระนาบหน้าตัด ───────── */

  #initSection() {
    const mat = new THREE.MeshBasicMaterial({ color: 0x3a8ee6, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false });
    this.secMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    this.secMesh.renderOrder = 2;
    this.secEdge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
      new THREE.LineBasicMaterial({ color: 0x6fb6ff }));
    this.secEdge.raycast = () => {};
    this.secKnob = new THREE.Mesh(new THREE.SphereGeometry(0.28, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0x6fb6ff, depthTest: false }));
    this.secKnob.renderOrder = 12;
    this.secGroup = new THREE.Group();
    this.secGroup.add(this.secMesh, this.secEdge, this.secKnob);
    this.scene3.add(this.secGroup);
  }

  setSection(axis, pos, show = true) {
    this.section = { axis, pos, show };
    this.#updateSectionGeometry();
    this.#updateSectionTexture();
  }

  #updateSectionGeometry() {
    const d = this.dom;
    if (!d) return;
    const { axis } = this.section;
    const lim = this.sectionLimits();
    const pos = Math.min(lim[1], Math.max(lim[0], this.section.pos));
    this.section.pos = pos;
    const m = this.secMesh, e = this.secEdge, g = this.secGroup;
    let w, h;
    g.rotation.set(0, 0, 0);
    if (axis === 'x') { w = d.D; h = d.H; g.position.set(pos, d.H / 2, d.oz + d.D / 2); g.rotation.y = -Math.PI / 2; }
    else if (axis === 'z') { w = d.W; h = d.H; g.position.set(d.ox + d.W / 2, d.H / 2, pos); }
    else { w = d.W; h = d.D; g.position.set(d.ox + d.W / 2, pos, d.oz + d.D / 2); g.rotation.x = Math.PI / 2; }
    m.scale.set(w, h, 1); e.scale.set(w, h, 1);
    // ปุ่มจับลาก: ขอบบนของระนาบตั้ง หรือมุมของระนาบนอน
    if (axis === 'y') this.secKnob.position.set(w / 2 + 0.4, -h / 2, 0);
    else this.secKnob.position.set(0, h / 2 + 0.4, 0);
    g.visible = this.section.show;
  }

  sectionLimits() {
    const d = this.dom;
    if (!d) return [0, 1];
    const e = d.h / 2;
    if (this.section.axis === 'x') return [d.ox + e, d.ox + d.W - e];
    if (this.section.axis === 'z') return [d.oz + e, d.oz + d.D - e];
    return [e, d.H - e];
  }

  /* ───────── ผลลัพธ์ ───────── */

  /** res = { mesh, fields, units, amb, range } — null เพื่อล้างผล */
  setResults(res) {
    this.results = res;
    this.#updateSectionTexture();
    this.#updateIso();
    if (!res) this.streakCount = 0;
    this.refreshLabels();
  }

  setDisplay(patch) {
    Object.assign(this.display, patch);
    this.#updateSectionTexture();
    if ('iso' in patch || 'isoDT' in patch) this.#updateIso();
    this.labelLayer.classList.toggle('hidden', !this.display.labels);
  }

  fieldRange() {
    const r = this.results;
    if (!r) return null;
    const f = this.display.field;
    if (f === 'T') return [r.amb, r.amb + r.dTmax];
    if (f === 'dT') return [0, r.dTmax];
    if (f === 'C') return [0, 50];
    return [0, Math.max(0.5, Math.min(6, r.vmax))];
  }

  fieldValue(c) {
    const r = this.results, F = r.fields, f = this.display.field;
    if (f === 'T') return F.T[c];
    if (f === 'dT') return F.T[c] - r.amb;
    if (f === 'C') return F.C[c] * 100;
    return Math.hypot(F.u[c], F.v[c], F.w[c]);
  }

  #updateSectionTexture() {
    const m = this.secMesh.material;
    const r = this.results;
    if (!r || !this.dom) {
      if (m.map) { m.map.dispose(); m.map = null; }
      m.color.set(0x3a8ee6); m.opacity = 0.32; m.needsUpdate = true;
      this.secEdge.material.color.set(0x6fb6ff);
      return;
    }
    const M = r.mesh, { nx, ny, nz, sy, sz, h, ox, oz } = M;
    const axis = this.section.axis, pos = this.section.pos;
    let cols, rows, idx;
    if (axis === 'x') {
      const i = clampI(Math.round((pos - ox) / h + 0.5), 1, nx);
      cols = nz; rows = ny; idx = (a, b) => i + (b + 1) * sy + (a + 1) * sz;
    } else if (axis === 'z') {
      const k = clampI(Math.round((pos - oz) / h + 0.5), 1, nz);
      cols = nx; rows = ny; idx = (a, b) => (a + 1) + (b + 1) * sy + k * sz;
    } else {
      const j = clampI(Math.round(pos / h + 0.5), 1, ny);
      cols = nx; rows = nz; idx = (a, b) => (a + 1) + j * sy + (b + 1) * sz;
    }
    const [lo, hi] = this.fieldRange();
    const span = Math.max(1e-6, hi - lo);
    const buf = new Uint8Array(cols * rows * 4);
    for (let b = 0; b < rows; b++)
      for (let a = 0; a < cols; a++) {
        const c = idx(a, b), o = (a + b * cols) * 4;
        if (M.type[c] === 1) { buf[o] = 128; buf[o + 1] = 136; buf[o + 2] = 146; buf[o + 3] = 255; continue; }
        const col = rgb((this.fieldValue(c) - lo) / span);
        buf[o] = col[0]; buf[o + 1] = col[1]; buf[o + 2] = col[2]; buf[o + 3] = 238;
      }
    const tex = new THREE.DataTexture(buf, cols, rows, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    if (m.map) m.map.dispose();
    m.map = tex; m.color.set(0xffffff); m.opacity = 0.93; m.needsUpdate = true;
    this.secEdge.material.color.set(0xffffff);
  }

  /** ค่าที่จุดใด ๆ ในโดเมน (trilinear) — ใช้กับหัววัดและอนุภาค */
  sample(arr, x, y, z) {
    const M = this.results.mesh;
    let fi = (x - M.ox) / M.h + 0.5, fj = y / M.h + 0.5, fk = (z - M.oz) / M.h + 0.5;
    fi = Math.min(M.NX - 1.001, Math.max(0, fi));
    fj = Math.min(M.NY - 1.001, Math.max(0, fj));
    fk = Math.min(M.NZ - 1.001, Math.max(0, fk));
    const i0 = fi | 0, j0 = fj | 0, k0 = fk | 0, s = fi - i0, t = fj - j0, r = fk - k0;
    const b = i0 + j0 * M.sy + k0 * M.sz, sy = M.sy, sz = M.sz;
    const l = (p, q) => p + s * (q - p);
    const a0 = l(arr[b], arr[b + 1]) + t * (l(arr[b + sy], arr[b + sy + 1]) - l(arr[b], arr[b + 1]));
    const a1 = l(arr[b + sz], arr[b + sz + 1]) + t * (l(arr[b + sz + sy], arr[b + sz + sy + 1]) - l(arr[b + sz], arr[b + sz + 1]));
    return a0 + r * (a1 - a0);
  }

  cellAt(x, y, z) {
    const M = this.results.mesh;
    const i = clampI(Math.floor((x - M.ox) / M.h) + 1, 0, M.NX - 1);
    const j = clampI(Math.floor(y / M.h) + 1, 0, M.NY - 1);
    const k = clampI(Math.floor((z - M.oz) / M.h) + 1, 0, M.NZ - 1);
    return i + j * M.sy + k * M.sz;
  }

  /* ───────── อนุภาคลม (เส้นสั้นตามทิศลม) ───────── */

  #initStreaks() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_STREAKS * 6), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_STREAKS * 6), 3));
    this.streakGeo = g;
    this.streaks = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false }));
    this.streaks.frustumCulled = false;
    this.streaks.renderOrder = 4;
    this.scene3.add(this.streaks);
    this.p = new Float32Array(MAX_STREAKS * 3);
    this.pLife = new Float32Array(MAX_STREAKS);
    this.streakCount = 0;
  }

  /** จุดปล่อยอนุภาค: เหนือพัดลมทุกตัว */
  #seeds() {
    if (this._seeds && this._seedsFor === this.objects) return this._seeds;
    const s = [];
    for (const o of this.objects) {
      if (o.type !== 'cdu') continue;
      const sz = unitSize(o), r = o.rot * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
      for (const m of unitModules(o)) for (let f = 0; f < m.fans; f++) {
        const lx = m.x0 + (m.x1 - m.x0) * (f + 0.5) / m.fans;
        s.push([o.x + lx * c, (o.elev || 0) + sz.h + (o.duct || 0) + 0.15, o.z - lx * sn]);
      }
    }
    this._seeds = s; this._seedsFor = this.objects;
    return s;
  }

  #respawn(i) {
    const d = this.dom, p = this.p, o = i * 3;
    const seeds = this.#seeds();
    if (seeds.length && Math.random() < 0.55) {
      const s = seeds[(Math.random() * seeds.length) | 0];
      const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * 0.32;
      p[o] = s[0] + Math.cos(a) * rr; p[o + 1] = s[1]; p[o + 2] = s[2] + Math.sin(a) * rr;
      this.pLife[i] = 3 + Math.random() * 7;
    } else {
      p[o] = d.ox + Math.random() * d.W; p[o + 1] = Math.random() * Math.min(d.H, 6); p[o + 2] = d.oz + Math.random() * d.D;
      this.pLife[i] = 1 + Math.random() * 4;
    }
  }

  #updateStreaks(dt) {
    const r = this.results;
    const show = !!r && this.display.particles;
    this.streaks.visible = show;
    if (!show) return;
    const d = this.dom, F = r.fields, M = r.mesh;
    const n = MAX_STREAKS;
    if (this.streakCount < n) { for (let i = this.streakCount; i < n; i++) this.#respawn(i); this.streakCount = n; }
    const pos = this.streakGeo.attributes.position.array, col = this.streakGeo.attributes.color.array;
    const p = this.p;
    const lo = r.amb, span = Math.max(0.5, r.dTmax);
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      let x = p[o], y = p[o + 1], z = p[o + 2];
      const u = this.sample(F.u, x, y, z), v = this.sample(F.v, x, y, z), w = this.sample(F.w, x, y, z);
      const sp = Math.hypot(u, v, w);
      x += u * dt; y += v * dt; z += w * dt;
      this.pLife[i] -= dt;
      const out = x < d.ox || x > d.ox + d.W || z < d.oz || z > d.oz + d.D || y < 0 || y > d.H;
      if (out || this.pLife[i] <= 0 || sp < 0.05 || M.type[this.cellAt(x, y, z)] === 1) { this.#respawn(i); continue; }
      p[o] = x; p[o + 1] = y; p[o + 2] = z;
      const L = Math.min(0.6, 0.12 + sp * 0.09) / Math.max(sp, 1e-3);
      const q = i * 6;
      pos[q] = x - u * L; pos[q + 1] = y - v * L; pos[q + 2] = z - w * L;
      pos[q + 3] = x; pos[q + 4] = y; pos[q + 5] = z;
      const t = this.sample(F.T, x, y, z);
      const cc = rgb((t - lo) / span);
      col[q] = cc[0] / 400; col[q + 1] = cc[1] / 400; col[q + 2] = cc[2] / 400;
      col[q + 3] = cc[0] / 255; col[q + 4] = cc[1] / 255; col[q + 5] = cc[2] / 255;
    }
    this.streakGeo.attributes.position.needsUpdate = true;
    this.streakGeo.attributes.color.needsUpdate = true;
  }

  /* ───────── ผิวลมร้อน (iso-surface ด้วย surface nets) ───────── */

  #initIso() {
    this.isoMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({
      color: 0xff7a3c, transparent: true, opacity: 0.33, side: THREE.DoubleSide, depthWrite: false, roughness: 0.6,
    }));
    this.isoMesh.renderOrder = 3;
    this.isoMesh.raycast = () => {};
    this.scene3.add(this.isoMesh);
  }

  #updateIso() {
    const r = this.results;
    this.isoMesh.visible = !!r && this.display.iso;
    if (!this.isoMesh.visible) return;
    const geo = surfaceNets(r.mesh, r.fields.T, r.amb + this.display.isoDT);
    this.isoMesh.geometry.dispose();
    this.isoMesh.geometry = geo;
  }

  /* ───────── ตัวจับลาก (handles) ───────── */

  #buildHandles() {
    for (const c of [...this.gHandles.children]) { this.gHandles.remove(c); disposeGroup(c); }
    const o = this.objects.find(q => q.id === this.selectedId);
    if (!o || o.type !== 'wall') return;
    for (const end of [1, 2]) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.22, 18, 12), new THREE.MeshBasicMaterial({ color: ACCENT, depthTest: false }));
      m.renderOrder = 12;
      m.position.set(o['x' + end], (o.gap || 0) + o.height + 0.3, o['z' + end]);
      m.userData.handle = { id: o.id, end };
      this.gHandles.add(m);
    }
  }

  /* ───────── การโต้ตอบ ───────── */

  setTool(tool) {
    this.tool = tool;
    this.draw = null;
    this.#clearPreview();
    this.renderer.domElement.style.cursor = tool === 'select' ? '' : 'crosshair';
  }

  cancelDraw() {
    const had = !!this.draw;
    this.draw = null;
    this.#clearPreview();
    return had;
  }

  #clearPreview() {
    for (const c of [...this.gPreview.children]) { this.gPreview.remove(c); disposeGroup(c); }
    if (this.dimLabel) this.dimLabel.style.display = 'none';
  }

  #pick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
    return this.ray;
  }

  #ground(e, y = 0) {
    const ray = this.#pick(e);
    const pt = new THREE.Vector3();
    return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), pt) ? pt : null;
  }

  #initInput() {
    const el = this.renderer.domElement;
    const snap = (v, e) => e.altKey ? Math.round(v * 100) / 100 : Math.round(v / SNAP) * SNAP;
    let drag = null, down = null;

    this.dimLabel = document.createElement('div');
    this.dimLabel.className = 'dimlabel';
    this.host.appendChild(this.dimLabel);

    // ใช้ capture เพื่อให้ตัดสินก่อน OrbitControls ว่าคลิกนี้เป็นการลากวัตถุหรือหมุนกล้อง
    this.host.addEventListener('pointerdown', (e) => {
      if (e.target !== el) return;
      down = { x: e.clientX, y: e.clientY };
      if (e.button !== 0) return;
      if (this.tool !== 'select') {
        e.stopPropagation();
        this.#toolClick(e, snap);
        return;
      }
      const ray = this.#pick(e);
      // 1) ตัวจับลากของผนัง / ระนาบหน้าตัด
      const hh = ray.intersectObjects([...this.gHandles.children, this.secGroup.visible ? this.secKnob : null].filter(Boolean), false);
      if (hh.length) {
        e.stopPropagation();
        const obj = hh[0].object;
        if (obj === this.secKnob) drag = { kind: 'section' };
        else {
          const hd = obj.userData.handle;
          drag = { kind: 'end', id: hd.id, end: hd.end, moved: false };
        }
        el.setPointerCapture(e.pointerId);
        return;
      }
      // 2) วัตถุ
      const hits = ray.intersectObjects(this.gObjects.children, true);
      if (hits.length) {
        const id = hits[0].object.userData.objId;
        if (id != null) {
          e.stopPropagation();
          this.cb.onSelect(id);
          const o = this.objects.find(q => q.id === id);
          const g = this.#ground(e);
          if (o && g) {
            const ref = o.type === 'wall' ? { x: o.x1, z: o.z1 } : { x: o.x, z: o.z };
            drag = { kind: 'move', id, off: { x: ref.x - g.x, z: ref.z - g.z }, start: { ...o }, moved: false };
            el.setPointerCapture(e.pointerId);
          }
        }
      }
    }, { capture: true });

    el.addEventListener('pointermove', (e) => {
      if (drag) { this.#dragMove(e, drag, snap); return; }
      if (this.tool !== 'select') { this.#toolHover(e, snap); return; }
      this.#probe(e);
    });

    const end = (e) => {
      if (drag) {
        const d = drag;
        drag = null;
        this.dimLabel.style.display = 'none';
        if (d.kind === 'section') this.cb.onSectionMoved?.(this.section.pos, true);
        else if (d.moved) this.cb.onObjectEdited(d.id);
        try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        return;
      }
      // คลิกพื้นที่ว่าง (ไม่ได้ลากหมุนกล้อง) → ยกเลิกการเลือก
      if (down && e.button === 0 && this.tool === 'select' && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) {
        const hits = this.#pick(e).intersectObjects(this.gObjects.children, true);
        if (!hits.length) this.cb.onSelect(null);
      }
      down = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', () => this.cb.onProbe?.(null));
    el.addEventListener('dblclick', () => { if (this.tool === 'wall') this.cancelDraw(); });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  #dragMove(e, d, snap) {
    if (d.kind === 'section') {
      const ax = this.section.axis;
      const n = ax === 'x' ? new THREE.Vector3(1, 0, 0) : ax === 'z' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
      const ray = this.#pick(e).ray;
      // ระนาบสำหรับลาก: มีแกน n อยู่ในระนาบ และหันเข้าหากล้องให้มากที่สุด
      const view = ray.direction.clone();
      const pn = view.clone().sub(n.clone().multiplyScalar(view.dot(n)));
      if (pn.lengthSq() < 1e-6) return;
      pn.normalize();
      const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(pn, this.secKnob.getWorldPosition(new THREE.Vector3()));
      const pt = new THREE.Vector3();
      if (!ray.intersectPlane(pl, pt)) return;
      const lim = this.sectionLimits();
      const v = Math.min(lim[1], Math.max(lim[0], Math.round(pt.dot(n) / 0.05) * 0.05));
      if (v !== this.section.pos) {
        this.section.pos = v;
        this.#updateSectionGeometry();
        this.#updateSectionTexture();
        this.cb.onSectionMoved?.(v, false);
      }
      return;
    }
    const o = this.objects.find(q => q.id === d.id);
    const g = this.#ground(e);
    if (!o || !g) return;
    if (!d.moved) { this.cb.onBeginEdit?.(); d.moved = true; }
    if (d.kind === 'end') {
      let x = snap(g.x, e), z = snap(g.z, e);
      const ox2 = o[d.end === 1 ? 'x2' : 'x1'], oz2 = o[d.end === 1 ? 'z2' : 'z1'];
      if (e.shiftKey) { if (Math.abs(x - ox2) > Math.abs(z - oz2)) z = oz2; else x = ox2; }
      o['x' + d.end] = x; o['z' + d.end] = z;
      this.#showDim(e, `${fmt(Math.hypot(o.x2 - o.x1, o.z2 - o.z1))} m`);
    } else if (o.type === 'wall') {
      const nx = snap(g.x + d.off.x, e), nz = snap(g.z + d.off.z, e);
      const dx = nx - o.x1, dz = nz - o.z1;
      o.x1 += dx; o.x2 += dx; o.z1 += dz; o.z2 += dz;
    } else {
      o.x = snap(g.x + d.off.x, e); o.z = snap(g.z + d.off.z, e);
      this.#showDim(e, `x ${fmt(o.x)} · z ${fmt(o.z)}`);
    }
    this.refreshObject(o);
    this.cb.onObjectMoving?.(o);
  }

  #showDim(e, text) {
    const r = this.host.getBoundingClientRect();
    const l = this.dimLabel;
    l.textContent = text;
    l.style.display = 'block';
    l.style.left = (e.clientX - r.left + 14) + 'px';
    l.style.top = (e.clientY - r.top + 14) + 'px';
  }

  #toolHover(e, snap) {
    const g = this.#ground(e);
    this.#clearPreview();
    if (!g) return;
    const x = snap(g.x, e), z = snap(g.z, e);
    const ghost = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.35, depthWrite: false });
    const line = new THREE.LineBasicMaterial({ color: ACCENT });
    if (this.tool === 'cdu') {
      const fp = cduFootprint({ model: this.cb.newCduModel?.() || 'RXQ16BY1S', rot: 0 });
      const m = new THREE.Mesh(new THREE.BoxGeometry(fp.sx, fp.h, fp.sz), ghost);
      m.position.set(x, fp.h / 2 + 0.2, z);
      this.gPreview.add(m);
      this.#showDim(e, `x ${fmt(x)} · z ${fmt(z)}`);
    } else if (this.tool === 'wall') {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 8), ghost);
      dot.position.set(x, 0.1, z);
      this.gPreview.add(dot);
      if (this.draw) {
        let ex = x, ez = z;
        if (e.shiftKey) { if (Math.abs(ex - this.draw.x) > Math.abs(ez - this.draw.z)) ez = this.draw.z; else ex = this.draw.x; }
        const L = Math.hypot(ex - this.draw.x, ez - this.draw.z);
        const hgt = this.cb.newWallHeight?.() || 2.4;
        const m = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.01, L), hgt, 0.15), ghost);
        m.position.set((ex + this.draw.x) / 2, hgt / 2, (ez + this.draw.z) / 2);
        m.rotation.y = -Math.atan2(ez - this.draw.z, ex - this.draw.x);
        this.gPreview.add(m);
        this.#showDim(e, `${fmt(L)} m`);
      } else this.#showDim(e, `x ${fmt(x)} · z ${fmt(z)}`);
    } else if (this.tool === 'building') {
      if (this.draw) {
        const w = Math.abs(x - this.draw.x), dd = Math.abs(z - this.draw.z);
        const hgt = 4.5;
        const m = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.01, w), hgt, Math.max(0.01, dd)), ghost);
        m.position.set((x + this.draw.x) / 2, hgt / 2, (z + this.draw.z) / 2);
        this.gPreview.add(m);
        const pts = [this.draw.x, 0.02, this.draw.z, x, 0.02, this.draw.z, x, 0.02, z, this.draw.x, 0.02, z, this.draw.x, 0.02, this.draw.z];
        const lg = new THREE.BufferGeometry();
        lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        this.gPreview.add(new THREE.Line(lg, line));
        this.#showDim(e, `${fmt(w)} × ${fmt(dd)} m`);
      } else this.#showDim(e, `x ${fmt(x)} · z ${fmt(z)}`);
    }
  }

  #toolClick(e, snap) {
    const g = this.#ground(e);
    if (!g) return;
    let x = snap(g.x, e), z = snap(g.z, e);
    if (this.tool === 'cdu') {
      this.cb.onCreate('cdu', { x, z });
    } else if (this.tool === 'wall') {
      if (!this.draw) { this.draw = { x, z, sx: x, sz: z, n: 0 }; return; }
      if (e.shiftKey) { if (Math.abs(x - this.draw.x) > Math.abs(z - this.draw.z)) z = this.draw.z; else x = this.draw.x; }
      if (Math.hypot(x - this.draw.x, z - this.draw.z) < 0.2) return;
      this.cb.onCreate('wall', { x1: this.draw.x, z1: this.draw.z, x2: x, z2: z });
      const closed = this.draw.n >= 1 && Math.hypot(x - this.draw.sx, z - this.draw.sz) < 0.25;
      if (closed) { this.draw = null; this.#clearPreview(); }
      else this.draw = { ...this.draw, x, z, n: this.draw.n + 1 };
    } else if (this.tool === 'building') {
      if (!this.draw) { this.draw = { x, z }; return; }
      const w = Math.abs(x - this.draw.x), d = Math.abs(z - this.draw.z);
      if (w < 0.3 || d < 0.3) return;
      this.cb.onCreate('building', { x: (x + this.draw.x) / 2, z: (z + this.draw.z) / 2, w, d });
      this.draw = null;
      this.#clearPreview();
    }
  }

  #probe(e) {
    if (!this.results || !this.secGroup.visible) { this.cb.onProbe?.(null); return; }
    const hit = this.#pick(e).intersectObject(this.secMesh, false)[0];
    if (!hit) { this.cb.onProbe?.(null); return; }
    const p = hit.point, F = this.results.fields;
    if (this.results.mesh.type[this.cellAt(p.x, p.y, p.z)] === 1) { this.cb.onProbe?.({ p, solid: true }); return; }
    this.cb.onProbe?.({
      p, T: this.sample(F.T, p.x, p.y, p.z), C: this.sample(F.C, p.x, p.y, p.z),
      V: Math.hypot(this.sample(F.u, p.x, p.y, p.z), this.sample(F.v, p.x, p.y, p.z), this.sample(F.w, p.x, p.y, p.z)),
    });
  }

  /* ───────── วาดแต่ละเฟรม ───────── */

  #frame(dt) {
    this.controls.update();
    this.#updateStreaks(dt);
    // ปุ่มระนาบหน้าตัดมีขนาดคงที่บนจอ
    const k = this.camera.isOrthographicCamera ? (this.ortho.top - this.ortho.bottom) / this.ortho.zoom / 40
      : this.camera.position.distanceTo(this.secKnob.getWorldPosition(new THREE.Vector3())) / 45;
    this.secKnob.scale.setScalar(Math.max(0.4, k));
    this.renderer.render(this.scene3, this.camera);
    this.#placeLabels();
  }

  #placeLabels() {
    if (!this.display.labels) return;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    const v = new THREE.Vector3();
    for (const g of this.meshes.values()) {
      const el = g.userData.label;
      if (!el) continue;
      v.copy(g.userData.anchor).project(this.camera);
      if (v.z > 1 || v.x < -1.2 || v.x > 1.2 || v.y < -1.2 || v.y > 1.2) { el.style.display = 'none'; continue; }
      el.style.display = '';
      el.style.transform = `translate(-50%,-100%) translate(${(v.x * 0.5 + 0.5) * w}px,${(-v.y * 0.5 + 0.5) * h}px)`;
      el.classList.toggle('sel', g.userData.objId === this.selectedId);
    }
  }

  /** ภาพหน้าจอ (PNG data URL) สำหรับรายงาน */
  snapshot() {
    this.renderer.render(this.scene3, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}

/* ───────── เครื่องมือช่วย ───────── */

function clampI(v, a, b) { return v < a ? a : v > b ? b : v; }
function fmt(v) { return (Math.round(v * 100) / 100).toString(); }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function disposeGroup(g) {
  g.traverse(o => {
    o.geometry?.dispose?.();
    const m = o.material;
    if (Array.isArray(m)) m.forEach(x => x.dispose()); else m?.dispose?.();
  });
}

function arrowShape(s) {
  const sh = new THREE.Shape();
  sh.moveTo(0, s * 0.6); sh.lineTo(s * 0.45, 0); sh.lineTo(s * 0.16, 0); sh.lineTo(s * 0.16, -s * 0.6);
  sh.lineTo(-s * 0.16, -s * 0.6); sh.lineTo(-s * 0.16, 0); sh.lineTo(-s * 0.45, 0); sh.closePath();
  const g = new THREE.ShapeGeometry(sh);
  g.rotateZ(Math.PI);   // ปลายลูกศรชี้ไปทาง +z เมื่อวางราบ (rotation.x = −π/2)
  return g;
}

function textSprite(text, x, y, z, size = 0.36, color = '#b7c7d4') {
  const cv = document.createElement('canvas');
  const fs = 48;
  const ctx = cv.getContext('2d');
  ctx.font = `600 ${fs}px "IBM Plex Sans Thai", "Noto Sans Thai", sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + 8;
  cv.width = w; cv.height = fs + 12;
  ctx.font = `600 ${fs}px "IBM Plex Sans Thai", "Noto Sans Thai", sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, cv.height / 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size * w / cv.height, size), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, y, z);
  m.raycast = () => {};
  return m;
}

function makeTextures() {
  const mk = (w, h, draw) => {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    draw(cv.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  };
  // ด้านคอยล์: ครีบแนวตั้งถี่ ๆ ใต้แผงด้านบน
  const coil = mk(256, 256, (x, w, h) => {
    x.fillStyle = '#e6e9ec'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#9ea7af'; x.fillRect(10, 22, w - 20, h - 40);
    x.strokeStyle = 'rgba(60,68,76,0.55)'; x.lineWidth = 1;
    for (let i = 12; i < w - 10; i += 4) { x.beginPath(); x.moveTo(i, 22); x.lineTo(i, h - 18); x.stroke(); }
    x.strokeStyle = 'rgba(40,46,52,0.5)'; x.lineWidth = 2;
    for (let j = 60; j < h - 20; j += 58) { x.beginPath(); x.moveTo(10, j); x.lineTo(w - 10, j); x.stroke(); }
  });
  // ด้านหน้า: แผงบริการ
  const front = mk(256, 256, (x, w, h) => {
    x.fillStyle = '#eceff1'; x.fillRect(0, 0, w, h);
    x.strokeStyle = 'rgba(90,100,110,0.55)'; x.lineWidth = 2;
    x.strokeRect(8, 8, w - 16, h * 0.55); x.strokeRect(8, h * 0.6, w - 16, h * 0.36);
    x.fillStyle = 'rgba(90,100,110,0.35)';
    for (let j = h * 0.66; j < h * 0.93; j += 8) x.fillRect(20, j, w - 40, 3);
    x.fillStyle = '#3d8fd1'; x.fillRect(16, 16, 40, 8);
  });
  // louver: ใบเกล็ดแนวนอน ช่องว่างโปร่ง
  const louver = mk(128, 128, (x, w, h) => {
    x.clearRect(0, 0, w, h);
    for (let j = 0; j < h; j += 16) {
      const g = x.createLinearGradient(0, j, 0, j + 10);
      g.addColorStop(0, '#c3cad1'); g.addColorStop(1, '#79848f');
      x.fillStyle = g; x.fillRect(0, j, w, 10);
    }
  });
  return { coil, front, louver };
}

/**
 * Surface nets — สร้างผิวที่ค่า field = iso จากกริดค่ากลางเซลล์
 * เซลล์ทึบถือว่าต่ำกว่า iso เพื่อให้ผิวปิดรอบตัวเครื่อง
 */
function surfaceNets(M, field, iso) {
  const { nx, ny, nz, sy, sz, h, ox, oz, type } = M;
  const val = c => (type[c] === 1 ? iso - 1 : field[c]) - iso;
  const vid = new Int32Array(M.N).fill(-1);
  const verts = [];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const cornerOff = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const vals = new Float32Array(8);
  // จุดยอดหนึ่งจุดต่อ "ลูกบาศก์" ระหว่างจุดกึ่งกลางเซลล์ (i..i+1, j..j+1, k..k+1)
  for (let k = 1; k < nz; k++)
    for (let j = 1; j < ny; j++)
      for (let i = 1; i < nx; i++) {
        const c = i + j * sy + k * sz;
        let pos = 0, neg = 0;
        for (let q = 0; q < 8; q++) {
          const o = cornerOff[q];
          const v = val(c + o[0] + o[1] * sy + o[2] * sz);
          vals[q] = v;
          if (v > 0) pos++; else neg++;
        }
        if (!pos || !neg) continue;
        let ax = 0, ay = 0, az = 0, n = 0;
        for (const [a, b] of edges) {
          const va = vals[a], vb = vals[b];
          if ((va > 0) === (vb > 0)) continue;
          const t = va / (va - vb);
          const A = cornerOff[a], B = cornerOff[b];
          ax += A[0] + t * (B[0] - A[0]); ay += A[1] + t * (B[1] - A[1]); az += A[2] + t * (B[2] - A[2]);
          n++;
        }
        vid[c] = verts.length / 3;
        verts.push(ox + (i - 0.5 + ax / n) * h, (j - 0.5 + ay / n) * h, oz + (k - 0.5 + az / n) * h);
      }
  // หน้าสี่เหลี่ยมต่อขอบกริดที่ค่าเปลี่ยนเครื่องหมาย
  const idx = [];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) idx.push(a, c, b, a, d, c); else idx.push(a, b, c, a, c, d);
  };
  for (let k = 1; k <= nz; k++)
    for (let j = 1; j <= ny; j++)
      for (let i = 1; i <= nx; i++) {
        const c = i + j * sy + k * sz;
        const v0 = val(c) > 0;
        if (i < nx && j > 1 && k > 1 && v0 !== (val(c + 1) > 0))
          quad(vid[c - sy - sz], vid[c - sz], vid[c], vid[c - sy], v0);
        if (j < ny && i > 1 && k > 1 && v0 !== (val(c + sy) > 0))
          quad(vid[c - 1 - sz], vid[c - 1], vid[c], vid[c - sz], v0);
        if (k < nz && i > 1 && j > 1 && v0 !== (val(c + sz) > 0))
          quad(vid[c - 1 - sy], vid[c - sy], vid[c], vid[c - 1], v0);
      }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
