// Pixel Life: one renderer, one VRM, a living alien-dusk world, poses + gestures.
// Replaces scene-enhancements.js and the old inline VRM module.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';

const MINT = 0xb9ffe1, PINK = 0xff6fae, TAU = Math.PI * 2;
const rnd = (a, b) => a + Math.random() * (b - a);
const damp = THREE.MathUtils.damp;

/* ---------- renderer / scene ---------- */
const host = document.getElementById('canvas-container');
host.querySelectorAll('canvas').forEach(c => c.remove());
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.domElement.style.cssText = 'position:absolute;inset:0';
host.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x040b11);
scene.fog = new THREE.FogExp2(0x07171b, 0.02);
const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.1, 300);
const camBase = new THREE.Vector3(0, 1.4, 5.2);
const look = new THREE.Vector3(0, 1.15, 0);

scene.add(new THREE.HemisphereLight(0xc7fff0, 0x061316, 1.5));
const key = new THREE.DirectionalLight(0xbaffea, 2.6);
key.position.set(-3, 5, 4);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
Object.assign(key.shadow.camera, { left: -4, right: 4, top: 4, bottom: -2 });
scene.add(key);
const rim = new THREE.PointLight(PINK, 25, 12, 2);
rim.position.set(2.5, 2.2, -2.5);
scene.add(rim);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.6, 0.82);
composer.addPass(bloom);
composer.addPass(new OutputPass());

/* ---------- world ---------- */
function glowSprite() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(.35, 'rgba(255,255,255,.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
const sprite = glowSprite();
const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };

// terrain, flattened around the avatar so feet never clip
const tg = new THREE.PlaneGeometry(120, 120, 160, 160); tg.rotateX(-Math.PI / 2);
const tp = tg.attributes.position;
for (let i = 0; i < tp.count; i++) {
  const x = tp.getX(i), z = tp.getZ(i), k = THREE.MathUtils.smoothstep(Math.hypot(x, z), 2.5, 9);
  tp.setY(i, (Math.sin(x * .11 + Math.sin(z * .06)) * .5 + Math.cos(z * .16) * .25 + Math.sin(x * .5 + z * .35) * .04) * k);
}
tg.computeVertexNormals();
const ground = new THREE.Mesh(tg, new THREE.MeshStandardMaterial({ color: 0x143a38, roughness: .95 }));
ground.position.y = -.02; ground.receiveShadow = true; scene.add(ground);

const pad = new THREE.Mesh(new THREE.RingGeometry(1.05, 1.1, 96).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: MINT, transparent: true, opacity: .7 }));
pad.position.y = .01; scene.add(pad);

const rockMat = new THREE.MeshStandardMaterial({ color: 0x28514b, roughness: .96 });
for (let i = 0; i < 26; i++) {
  const r = new THREE.Mesh(new THREE.DodecahedronGeometry(rnd(.2, .8), 1), rockMat);
  const side = i % 2 ? -1 : 1;
  r.position.set(side * rnd(3.5, 13), 0, rnd(-20, -3)); r.scale.y = rnd(.45, 1.1); r.rotation.set(rnd(0, 3), rnd(0, 3), 0);
  r.castShadow = r.receiveShadow = true; scene.add(r);
}
const mesaMat = new THREE.MeshStandardMaterial({ color: 0x0f2a2b, roughness: 1 });
for (let i = 0; i < 10; i++) {
  const m = new THREE.Mesh(new THREE.ConeGeometry(rnd(2, 4.5), rnd(3, 6), 7), mesaMat);
  m.position.set((i - 4.5) * 7 + rnd(-2, 2), 1, rnd(-48, -34)); m.scale.x = rnd(1.4, 2.4); scene.add(m);
}

// sky: stars, ringed planet, aurora, shooting stars
const SN = 1200, sp = new Float32Array(SN * 3);
for (let i = 0; i < SN; i++) {
  const th = rnd(0, TAU), ph = Math.acos(rnd(.05, 1)), r = 140;
  sp.set([r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph), -r * Math.sin(ph) * Math.abs(Math.sin(th))], i * 3);
}
const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
const stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xd7fff0, size: 1.1, sizeAttenuation: false, transparent: true, fog: false }));
scene.add(stars);

