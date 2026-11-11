// Clay World: an original soft clay buddy in a golden-hour meadow.
// Procedural (no model file needed). Keeps the same hooks as pixel-life.js.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

document.title = 'Clay World // Voice Companion';
document.querySelector('.logo')?.replaceChildren(document.createTextNode('✦'));
const title = document.querySelector('.title');
if (title?.firstChild) title.firstChild.nodeValue = 'CLAY WORLD ';
const badge = document.querySelector('.badge');
if (badge) badge.textContent = 'VOICE LINK';
const eyebrow = document.querySelector('.eyebrow');
if (eyebrow) eyebrow.textContent = 'GOLDEN-HOUR MEADOW';
const feedLabel = document.querySelector('.feed-head span');
if (feedLabel) feedLabel.textContent = 'MEADOW VOICE LINK';

const TAU = Math.PI * 2, rnd = (a, b) => a + Math.random() * (b - a), damp = THREE.MathUtils.damp, sn = Math.sin;

/* ---------- renderer, camera, post ---------- */
const host = document.getElementById('canvas-container');
host.querySelectorAll('canvas').forEach(c => c.remove());
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = .78;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.domElement.style.cssText = 'position:absolute;inset:0';
host.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xcfdde0, 14, 85);
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, .1, 400);

/* ---------- sky + light (golden hour, sun low behind the buddy) ---------- */
const sky = new Sky(); sky.scale.setScalar(250); scene.add(sky);
const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(82), THREE.MathUtils.degToRad(150));
Object.entries({ turbidity: 6, rayleigh: 2, mieCoefficient: .006, mieDirectionalG: .86 }).forEach(([k, v]) => sky.material.uniforms[k].value = v);
sky.material.uniforms.sunPosition.value.copy(sunDir);
const sun = new THREE.DirectionalLight(0xffc890, 3.4);
sun.position.copy(sunDir).multiplyScalar(30); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 70 }); sun.shadow.bias = -.0004; sun.shadow.radius = 5;
scene.add(sun);
const key = new THREE.DirectionalLight(0xfff0dd, 1.5); key.position.set(-4, 4, 6); scene.add(key);
scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x6a8f3a, 1.1));

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bokeh = new BokehPass(scene, camera, { focus: 6, aperture: .0022, maxblur: .012 });
composer.addPass(bokeh);
composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), .22, .5, .92));
composer.addPass(new OutputPass());
const grade = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, t: { value: 0 } },
  vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader: 'uniform sampler2D tDiffuse;uniform float t;varying vec2 vUv;float h(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233))+t)*43758.5453);}void main(){vec3 c=texture2D(tDiffuse,vUv).rgb;float l=dot(c,vec3(.299,.587,.114));c=mix(vec3(l),c,1.12);c*=vec3(1.04,1.,.94);c=mix(c,c*c*(3.-2.*c),.25);float v=smoothstep(.95,.35,distance(vUv,vec2(.5)));c*=mix(.74,1.,v);c+=(h(vUv*900.)-.5)*.02;gl_FragColor=vec4(c,1.);}'
});
composer.addPass(grade);

/* ---------- clay material helpers ---------- */
const noiseTex = (() => {
  const s = document.createElement('canvas'); s.width = s.height = 48; const g = s.getContext('2d'), d = g.createImageData(48, 48);
  for (let i = 0; i < d.data.length; i += 4) { const v = 110 + Math.random() * 60; d.data.set([v, v, v, 255], i); }
  g.putImageData(d, 0, 0);
  const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d'); x.imageSmoothingEnabled = true; x.drawImage(s, 0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(2, 2); return t;
})();
const clay = (color, o = {}) => new THREE.MeshPhysicalMaterial({
  color, roughness: .48, sheen: .72, sheenRoughness: .38, sheenColor: new THREE.Color(color).lerp(new THREE.Color(0xffffff), .58),
  clearcoat: .22, clearcoatRoughness: .42, bumpMap: noiseTex, bumpScale: .16, emissive: new THREE.Color(color).multiplyScalar(.035), ...o
});
const ball = (r, mat, sx = 1, sy = 1, sz = 1) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 56, 40), mat); m.scale.set(sx, sy, sz); m.castShadow = m.receiveShadow = true; return m; };
const caps = (r, l, mat) => { const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, l, 16, 28), mat); m.castShadow = m.receiveShadow = true; return m; };
const at = (o, x, y, z, parent) => { o.position.set(x, y, z); parent?.add(o); return o; };

