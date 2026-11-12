// The buddy: a floating red clay blob (antennae, mitten hands, teal-pupil eyes, mouth that only appears when talking)
// above a wooden bench. (Old seated-character notes removed.)
// ORIGINAL: a seated clay character built to match the reference render
// (cream head, bean-shaped brown hair locks, sculpted beard mask with cream mouth patch, huge glossy magenta eyes,
//  antenna with a cream ball, teal sweater with rolled cuffs, brown shorts, cream ankles, big plum shoes) on a wooden bench.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { LIGHT_DIR as SUN_DIR } from './sky.js';

const C = h => new THREE.Color(h), TAU = Math.PI * 2;
const ss = THREE.MathUtils.smoothstep;

/* ---------- clay material: soft wrap lighting feel + warm sun rim + faint micro-bump ---------- */
const noiseTex = (() => {
  const s = document.createElement('canvas'); s.width = s.height = 64; const g = s.getContext('2d'), d = g.createImageData(64, 64);
  for (let i = 0; i < d.data.length; i += 4) { const v = 120 + Math.random() * 40; d.data.set([v, v, v, 255], i); }
  g.putImageData(d, 0, 0);
  const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d'); x.imageSmoothingEnabled = true; x.drawImage(s, 0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 3); return t;
})();
const rimPatch = sh => {
  sh.uniforms.rimDir = { value: SUN_DIR.clone() };
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 rimDir;')
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      {
        vec3 vd=normalize(vViewPosition);
        float fr=pow(1.-clamp(dot(normal,vd),0.,1.),2.4);
        vec3 ld=normalize((viewMatrix*vec4(rimDir,0.)).xyz);
        float back=clamp(dot(normal,ld)*.6+.55,0.,1.);
        totalEmissiveRadiance+=vec3(1.,.72,.45)*fr*back*.55;                 // warm golden-hour rim
        totalEmissiveRadiance+=diffuseColor.rgb*.07;                         // faint subsurface fill so shadows stay warm, never grey
      }`);
};
export const clay = (color, o = {}) => {
  const m = new THREE.MeshPhysicalMaterial({
    color, roughness: .5, sheen: .5, sheenRoughness: .5, sheenColor: C(color).lerp(C(0xffffff), .55),
    clearcoat: .22, clearcoatRoughness: .42, bumpMap: noiseTex, bumpScale: .012, ...o,
  });
  m.onBeforeCompile = rimPatch; m.customProgramCacheKey = () => 'clay-rim'; return m;
};

const ball = (r, mat, sx = 1, sy = 1, sz = 1, seg = 48) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.round(seg * .7)), mat); m.scale.set(sx, sy, sz); m.castShadow = m.receiveShadow = true; return m; };
const caps = (r, l, mat) => { const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, l, 16, 32), mat); m.castShadow = m.receiveShadow = true; return m; };
const at = (o, x, y, z, parent) => { o.position.set(x, y, z); parent?.add(o); return o; };

export function buildBuddy(scene) {
  const RED = 0xd9443a;
  const M = {
    body: clay(RED, { roughness: .52, sheen: .7, sheenRoughness: .5, sheenColor: C(0xff9a8a), clearcoat: .2, clearcoatRoughness: .45, bumpScale: .006 }),
    mitt: clay(0xcf3d34, { roughness: .52, sheen: .6 }),
    eye: new THREE.MeshStandardMaterial({ color: 0x0b1620, roughness: .25, metalness: .1 }),
    pupil: new THREE.MeshBasicMaterial({ color: 0x69f0d6 }),
    glint: new THREE.MeshBasicMaterial({ color: 0xeafffa }),
    mouth: new THREE.MeshStandardMaterial({ color: 0x3a0a0c, roughness: .6 }),
    tongue: new THREE.MeshStandardMaterial({ color: 0xff7f8a, roughness: .5, emissive: 0x7a2030, emissiveIntensity: .4 }),
    wood: clay(0xa98866, { roughness: .64, sheen: .25 }), woodDark: clay(0x8f7050, { roughness: .68 }),
  };
  const root = new THREE.Group(); scene.add(root);

  /* ---------- bench ---------- */
  const bench = new THREE.Group(); scene.add(bench);
  const plank = (w, h, d, x, y, z, m = M.wood, rx = 0) => { const p = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 5, Math.min(h, d) * .32), m); p.position.set(x, y, z); p.rotation.x = rx; p.castShadow = p.receiveShadow = true; bench.add(p); return p; };
  [-.28, .17, .62, .98].forEach((z, i) => plank(3.2, .1, i === 3 ? .3 : .38, 0, .45, z));
  plank(3.2, .24, .09, 0, 1.0, -.58, M.wood, -.05); plank(3.2, .24, .09, 0, 1.3, -.6, M.wood, -.05);
  [-1.45, 1.45].forEach(x => {
    plank(.13, .45, .13, x, .22, .8, M.woodDark).rotation.z = x > 0 ? -.07 : .07; plank(.13, .45, .13, x, .22, -.2, M.woodDark).rotation.z = x > 0 ? -.07 : .07;
    plank(.13, 1.5, .13, x, .75, -.62, M.woodDark, -.04);
    plank(.12, .12, 1.3, x, .38, .3, M.woodDark);
  });
  const SEAT = .5, HOVER = .2, BR = new THREE.Vector3(.82, .8, .78), REST_Y = SEAT + HOVER + BR.y;

  /* ---------- body (floats; no legs) ---------- */
  const float = at(new THREE.Group(), 0, REST_Y, .25, root);          // bobbing happens here
  const squash = at(new THREE.Group(), 0, 0, 0, float);               // jelly squash/stretch + sway
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 96), M.body); body.scale.copy(BR); body.castShadow = body.receiveShadow = true; body.userData.zone = 'head'; squash.add(body);
  const surf = (x, y, off = 0) => { const z = BR.z * Math.sqrt(Math.max(0, 1 - (x / BR.x) ** 2 - (y / BR.y) ** 2)); const n = new THREE.Vector3(x / BR.x ** 2, y / BR.y ** 2, z / BR.z ** 2).normalize(); return { p: new THREE.Vector3(x, y, z).addScaledVector(n, off), n }; };

  // eyes: dark discs, teal pupils with a tiny glint; they follow the pointer
  const eyes = [1, -1].map(s => {
    const { p, n } = surf(s * .3, .12, -.015);
    const g = new THREE.Group(); g.position.copy(p); g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n); squash.add(g);
    const disc = ball(.125, M.eye, 1, 1, .28, 40); at(disc, 0, 0, 0, g);
    const pupil = ball(.058, M.pupil, 1, 1, .3, 28); at(pupil, 0, 0, .03, g);
    const glint = ball(.016, M.glint, 1, 1, .3, 12); at(glint, .02, .02, .05, g);
    g.userData = { pupil, glint, base: g.scale.clone() }; return g;
  });

  // mouth: only exists while talking. mouthG is scaled 0 -> 1 with a springy pop; mouth ellipse opens with the audio level
  const mG = at(new THREE.Group(), 0, 0, 0, squash);
  { const { p, n } = surf(0, -.2, -.012); mG.position.copy(p); mG.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n); }
  const mouth = at(ball(1, M.mouth, 1, 1, .12, 32), 0, 0, 0, mG);
  const tongue = at(ball(1, M.tongue, .62, .42, .12, 24), 0, -.5, .45, mouth);
  mG.scale.setScalar(0); mG.visible = false;

  // antennae: curved stalks with rounded tips, pivoting at the crown
  const antenna = [1, -1].map(s => {
    const pivot = at(new THREE.Group(), s * .2, BR.y * .93, -.02, squash);
    const curve = new THREE.CatmullRomCurve3([[0, -.04, 0], [s * .04, .14, 0], [s * .13, .27, 0], [s * .27, .33, 0], [s * .38, .32, 0]].map(a => new THREE.Vector3(...a)));
    const st = new THREE.Mesh(new THREE.TubeGeometry(curve, 32, .036, 14, false), M.body); st.castShadow = true; pivot.add(st);
    const tip = at(ball(.044, M.body, 1, 1, 1, 20), s * .385, .32, 0, pivot); tip.castShadow = true;
    pivot.userData.s = s; return pivot;
  });

  // mitten hands
  const hands = [1, -1].map(s => {
    const arm = at(new THREE.Group(), s * (BR.x - .02), -.08, .06, squash);
    const m = at(ball(.2, M.mitt, 1, 1.12, .9, 40), s * .13, -.06, .04, arm); m.rotation.z = s * -.25; m.userData.zone = 'body';
    at(ball(.085, M.mitt, 1, 1.1, .9, 24), s * .27, .05, .08, arm);                      // thumb bump
    arm.userData.s = s; return arm;
  });

  // soft shadow on the seat (the real sun shadow also falls from the floating body)
  const tex = (() => { const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'), r = g.createRadialGradient(64, 64, 4, 64, 64, 64); r.addColorStop(0, 'rgba(40,12,8,.5)'); r.addColorStop(1, 'rgba(40,12,8,0)'); g.fillStyle = r; g.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c); })();
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 1.7).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  blob.position.set(0, SEAT + .056, .25); scene.add(blob);

  root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  bench.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { root, float, squash, body, eyes, mouthG: mG, mouth, tongue, antenna, hands, blob, bench, REST_Y, SEAT };
}