const planet = new THREE.Group();
planet.add(new THREE.Mesh(new THREE.SphereGeometry(7, 48, 32), new THREE.MeshStandardMaterial({ color: 0x6b3f7a, emissive: 0x2a1030, emissiveIntensity: .7, roughness: .9, fog: false })));
const pr = new THREE.Mesh(new THREE.RingGeometry(9, 13, 96), new THREE.MeshBasicMaterial({ color: 0xd9a3c9, transparent: true, opacity: .35, side: THREE.DoubleSide, fog: false }));
pr.rotation.x = -1.25; planet.add(pr);
planet.position.set(-34, 22, -82); scene.add(planet);

const aur = new THREE.Mesh(new THREE.PlaneGeometry(190, 46), new THREE.ShaderMaterial({
  ...additive, side: THREE.DoubleSide, fog: false, uniforms: { t: { value: 0 } },
  vertexShader: 'varying vec2 v;void main(){v=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader: 'varying vec2 v;uniform float t;void main(){float w=sin(v.x*9.+t*.35+sin(v.y*4.+t*.25)*2.2)*.5+.5;float w2=sin(v.x*17.-t*.2+v.y*3.)*.5+.5;float b=pow(w,2.2)*(.6+.4*w2);float f=smoothstep(0.,.35,v.y)*(1.-smoothstep(.55,1.,v.y));vec3 c=mix(vec3(.45,1.,.82),vec3(1.,.42,.68),smoothstep(.2,.9,v.y+.25*sin(v.x*3.+t*.1)));gl_FragColor=vec4(c,b*f*.55);}'
}));
aur.position.set(0, 30, -88); scene.add(aur);

const shoot = new THREE.Mesh(new THREE.PlaneGeometry(6, .04), new THREE.MeshBasicMaterial({ color: 0xffffff, opacity: 0, fog: false, ...additive }));
shoot.rotation.z = -.5; scene.add(shoot);
let shootT = -1, nextShoot = 3;

// motion objects around the avatar
const crystalMats = [MINT, PINK].map(c => new THREE.MeshStandardMaterial({ color: 0x1b3a36, emissive: c, emissiveIntensity: 1.4, roughness: .25, metalness: .2, flatShading: true }));
const crystals = [];
for (let i = 0; i < 18; i++) {
  const m = new THREE.Mesh(new THREE.OctahedronGeometry(rnd(.08, .22), 0), crystalMats[i % 2]);
  m.scale.y = rnd(1.4, 2.2); scene.add(m);
  crystals.push({ m, a: rnd(0, TAU), r: rnd(2.2, 5.5), y: rnd(.5, 3.4), ph: rnd(0, TAU), sp: rnd(.2, .5) * (Math.random() < .5 ? -1 : 1) });
}
const mkRing = (R, c, rx, ry) => {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.TorusGeometry(R, .008, 6, 220), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: .55 })));
  const orb = new THREE.Mesh(new THREE.SphereGeometry(.05, 12, 12), new THREE.MeshBasicMaterial({ color: 0xffffff })); g.add(orb);
  g.rotation.set(rx, ry, 0); g.position.y = 1.0; scene.add(g); return { g, orb, R };
};
const rings = [mkRing(1.5, MINT, 1.2, 0), mkRing(1.9, PINK, 1.9, .5)];

const FN = 260, fp = new Float32Array(FN * 3), fv = new Float32Array(FN);
for (let i = 0; i < FN; i++) { fp.set([rnd(-9, 9), rnd(0, 5), rnd(-14, 3)], i * 3); fv[i] = rnd(.08, .3); }
const fg = new THREE.BufferGeometry(); fg.setAttribute('position', new THREE.BufferAttribute(fp, 3));
scene.add(new THREE.Points(fg, new THREE.PointsMaterial({ size: .09, map: sprite, color: MINT, opacity: .8, ...additive })));

const thinkOrbs = new THREE.Group();
for (let i = 0; i < 3; i++) thinkOrbs.add(new THREE.Sprite(new THREE.SpriteMaterial({ map: sprite, color: PINK, opacity: 0, ...additive })));
thinkOrbs.children.forEach(s => s.scale.setScalar(.18));
scene.add(thinkOrbs);

/* ---------- avatar ---------- */
let vrm = null, H = 1.7, baseY = 0;
const loader = new GLTFLoader();
loader.register(p => new VRMLoaderPlugin(p));
loader.load('/static/CoolAlien.vrm', gltf => {
  vrm = gltf.userData.vrm;
  vrm.scene.traverse(o => { o.frustumCulled = false; if (o.isMesh) { o.castShadow = true; } });
  scene.add(vrm.scene);
  const b1 = new THREE.Box3().setFromObject(vrm.scene);
  vrm.scene.scale.setScalar(H / (b1.max.y - b1.min.y));
  vrm.scene.rotation.y = Math.PI;               // VRM 0.x faces -Z
  vrm.scene.updateMatrixWorld(true);
  baseY = -new THREE.Box3().setFromObject(vrm.scene).min.y;
  vrm.scene.position.y = baseY;
  setTimeout(() => gesture('wave'), 700);       // greets you on load
}, undefined, e => console.error('VRM load failed', e));
const bone = n => vrm?.humanoid?.getNormalizedBoneNode(n);