/* ---------- the buddy (original design: bearded, leaf sprout, big violet eyes) ---------- */
const M = { skin: clay(0xf0dcb8), hair: clay(0x4a3128), sweater: clay(0x3f9f9a), pants: clay(0x5a4036), shoe: clay(0x3a2620), leaf: clay(0x7cc65a), mouth: clay(0x5b2a26, { sheen: 0 }),
  eye: new THREE.MeshPhysicalMaterial({ color: 0xe45bd8, roughness: .15, clearcoat: 1, emissive: 0x6a1668, emissiveIntensity: .5 }), white: new THREE.MeshBasicMaterial({ color: 0xffffff }) };
const root = new THREE.Group(); scene.add(root);
const torso = at(new THREE.Group(), 0, .42, 0, root);
const body = at(ball(.38, M.sweater, 1.14, 1.2, .98), 0, .42, 0, torso); body.userData.zone = 'body';
[1, -1].forEach(s => {                                      // legs + shoes
  const leg = at(caps(.11, .2, M.pants), s * .17, .22, 0, root); at(ball(.15, M.shoe, 1.1, .6, 1.6), s * .17, .05, .07, root);
});
const arm = {}, fore = {};
[['L', 1], ['R', -1]].forEach(([k, s]) => {                 // arms: shoulder pivot -> forearm pivot -> hand
  arm[k] = at(new THREE.Group(), s * .42, .64, 0, torso);
  const up = at(caps(.115, .18, M.sweater), 0, -.14, 0, arm[k]); up.userData.zone = 'body';
  fore[k] = at(new THREE.Group(), 0, -.27, 0, arm[k]);
  at(caps(.102, .14, M.sweater), 0, -.1, 0, fore[k]);
  at(ball(.13, M.skin), 0, -.27, 0, fore[k]).userData.zone = 'body';
});
const head = at(new THREE.Group(), 0, .86, 0, torso);
at(ball(.69, M.skin, 1.16, 1.02, 1.02), 0, .56, 0, head).userData.zone = 'head';
[1, -1].forEach(s => at(ball(.2, M.skin, .72, 1, .62), s * .79, .5, 0, head));                 // ears
at(ball(.67, M.hair, 1.1, .8, 1), 0, .2, .06, head);                                        // beard
at(ball(.3, M.skin, 1.22, .82, .72), 0, .32, .57, head);                                       // muzzle patch
[1, -1].forEach(s => at(ball(.12, M.hair, 1.3, .8, .8), s * .11, .43, .6, head));           // moustache
at(ball(.1, M.skin, 1.2, .9, 1), 0, .47, .66, head);                                         // nose
const mouth = at(ball(1, M.mouth), 0, .28, .72, head);
const hairCap = at(ball(.7, M.hair, 1.14, .72, 1), 0, .86, -.1, head);
for (let i = 0; i < 5; i++) at(ball(.17, M.hair, 1.2, .8, 1), (i - 2) * .28, .96 - Math.abs(i - 2) * .03, .46, head);  // fringe tufts
const eyes = [1, -1].map(s => {
  const g = at(new THREE.Group(), s * .28, .63, .61, head);
  at(ball(.155, M.eye, .9, 1.22, .62), 0, 0, 0, g); at(ball(.052, M.white), .045, .075, .075, g); at(ball(.024, M.white), -.045, -.05, .075, g); return g;
});
const brows = [1, -1].map(s => { const b = at(caps(.028, .13, M.hair), s * .26, .83, .58, head); b.rotation.z = Math.PI / 2; b.castShadow = true; return b; });
const sprout = at(new THREE.Group(), 0, 1.3, -.05, head);
at(caps(.016, .18, M.leaf), 0, .1, 0, sprout);
[1, -1].forEach(s => { const l = at(ball(.09, M.leaf, 1.7, .5, .9), s * .1, .22, 0, sprout); l.rotation.z = s * .5; });
const blob = new THREE.Mesh(new THREE.CircleGeometry(.9, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'), r = g.createRadialGradient(32, 32, 0, 32, 32, 32); r.addColorStop(0, 'rgba(0,0,0,.4)'); r.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = r; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })(), transparent: true, depthWrite: false }));
blob.position.y = .012; scene.add(blob);

/* ---------- meadow ---------- */
const hgt = (x, z) => (sn(x * .13 + sn(z * .07)) * .6 + Math.cos(z * .17) * .3) * THREE.MathUtils.smoothstep(Math.hypot(x, z), 3, 11);
const tg = new THREE.PlaneGeometry(170, 170, 150, 150).rotateX(-Math.PI / 2); const tp = tg.attributes.position, tc = [];
for (let i = 0; i < tp.count; i++) { const x = tp.getX(i), z = tp.getZ(i); tp.setY(i, hgt(x, z)); const k = THREE.MathUtils.smoothstep(Math.hypot(x, z), 0, 40); tc.push(.36 - k * .12, .62 - k * .12, .24 - k * .06); }
tg.setAttribute('color', new THREE.Float32BufferAttribute(tc, 3)); tg.computeVertexNormals();
const ground = new THREE.Mesh(tg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 })); ground.receiveShadow = true; scene.add(ground);

