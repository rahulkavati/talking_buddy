// Pixel // Soft Meadow: a clay buddy on a bench in a golden-hour meadow.
// Same hooks as before (animateSpeaking, pixelTap, pixel.gesture, pixelUser, pixelToken), new world.
import * as THREE from 'three';
import { buildSky, SUN_DIR, LIGHT_DIR } from './scene/sky.js';
import { buildMeadow, HAZE } from './scene/meadow.js';
import { buildBuddy } from './scene/buddy.js';
import { createPost } from './scene/post.js';

const qs = new URLSearchParams(location.search);
const SHOT = qs.has('shot');
const QUALITY = parseFloat(qs.get('q') || (SHOT ? '.6' : '1'));
const TAU = Math.PI * 2, rnd = (a, b) => a + Math.random() * (b - a), damp = THREE.MathUtils.damp, sn = Math.sin;

document.title = 'Pixel // Soft Meadow';
const $ = s => document.querySelector(s);
$('.logo')?.replaceChildren(document.createTextNode('✿'));
if ($('.title')?.firstChild) $('.title').firstChild.nodeValue = 'PIXEL ';
if ($('.badge')) $('.badge').textContent = 'SOFT MEADOW';
if ($('.eyebrow')) $('.eyebrow').textContent = 'LOCAL VOICE COMPANION';
if ($('.feed-head span')) $('.feed-head span').textContent = 'MEADOW VOICE LINK';

/* ---------- renderer / scene / camera / post ---------- */
const host = document.getElementById('canvas-container');
host.querySelectorAll('canvas').forEach(c => c.remove());
let PR = Math.min(devicePixelRatio || 1, SHOT ? 1 : 1.6);
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(PR); renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.domElement.style.cssText = 'position:absolute;inset:0';
host.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(HAZE, 40, 260);
const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, .1, 700);
const post = createPost(renderer, scene, camera, Math.round(innerWidth * PR), Math.round(innerHeight * PR));

/* ---------- light: low golden sun behind-right, soft warm fill from the lens side ---------- */
const sun = new THREE.DirectionalLight(0xffc27a, 3.2);
sun.position.copy(LIGHT_DIR).multiplyScalar(30); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 70 }); sun.shadow.bias = -.0004; sun.shadow.normalBias = .03; sun.shadow.radius = 6;
scene.add(sun);
const key = new THREE.DirectionalLight(0xffe6cf, 2.1); key.position.set(-4, 3.5, 7); scene.add(key);
const fill = new THREE.PointLight(0xffd7bd, 1.6, 14, 2); fill.position.set(2.6, 2.6, 5.5); scene.add(fill);
scene.add(new THREE.HemisphereLight(0xf2cfc0, 0x7d8a3c, 1.25));

const sky = buildSky(scene);
const meadow = buildMeadow(scene, QUALITY);
const B = buildBuddy(scene);
const { float, squash, eyes, mouthG, mouth, tongue, antenna, hands, blob } = B;

/* ---------- hooks shared with the HUD / realtime.js ---------- */
let analyser = null, adata = null, lvl = 0, speaking = false, statusMode = 'idle';
window.animateSpeaking = v => { speaking = v; };
window.pixelTap = (src, ctx) => { try { analyser = ctx.createAnalyser(); analyser.fftSize = 512; adata = new Uint8Array(512); src.connect(analyser); } catch (_) {} };
const statusEl = document.getElementById('status');
const readStatus = () => { const s = (statusEl?.textContent || '').toUpperCase(); return /THINK|PROCESS|TRANSCRIB/.test(s) ? 'thinking' : /LISTEN|HEARING/.test(s) ? 'listening' : 'idle'; };
if (statusEl) new MutationObserver(() => { statusMode = readStatus(); }).observe(statusEl, { childList: true, characterData: true, subtree: true });
// kept so realtime.js / fast-chat.js keep working; the buddy no longer does scripted poses
window.pixel = { gesture() {}, list: [] }; window.pixelUser = () => {}; window.pixelToken = () => {};