/* ---------- audio level + state (read from the existing UI) ---------- */
let analyser = null, adata = null, lvl = 0, speaking = false, statusMode = 'idle';
window.animateSpeaking = v => { speaking = v; };
window.pixelTap = (src, ctx) => { try { analyser = ctx.createAnalyser(); analyser.fftSize = 512; adata = new Uint8Array(512); src.connect(analyser); } catch (_) {} };
const statusEl = document.getElementById('status');
const readStatus = () => {
  const s = (statusEl?.textContent || '').toUpperCase();
  return /THINK|PROCESS|TRANSCRIB/.test(s) ? 'thinking' : /LISTEN|HEARING/.test(s) ? 'listening' : 'idle';
};
if (statusEl) new MutationObserver(() => { statusMode = readStatus(); }).observe(statusEl, { childList: true, characterData: true, subtree: true });

/* ---------- gestures ---------- */
// Rotations are radians in the VRM 0.x frame the original project used:
// model faces -Z, left arm at -X, so +z lowers the LEFT arm and -z lowers the RIGHT arm.
// Forward swing: left arm y<0, right arm y>0. Head: +x looks up, +y turns toward screen right.
const emo = { i: 0, o: 0 };
let bounce = 0;
const G = {
  wave:      { dur: 2.8, f: (e, s, a) => { a('rightUpperArm', 0, .25 * e, 2.2 * e); a('rightLowerArm', 0, .5 * e, .55 * e * Math.sin(s * 11)); a('head', 0, 0, .07 * e); emo.i = .3 * e; } },
  shrug:     { dur: 1.7, f: (e, s, a) => { a('leftShoulder', 0, 0, -.28 * e); a('rightShoulder', 0, 0, .28 * e); a('leftUpperArm', 0, 0, -.15 * e); a('rightUpperArm', 0, 0, .15 * e); a('head', 0, 0, .12 * e); } },
  celebrate: { dur: 2.6, f: (e, s, a) => { a('leftUpperArm', 0, 0, -2.1 * e); a('rightUpperArm', 0, 0, 2.1 * e); a('leftLowerArm', 0, 0, -.35 * e * Math.sin(s * 9)); a('rightLowerArm', 0, 0, .35 * e * Math.sin(s * 9)); a('head', .1 * e, 0, 0); bounce = Math.abs(Math.sin(s * 6)) * .07 * e; emo.i = .4 * e; } },
  bow:       { dur: 2.2, f: (e, s, a) => { a('chest', -.3 * e, 0, 0); a('spine', -.18 * e, 0, 0); a('head', -.25 * e, 0, 0); a('leftUpperArm', 0, -.2 * e, 0); a('rightUpperArm', 0, .2 * e, 0); } },
  nod:       { dur: 1.2, f: (e, s, a) => a('head', -.2 * Math.sin(s * 11) * (1 - s / 1.2), 0, 0) },
  shake:     { dur: 1.2, f: (e, s, a) => a('head', 0, .3 * Math.sin(s * 11) * (1 - s / 1.2), 0) },
  surprise:  { dur: 1.5, f: (e, s, a) => { a('head', .12 * e, 0, 0); a('chest', .07 * e, 0, 0); a('leftUpperArm', 0, 0, -.28 * e); a('rightUpperArm', 0, 0, .28 * e); emo.o = .6 * e; } },
};
let cur = null, lastTrig = 0;
function gesture(name) { if (G[name]) cur = { g: G[name], s: 0 }; }
window.pixel = { gesture, list: Object.keys(G) };