const GN = 15000, bg = new THREE.PlaneGeometry(.07, .55, 1, 3).translate(0, .275, 0);
const bp = bg.attributes.position; for (let i = 0; i < bp.count; i++) bp.setX(i, bp.getX(i) * (1 - bp.getY(i) / .55 * .85));
bg.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(bp.count * 3).map((_, i) => i % 3 === 1 ? 1 : 0), 3));
const windU = { value: 0 };
const grassMat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: .9 });
grassMat.onBeforeCompile = sh => {
  sh.uniforms.uT = windU;
  sh.vertexShader = 'uniform float uT;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nfloat hh=position.y;vec4 ip=instanceMatrix[3];transformed.x+=sin(uT*1.6+ip.x*.8+ip.z*.6)*hh*hh*.55;transformed.z+=sin(uT*1.2+ip.z*.7)*hh*hh*.25;');
};
const grass = new THREE.InstancedMesh(bg, grassMat, GN), tmp = new THREE.Object3D(), col = new THREE.Color();
for (let i = 0; i < GN; i++) {
  const r = Math.sqrt(Math.random()) * 24, a = rnd(0, TAU), x = Math.cos(a) * r, z = Math.sin(a) * r;
  tmp.position.set(x, hgt(x, z), z); tmp.rotation.y = rnd(0, TAU); tmp.scale.set(1, r < 1 ? .4 : rnd(.5, 1.15), 1); tmp.updateMatrix();
  grass.setMatrixAt(i, tmp.matrix); grass.setColorAt(i, col.setHSL(rnd(.24, .33), rnd(.45, .6), rnd(.28, .46)));
}
grass.receiveShadow = true; scene.add(grass);

const FN = 320, flowers = new THREE.InstancedMesh(new THREE.SphereGeometry(.05, 10, 8), clay(0xffffff, { emissive: 0x000000 }), FN);
const stems = new THREE.InstancedMesh(new THREE.CylinderGeometry(.006, .006, .28).translate(0, .14, 0), new THREE.MeshStandardMaterial({ color: 0x4f8a3a }), FN);
const fcols = [0xfff3d6, 0xffd34d, 0xff8fb8, 0xffffff];
for (let i = 0; i < FN; i++) {
  const r = rnd(1.3, 22), a = rnd(0, TAU), x = Math.cos(a) * r, z = Math.sin(a) * r, y = hgt(x, z);
  tmp.position.set(x, y, z); tmp.rotation.set(0, 0, 0); tmp.scale.setScalar(1); tmp.updateMatrix(); stems.setMatrixAt(i, tmp.matrix);
  tmp.position.y = y + .28; tmp.scale.setScalar(rnd(.8, 1.4)); tmp.updateMatrix(); flowers.setMatrixAt(i, tmp.matrix); flowers.setColorAt(i, col.setHex(fcols[i % 4]));
}
scene.add(stems, flowers);