/* ---------- camera director + touch ---------- */
const ptr = { x: 0, y: 0, sx: 0, sy: 0 }, cam = { az: 0, el: 0, zoom: 1, dist: 7.5, ty: 1.5, drag: false, moved: 0, idle: 0, close: false };
const dom = renderer.domElement, ray = new THREE.Raycaster(), v2 = new THREE.Vector2();
let sq = 0, sqv = 0, pokeT = 0;
addEventListener('pointermove', e => {
  ptr.x = (e.clientX / innerWidth - .5) * 2; ptr.y = -(e.clientY / innerHeight - .5) * 2;
  if (cam.drag) { cam.az = THREE.MathUtils.clamp(cam.az - e.movementX * .005, -.7, .7); cam.el = THREE.MathUtils.clamp(cam.el + e.movementY * .003, -.05, .35); cam.moved += Math.abs(e.movementX) + Math.abs(e.movementY); cam.idle = 0; }
});
dom.addEventListener('pointerdown', () => { cam.drag = true; cam.moved = 0; });
addEventListener('pointerup', e => {
  if (!cam.drag) return; cam.drag = false;
  if (cam.moved > 6 || e.target !== dom) return;
  v2.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); ray.setFromCamera(v2, camera);
  if (ray.intersectObject(B.root, true).some(h => h.object.userData.zone)) { sq = 1; pokeT = .6; }      // poke: jelly boing + happy blink
});
dom.addEventListener('wheel', e => { cam.zoom = THREE.MathUtils.clamp(cam.zoom + e.deltaY * .0008, .6, 1.4); }, { passive: true });
dom.addEventListener('dblclick', () => { cam.close = !cam.close; });

/* ---------- loop ---------- */
const W = { listening: 0, thinking: 0, speaking: 0 }, tgt = new THREE.Vector3();
let blinkT = rnd(1.6, 3.2), blinkP = -1, doubleBlink = false, T = 0;
let mVis = 0, mVisV = 0, mOpen = 0, vTimer = 0, vShape = 1;
let antPulse = 0, antNext = 1.2, antDir = 1;
if (!SHOT) setTimeout(() => { sq = .6; }, 600);

function spring(x, v, target, k, c, dt) { v += (k * (target - x) - c * v) * dt; return [x + v * dt, v]; }