const RX = [[/\b(hi|hello|hey|good (morning|evening)|bye|goodbye|see you)\b/i, 'wave'], [/\b(thanks|thank you)\b/i, 'bow'],
  [/\b(haha|lol|funny|joke)\b/i, 'celebrate'], [/\b(wow|whoa|surpris|amazing)/i, 'surprise'], [/\b(yes|yeah|sure|exactly)\b/i, 'nod'],
  [/\b(nope|nah)\b/i, 'shake'], [/\b(maybe|not sure|don't know|no idea)/i, 'shrug']];
function react(text) {
  if (performance.now() - lastTrig < 2500) return false;
  for (const [r, g] of RX) if (r.test(text)) { gesture(g); lastTrig = performance.now(); return true; }
  return false;
}
let rbuf = '';
window.pixelUser = text => { rbuf = ''; react(text); };
window.pixelToken = d => { rbuf = (rbuf + d).slice(-60); if (react(rbuf)) rbuf = ''; };

document.querySelectorAll('.emote').forEach(b => b.addEventListener('click', () => gesture(b.dataset.gesture)));
addEventListener('keydown', e => {
  if (/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
  const n = +e.key; if (n >= 1 && n <= 7) gesture(Object.keys(G)[n - 1]);
});
const ptr = { x: 0, y: 0, sx: 0, sy: 0 };
addEventListener('pointermove', e => { ptr.x = (e.clientX / innerWidth - .5) * 2; ptr.y = -(e.clientY / innerHeight - .5) * 2; });
renderer.domElement.addEventListener('pointerdown', () => gesture(['wave', 'shrug', 'celebrate', 'surprise', 'nod'][Math.floor(Math.random() * 5)]));

/* ---------- main loop ---------- */
const V = ['a', 'e', 'i', 'o', 'u'], vw = { a: 0, e: 0, i: 0, o: 0, u: 0 };
const W = { listening: 0, thinking: 0, speaking: 0 };
let vi = 0, vt = 0, blinkT = rnd(2, 4), blinkP = -1;
const clock = new THREE.Clock();

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), .05), t = clock.elapsedTime;
  const mode = speaking ? 'speaking' : statusMode;

  // voice level
  let raw = 0;
  if (analyser) { analyser.getByteTimeDomainData(adata); let s = 0; for (const v of adata) { const x = (v - 128) / 128; s += x * x; } raw = Math.min(1, Math.sqrt(s / adata.length) * 5); }
  else if (speaking) raw = .35 + .3 * Math.abs(Math.sin(t * 9));
  lvl = damp(lvl, raw, 18, dt);
  for (const k in W) W[k] = damp(W[k], mode === k ? 1 : 0, 5, dt);
  ptr.sx = damp(ptr.sx, ptr.x, 4, dt); ptr.sy = damp(ptr.sy, ptr.y, 4, dt);

  // world motion
  aur.material.uniforms.t.value = t;
  stars.material.opacity = .75 + Math.sin(t * 1.7) * .15;
  planet.rotation.y = t * .02;
  crystals.forEach(c => {
    c.a += c.sp * dt * .3;
    let x = Math.cos(c.a) * c.r, z = Math.sin(c.a) * c.r * .7 - .5;
    if (z > 0 && Math.abs(x) < 1.4) z = -z;          // keep the face clear
    c.m.position.set(x, c.y + Math.sin(t * .8 + c.ph) * .15, z);
    c.m.rotation.y += dt * .8; c.m.rotation.x = Math.sin(t * .5 + c.ph) * .3;
  });
  rings.forEach((r, i) => {
    r.g.rotation.z += dt * (.15 + i * .1); r.g.scale.setScalar(1 + lvl * .06);
    const a = t * (.9 + i * .4); r.orb.position.set(Math.cos(a) * r.R, Math.sin(a) * r.R, 0);
  });
  pad.scale.setScalar(1 + lvl * .12);
  const p = fg.attributes.position.array;
  for (let i = 0; i < FN; i++) { p[i * 3 + 1] += fv[i] * dt; p[i * 3] += Math.sin(t * .6 + i) * dt * .12; if (p[i * 3 + 1] > 5.2) p[i * 3 + 1] = 0; }
  fg.attributes.position.needsUpdate = true;
  nextShoot -= dt;
  if (nextShoot < 0 && shootT < 0) { shootT = 0; shoot.position.set(rnd(-30, 10), rnd(18, 32), -70); nextShoot = rnd(6, 12); }
  if (shootT >= 0) {
    shootT += dt; const u = shootT / 1.1; shoot.position.x += dt * 40; shoot.position.y -= dt * 22;
    shoot.material.opacity = Math.sin(Math.min(u, 1) * Math.PI); if (u >= 1) { shootT = -1; shoot.material.opacity = 0; }
  }
  thinkOrbs.children.forEach((s, i) => { const a = t * 2.2 + i * TAU / 3; s.position.set(Math.cos(a) * .28, H + .14 + Math.sin(a * 1.3) * .03, Math.sin(a) * .28); s.material.opacity = W.thinking * .9; });
  bloom.strength = .55 + lvl * .35;

  // camera: parallax + a gentle dolly by mode
  camBase.z = damp(camBase.z, innerWidth / innerHeight < .8 ? 7 : { idle: 5.2, listening: 4.85, thinking: 5.35, speaking: 5.0 }[mode], 2, dt);
  camera.position.set(camBase.x + ptr.sx * .35 + Math.sin(t * .2) * .04, camBase.y + ptr.sy * .12, camBase.z);
  camera.lookAt(look);

  if (vrm) {
    const acc = {};
    const a = (b, x = 0, y = 0, z = 0) => { const q = acc[b] || (acc[b] = [0, 0, 0]); q[0] += x; q[1] += y; q[2] += z; };
    const sn = Math.sin;
    // relaxed base pose + idle life
    a('hips', 0, -.06 + sn(t * .45) * .025, .07 + sn(t * .8) * .012);
    a('chest', sn(t * 1.3) * .012, .035 + sn(t * .5) * .018, -.035 + sn(t * .65) * .012);
    a('head', .035 + sn(t * .7) * .025, -.045 + sn(t * .42) * .06, -.035 + sn(t * .55) * .018);
    a('leftUpperArm', 0, 0, .84 + sn(t * .65) * .025); a('rightUpperArm', 0, 0, -.66 - sn(t * .65) * .04);
    a('leftLowerArm', 0, 0, .18 + sn(t * .8) * .02); a('rightLowerArm', 0, 0, -.06 - sn(t * .8) * .03);
    a('leftUpperLeg', 0, 0, -.035 + sn(t * .5) * .012); a('rightUpperLeg', 0, 0, .075 + sn(t * .5) * .012);
    a('leftLowerLeg', 0, 0, .018); a('rightLowerLeg', 0, 0, -.045);
    // pointer: head and neck follow the cursor
    const f = 1 - W.thinking * .6;
    a('head', ptr.sy * .2 * f, ptr.sx * .35 * f, 0); a('neck', ptr.sy * .08 * f, ptr.sx * .15 * f, 0);
    // state poses
    a('head', .05 * W.listening + .12 * W.thinking, .12 * W.thinking, .07 * W.listening - .14 * W.thinking);
    a('chest', -.05 * W.listening, .07 * W.thinking, 0);
    const sl = sn(t * 1.7) + sn(t * 2.9) * .6, ws = W.speaking;
    a('head', (-lvl * .06 + sl * .015) * ws, sn(t * 1.3) * .07 * ws, 0);
    a('leftUpperArm', 0, 0, -(lvl * .22 + .04 * Math.max(0, sl)) * ws); a('rightUpperArm', 0, 0, (lvl * .26 + .05 * Math.max(0, -sl)) * ws);
    a('leftLowerArm', 0, -lvl * .5 * ws, 0); a('rightLowerArm', 0, lvl * .55 * ws, 0);
    a('chest', -lvl * .03 * ws, 0, 0);
    // active gesture
    emo.i = emo.o = 0; bounce = 0;
    if (cur) {
      cur.s += dt; const g = cur.g;
      if (cur.s >= g.dur) cur = null;
      else { let e = Math.max(0, Math.min(1, cur.s / .35, (g.dur - cur.s) / .4)); e = e * e * (3 - 2 * e); g.f(e, cur.s, a); }
    }
    for (const b in acc) bone(b)?.rotation.set(acc[b][0], acc[b][1], acc[b][2]);
    vrm.scene.position.y = baseY + bounce;

    // face: lip-sync visemes + blink
    vt -= dt; if (vt < 0) { vi = (vi + 1 + Math.floor(Math.random() * 4)) % 5; vt = rnd(.07, .14); }
    V.forEach((k, j) => { vw[k] = damp(vw[k], j === vi && speaking ? Math.min(1, lvl * 1.4) * (k === 'a' ? .9 : .7) : 0, 22, dt); });
    blinkT -= dt; if (blinkT < 0 && blinkP < 0) { blinkP = 0; blinkT = rnd(2.2, 5.5); }
    let blink = 0; if (blinkP >= 0) { blinkP += dt; blink = sn(Math.min(blinkP / .16, 1) * Math.PI); if (blinkP > .16) blinkP = -1; }
    const ex = vrm.expressionManager;
    if (ex) {
      V.forEach(k => ex.setValue(k, Math.min(1, vw[k] + (k === 'i' ? emo.i : 0) + (k === 'o' ? emo.o : 0))));
      ex.setValue('blink', blink);
    }
    vrm.update(dt);
  }
  composer.render();
}
frame();

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
});