const canopy = [0x4f9a4a, 0x5fae52, 0x44873f].map(c => clay(c, { roughness: .8 })), trunk = clay(0x7a5a44);
function tree(x, z, s) {
  const g = new THREE.Group(); g.position.set(x, hgt(x, z), z);
  const t = caps(.14 * s, 1.2 * s, trunk); t.position.y = .8 * s; g.add(t);
  [[0, 2.1, 1.1], [.5, 1.7, .8], [-.5, 1.85, .85]].forEach(([dx, dy, r], i) => { const b = ball(r * s, canopy[i % 3]); b.position.set(dx * s, dy * s, rnd(-.3, .3) * s); g.add(b); });
  g.rotation.y = rnd(0, TAU); scene.add(g);
}
for (let i = 0; i < 16; i++) { const a = rnd(-1.15, 1.15), d = rnd(9, 32); tree(sn(a) * d * 1.1, -Math.cos(a) * d - 3, rnd(1.1, 2)); }
for (let i = 0; i < 8; i++) tree((Math.random() < .5 ? -1 : 1) * rnd(7, 15), rnd(-8, 2), rnd(.9, 1.4));
const hillMat = clay(0x5e9a55, { roughness: 1 });
for (let i = 0; i < 6; i++) { const h = ball(rnd(18, 30), hillMat, 1.6, .38, 1); h.position.set((i - 2.5) * 28 + rnd(-6, 6), -2, rnd(-95, -70)); h.castShadow = false; scene.add(h); }
const cloudTex = (() => { const c = document.createElement('canvas'); c.width = 256; c.height = 128; const g = c.getContext('2d'); for (let i = 0; i < 16; i++) { const x = rnd(40, 216), y = rnd(45, 85), r = rnd(25, 48), gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(255,240,225,.5)'); gr.addColorStop(1, 'rgba(255,240,225,0)'); g.fillStyle = gr; g.fillRect(0, 0, 256, 128); } return new THREE.CanvasTexture(c); })();
const clouds = Array.from({ length: 9 }, () => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudTex, transparent: true, depthWrite: false, fog: false, opacity: rnd(.5, .85) })); s.scale.set(rnd(50, 80), rnd(20, 32), 1); s.position.set(rnd(-120, 120), rnd(22, 45), rnd(-130, -80)); scene.add(s); return s; });
const dot = (() => { const c = document.createElement('canvas'); c.width = c.height = 32; const g = c.getContext('2d'), r = g.createRadialGradient(16, 16, 0, 16, 16, 16); r.addColorStop(0, 'rgba(255,245,220,1)'); r.addColorStop(1, 'rgba(255,245,220,0)'); g.fillStyle = r; g.fillRect(0, 0, 32, 32); return new THREE.CanvasTexture(c); })();
const PN = 240, pp = new Float32Array(PN * 3), pv = new Float32Array(PN);
for (let i = 0; i < PN; i++) { pp.set([rnd(-10, 10), rnd(.2, 5), rnd(-12, 5)], i * 3); pv[i] = rnd(.05, .22); }
const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(pp, 3));
scene.add(new THREE.Points(pg, new THREE.PointsMaterial({ size: .1, map: dot, transparent: true, opacity: .75, depthWrite: false, blending: THREE.AdditiveBlending })));

/* ---------- hooks shared with the HUD / realtime.js ---------- */
let analyser = null, adata = null, lvl = 0, speaking = false, statusMode = 'idle';
window.animateSpeaking = v => { speaking = v; };
window.pixelTap = (src, ctx) => { try { analyser = ctx.createAnalyser(); analyser.fftSize = 512; adata = new Uint8Array(512); src.connect(analyser); } catch (_) {} };
const statusEl = document.getElementById('status');
const readStatus = () => { const s = (statusEl?.textContent || '').toUpperCase(); return /THINK|PROCESS|TRANSCRIB/.test(s) ? 'thinking' : /LISTEN|HEARING/.test(s) ? 'listening' : 'idle'; };
if (statusEl) new MutationObserver(() => { statusMode = readStatus(); }).observe(statusEl, { childList: true, characterData: true, subtree: true });