function update(dt, forcedMode) {
  T += dt; const t = T, mode = forcedMode || (speaking ? 'speaking' : statusMode);
  let raw = 0;
  if (analyser) { analyser.getByteTimeDomainData(adata); let s = 0; for (const v of adata) { const x = (v - 128) / 128; s += x * x; } raw = Math.min(1, Math.sqrt(s / adata.length) * 5); }
  else if (speaking) raw = .4 + .3 * Math.abs(sn(t * 9)) * (.6 + .4 * sn(t * 3.1));
  lvl = damp(lvl, raw, 18, dt);
  for (const k in W) W[k] = damp(W[k], mode === k ? 1 : 0, 5, dt);
  ptr.sx = damp(ptr.sx, ptr.x, 4, dt); ptr.sy = damp(ptr.sy, ptr.y, 4, dt);
  sky.update(t, dt); meadow.update(t);
  const ws = W.speaking, wl = W.listening, wt = W.thinking;

  // floating: slow bob + gentle sway; slightly more bounce while talking
  float.position.y = B.REST_Y + sn(t * 1.35) * .05 + lvl * .035 * ws;
  squash.rotation.set(sn(t * .7) * .025 - ptr.sy * .05, ptr.sx * .22 + sn(t * .5) * .04, sn(t * .9) * .03 - ptr.sx * .03);
  sqv += (-90 * sq - 9 * sqv) * dt; sq += sqv * dt;                            // jelly spring (poke / startup)
  const breathe = sn(t * 1.35 + 1.2) * .012;
  squash.scale.set(1 + sq * .06 - breathe, 1 - sq * .08 + breathe * 1.5 + lvl * .02 * ws, 1 + sq * .06 - breathe);
  const lift = (float.position.y - B.REST_Y) / .1;
  blob.scale.setScalar(1 - lift * .05); blob.material.opacity = .85 - lift * .1;

  // eyes: blink (sometimes double), follow pointer, look up while thinking, widen while listening
  blinkT -= dt;
  if (blinkT < 0 && blinkP < 0) { blinkP = 0; blinkT = doubleBlink ? .22 : rnd(2.0, 5.0); doubleBlink = !doubleBlink && Math.random() < .22; }
  let blink = 0; if (blinkP >= 0) { blinkP += dt; blink = sn(Math.min(blinkP / .15, 1) * Math.PI); if (blinkP > .15) blinkP = -1; }
  pokeT = Math.max(0, pokeT - dt);
  const happy = pokeT > 0 ? Math.min(1, pokeT / .3) : 0;
  const gx = ptr.sx * .035 * (1 - wt * .7), gy = (ptr.sy * .03 + wt * .035) ;
  eyes.forEach(g => {
    g.scale.set(1 + wl * .08, Math.max(.06, 1 - Math.max(blink, happy * .7) * .94) * (1 + wl * .08), 1);
    const { pupil, glint } = g.userData; pupil.position.x = gx; pupil.position.y = gy; glint.position.x = .02 + gx; glint.position.y = .02 + gy;
    pupil.scale.setScalar(1 + wl * .12 + lvl * .1 * ws);
  });

  // mouth: appears with a springy pop only while audio is playing, opens with the voice level
  [mVis, mVisV] = spring(mVis, mVisV, speaking || lvl > .05 ? 1 : 0, 260, 18, dt);
  vTimer -= dt; if (vTimer < 0) { vShape = .75 + Math.random() * .6; vTimer = rnd(.06, .14); }
  mOpen = damp(mOpen, speaking ? Math.min(1, (lvl * 1.5 + .12)) * vShape : 0, 24, dt);
  const mv = Math.max(0, mVis); mouthG.visible = mv > .01; mouthG.scale.setScalar(mv);
  mouth.scale.set(.1 + mOpen * .035, .02 + mOpen * .095, .12);
  tongue.visible = mOpen > .25; tongue.position.y = -.5 + mOpen * .1;

  // antennae: lazy sway always; while talking, random lively wiggles (alternating sides) now and then
  if (speaking) { antNext -= dt; if (antNext < 0) { antPulse = 1; antDir = -antDir; antNext = rnd(1.4, 3.4); } }
  antPulse = Math.max(0, antPulse - dt * .75);
  const wig = Math.sin(t * 15) * antPulse * antPulse;
  antenna.forEach((a, i) => {
    const s = a.userData.s, ph = i * 1.7;
    a.rotation.z = -s * (.04 + wl * .22) + sn(t * .9 + ph) * .05 + wig * .22 * (antDir * s > 0 ? 1.2 : .7) - wt * s * .1;
    a.rotation.x = sn(t * 1.15 + ph) * .05 + wig * .12 + lvl * .05 * ws;
  });
  // hands: soft float sway, a little lift while talking
  hands.forEach((h, i) => { const s = h.userData.s; h.rotation.z = s * (-.04 - lvl * .18 * ws - wl * .06) + sn(t * 1.1 + i) * .05; h.position.y = -.08 + sn(t * 1.35 + i * .7 + .5) * .018 + lvl * .02 * ws; });

  // camera director
  const aspect = innerWidth / innerHeight, wide = aspect < .8 ? 1.5 : aspect < 1.2 ? 1.2 : 1;
  const base = cam.close ? 5.2 : { idle: 7.5, listening: 7.2, thinking: 7.3, speaking: 6.9 }[mode], ty = cam.close ? 1.6 : { idle: 1.5, listening: 1.52, thinking: 1.5, speaking: 1.55 }[mode];
  cam.dist = damp(cam.dist, base * wide * cam.zoom, 2.2, dt); cam.ty = damp(cam.ty, ty, 2.2, dt);
  if (!cam.drag) { cam.idle += dt; if (cam.idle > 5) { cam.az = damp(cam.az, 0, 1.2, dt); cam.el = damp(cam.el, 0, 1.2, dt); } }
  const az = cam.az + ptr.sx * .05, el = cam.el + ptr.sy * .015 - .01;
  tgt.set(0, cam.ty, .25);
  camera.position.set(sn(az) * Math.cos(el) * cam.dist + sn(t * .2) * .03, Math.max(.7, tgt.y + .1 + sn(el) * cam.dist), Math.cos(az) * Math.cos(el) * cam.dist + tgt.z);
  camera.lookAt(tgt);
  post.dof.uniforms.focus.value = camera.position.distanceTo(tgt);
  post.dof.uniforms.range.value = 11; post.dof.uniforms.maxCoc.value = 3.2 * PR;
  post.grade.uniforms.t.value = t % 10;
}

const clock = new THREE.Clock();
let slow = 0, frames = 0;
function frame() {
  requestAnimationFrame(frame); const d = clock.getDelta(); update(Math.min(d, .05)); post.composer.render();
  // quality governor: if the GPU can't hold ~40fps for ~2s, drop the render resolution once (and again once more)
  if (d > .026 && d < .5) slow++; else slow = Math.max(0, slow - 1);
  if (++frames % 120 === 0 && slow > 70 && PR > .8) { PR = Math.max(.75, PR * .75); slow = 0; renderer.setPixelRatio(PR); PR_apply(); }
}
if (!SHOT) frame();
else {
  // deterministic screenshot mode: ?shot  ->  window.__shot.go({ t: seconds, mode, gesture, az, dist })
  window.__post = post; window.__scene = scene; window.__shot = { stats: meadow.stats, go(o = {}) {
    if (o.speak !== undefined) speaking = o.speak;
    if (o.az !== undefined) cam.az = o.az; if (o.close !== undefined) cam.close = o.close;
    const n = Math.round((o.t ?? 4) * 20); for (let i = 0; i < n; i++) update(.05, o.mode);
    post.composer.render(); return meadow.stats;
  } };
}

addEventListener('resize', () => {
  PR_apply();
});
function PR_apply() {
  renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  post.setSize(Math.round(innerWidth * PR), Math.round(innerHeight * PR));
}