/* ---------- gestures (this rig faces +Z: arm z>0 lifts the left arm outward, head x>0 looks down) ---------- */
const emo = { i: 0, o: 0, b: 0 }; let bounce = 0, cur = null, lastTrig = 0, happy = 0, sq = 0, sqv = 0;
const G = {
  wave:      { dur: 2.8, f: (e, s, a) => { a('armL', 0, 0, 2.5 * e); a('foreL', 0, 0, .5 * e * sn(s * 11)); a('head', 0, 0, .07 * e); emo.i = .5 * e; } },
  shrug:     { dur: 1.7, f: (e, s, a) => { a('armL', 0, 0, .5 * e); a('armR', 0, 0, -.5 * e); a('lift', 0, .07 * e, 0); a('head', 0, 0, .12 * e); emo.b = .6 * e; } },
  celebrate: { dur: 2.6, f: (e, s, a) => { a('armL', 0, 0, 2.9 * e); a('armR', 0, 0, -2.9 * e); a('foreL', 0, 0, .3 * e * sn(s * 9)); a('foreR', 0, 0, -.3 * e * sn(s * 9)); bounce = Math.abs(sn(s * 6)) * .12 * e; emo.i = .9 * e; happy = Math.max(happy, e); } },
  bow:       { dur: 2.2, f: (e, s, a) => { a('torso', .45 * e, 0, 0); a('head', .25 * e, 0, 0); a('armL', -.3 * e, 0, 0); a('armR', -.3 * e, 0, 0); } },
  nod:       { dur: 1.2, f: (e, s, a) => a('head', .22 * sn(s * 11) * (1 - s / 1.2), 0, 0) },
  shake:     { dur: 1.2, f: (e, s, a) => a('head', 0, .3 * sn(s * 11) * (1 - s / 1.2), 0) },
  surprise:  { dur: 1.5, f: (e, s, a) => { a('head', -.15 * e, 0, 0); a('torso', -.06 * e, 0, 0); a('armL', 0, 0, .45 * e); a('armR', 0, 0, -.45 * e); emo.o = .7 * e; emo.b = e; } },
};
const gesture = n => { if (G[n]) cur = { g: G[n], s: 0 }; };
window.pixel = { gesture, list: Object.keys(G) };
const RX = [[/\b(hi|hello|hey|good (morning|evening)|bye|goodbye|see you)\b/i, 'wave'], [/\b(thanks|thank you)\b/i, 'bow'], [/\b(haha|lol|funny|joke)\b/i, 'celebrate'],
  [/\b(wow|whoa|surpris|amazing)/i, 'surprise'], [/\b(yes|yeah|sure|exactly)\b/i, 'nod'], [/\b(nope|nah)\b/i, 'shake'], [/\b(maybe|not sure|don't know|no idea)/i, 'shrug']];
const react = t => { if (performance.now() - lastTrig < 2500) return false; for (const [r, g] of RX) if (r.test(t)) { gesture(g); lastTrig = performance.now(); return true; } return false; };
let rbuf = ''; window.pixelUser = t => { rbuf = ''; react(t); }; window.pixelToken = d => { rbuf = (rbuf + d).slice(-60); if (react(rbuf)) rbuf = ''; };
document.querySelectorAll('.emote').forEach(b => b.addEventListener('click', () => gesture(b.dataset.gesture)));
addEventListener('keydown', e => { if (/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return; const n = +e.key; if (n >= 1 && n <= 7) gesture(Object.keys(G)[n - 1]); });

/* ---------- camera director + touch zones ---------- */
const ptr = { x: 0, y: 0, sx: 0, sy: 0 }, cam = { az: 0, el: 0, zoom: 1, dist: 6.6, ty: 1.45, drag: false, moved: 0, idle: 0, close: false };
const dom = renderer.domElement, ray = new THREE.Raycaster(), v2 = new THREE.Vector2();
addEventListener('pointermove', e => {
  ptr.x = (e.clientX / innerWidth - .5) * 2; ptr.y = -(e.clientY / innerHeight - .5) * 2;
  if (cam.drag) { cam.az = THREE.MathUtils.clamp(cam.az - e.movementX * .005, -.7, .7); cam.el = THREE.MathUtils.clamp(cam.el + e.movementY * .003, -.05, .35); cam.moved += Math.abs(e.movementX) + Math.abs(e.movementY); cam.idle = 0; }
});
dom.addEventListener('pointerdown', () => { cam.drag = true; cam.moved = 0; });
addEventListener('pointerup', e => {
  if (!cam.drag) return; cam.drag = false;
  if (cam.moved > 6 || e.target !== dom) return;
  v2.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); ray.setFromCamera(v2, camera);
  const hit = ray.intersectObject(root, true).find(h => h.object.userData.zone);
  if (hit?.object.userData.zone === 'head') { happy = 1; sq = 1; emo.b = 0; }
  else if (hit) { sq = 1; gesture('wave'); }
});
dom.addEventListener('wheel', e => { cam.zoom = THREE.MathUtils.clamp(cam.zoom + e.deltaY * .0008, .6, 1.4); }, { passive: true });
dom.addEventListener('dblclick', () => { cam.close = !cam.close; });

/* ---------- loop ---------- */
const V = ['a', 'e', 'i', 'o', 'u'], vw = { a: 0, e: 0, i: 0, o: 0, u: 0 }, VS = { a: [1, 1], e: [1.55, .55], i: [1.75, .35], o: [.8, .9], u: [.65, .7] };
const W = { listening: 0, thinking: 0, speaking: 0 }, clock = new THREE.Clock(), tgt = new THREE.Vector3();
let vi = 0, vt = 0, blinkT = rnd(2, 4), blinkP = -1;
const bodyParts = { torso, head, armL: arm.L, armR: arm.R, foreL: fore.L, foreR: fore.R };
setTimeout(() => gesture('wave'), 900);

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), .05), t = clock.elapsedTime, mode = speaking ? 'speaking' : statusMode;
  let raw = 0;
  if (analyser) { analyser.getByteTimeDomainData(adata); let s = 0; for (const v of adata) { const x = (v - 128) / 128; s += x * x; } raw = Math.min(1, Math.sqrt(s / adata.length) * 5); }
  else if (speaking) raw = .35 + .3 * Math.abs(sn(t * 9));
  lvl = damp(lvl, raw, 18, dt);
  for (const k in W) W[k] = damp(W[k], mode === k ? 1 : 0, 5, dt);
  ptr.sx = damp(ptr.sx, ptr.x, 4, dt); ptr.sy = damp(ptr.sy, ptr.y, 4, dt);
  windU.value = t;

  // ambient life
  clouds.forEach(c => { c.position.x += dt * .6; if (c.position.x > 140) c.position.x = -140; });
  const p = pg.attributes.position.array;
  for (let i = 0; i < PN; i++) { p[i * 3 + 1] += pv[i] * dt; p[i * 3] += sn(t * .5 + i) * dt * .15; if (p[i * 3 + 1] > 5.5) p[i * 3 + 1] = .2; }
  pg.attributes.position.needsUpdate = true;

  // pose accumulator
  const acc = {}, a = (b, x = 0, y = 0, z = 0) => { const q = acc[b] || (acc[b] = [0, 0, 0]); q[0] += x; q[1] += y; q[2] += z; };
  a('torso', 0, sn(t * .5) * .03, sn(t * .65) * .012);
  a('armL', sn(t * .8) * .03, 0, .14 + sn(t * .65) * .03); a('armR', sn(t * .8 + 1) * .03, 0, -.14 - sn(t * .65) * .03);
  a('foreL', -.12, 0, 0); a('foreR', -.12, 0, 0);
  a('head', .02 + sn(t * .7) * .02, sn(t * .42) * .05, sn(t * .55) * .02);
  const f = 1 - W.thinking * .6;
  a('head', -ptr.sy * .18 * f, ptr.sx * .35 * f, 0);
  a('head', .04 * W.listening - .1 * W.thinking, .12 * W.thinking, .06 * W.listening - .14 * W.thinking); a('torso', -.04 * W.listening, 0, 0);
  const sl = sn(t * 1.7) + sn(t * 2.9) * .6, ws = W.speaking;
  a('head', (lvl * .05 + sl * .012) * ws, sn(t * 1.3) * .07 * ws, 0);
  a('armL', 0, 0, (lvl * .25 + .05 * Math.max(0, sl)) * ws); a('armR', 0, 0, -(lvl * .28 + .05 * Math.max(0, -sl)) * ws);
  a('foreL', -lvl * .5 * ws, 0, 0); a('foreR', -lvl * .5 * ws, 0, 0);
  emo.i = emo.o = emo.b = 0; bounce = 0; happy = damp(happy, 0, 1.6, dt);
  if (cur) { cur.s += dt; if (cur.s >= cur.g.dur) cur = null; else { let e = Math.max(0, Math.min(1, cur.s / .35, (cur.g.dur - cur.s) / .4)); e = e * e * (3 - 2 * e); cur.g.f(e, cur.s, a); } }
  for (const k in bodyParts) { const q = acc[k]; if (q) bodyParts[k].rotation.set(q[0], q[1], q[2]); }
  const lift = acc.lift?.[1] || 0; arm.L.position.y = arm.R.position.y = .62 + lift;
  sqv += (-90 * sq - 9 * sqv) * dt; sq += sqv * dt;                          // jelly spring
  root.scale.set(1 + sq * .05, 1 - sq * .07, 1 + sq * .05); root.position.y = bounce;
  torso.scale.y = 1 + sn(t * 1.3) * .012; sprout.rotation.z = sn(t * 1.4) * .15 + ptr.sx * .1; sprout.rotation.x = sn(t * 1.1) * .1;
  blob.scale.setScalar(1 - bounce * 2);

  // face
  vt -= dt; if (vt < 0) { vi = (vi + 1 + Math.floor(Math.random() * 4)) % 5; vt = rnd(.07, .14); }
  let mw = 1.5, mh = .3;
  V.forEach((k, j) => { vw[k] = damp(vw[k], j === vi && speaking ? Math.min(1, lvl * 1.4) : 0, 22, dt); mw += vw[k] * (VS[k][0] - 1.5); mh += vw[k] * (VS[k][1] * 1.6 - .3); });
  mouth.scale.set(.1 * (mw + emo.i * .5 + happy * .5), .1 * (mh + emo.o * .5), .05);
  blinkT -= dt; if (blinkT < 0 && blinkP < 0) { blinkP = 0; blinkT = rnd(2.2, 5.5); }
  let blink = 0; if (blinkP >= 0) { blinkP += dt; blink = sn(Math.min(blinkP / .16, 1) * Math.PI); if (blinkP > .16) blinkP = -1; }
  eyes.forEach(e => { e.scale.y = 1 - Math.max(blink, happy * .75) * .85; });
  brows.forEach((b, i) => { b.position.y = .83 + emo.b * .05 + happy * .02; b.rotation.z = Math.PI / 2 + (i ? -1 : 1) * (W.thinking * .25 + emo.b * .1); });

  // camera director
  const aspect = innerWidth / innerHeight, wide = aspect < .8 ? 1.35 : 1;
  const base = cam.close ? 3.9 : { idle: 6.6, listening: 5.9, thinking: 6.9, speaking: 5.0 }[mode], ty = cam.close ? 1.95 : { idle: 1.45, listening: 1.5, thinking: 1.45, speaking: 1.7 }[mode];
  cam.dist = damp(cam.dist, base * wide * cam.zoom, 2.2, dt); cam.ty = damp(cam.ty, ty, 2.2, dt);
  if (!cam.drag) { cam.idle += dt; if (cam.idle > 5) { cam.az = damp(cam.az, 0, 1.2, dt); cam.el = damp(cam.el, 0, 1.2, dt); } }
  const az = cam.az + ptr.sx * .06, el = cam.el + .06 + ptr.sy * .02;
  tgt.set(0, cam.ty, 0);
  camera.position.set(sn(az) * Math.cos(el) * cam.dist + sn(t * .2) * .04, tgt.y + sn(el) * cam.dist, Math.cos(az) * Math.cos(el) * cam.dist);
  camera.lookAt(tgt);
  bokeh.uniforms.focus.value = camera.position.distanceTo(tgt);
  grade.uniforms.t.value = t % 10;
  composer.render();
}
frame();

addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); });
