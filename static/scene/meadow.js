// Soft Meadow: rolling terrain, ~100k curved sun-rimmed grass blades in leaning tufts, clay daisies, bubble trees.
import * as THREE from 'three';
import { SUN_DIR, LIGHT_DIR } from './sky.js';

const TAU = Math.PI * 2, sn = Math.sin;
const C = h => new THREE.Color(h);
// deterministic RNG so the meadow looks identical every load (and in screenshots)
let seed = 1337; const R = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const rnd = (a, b) => a + R() * (b - a);
const gauss = () => (R() + R() + R() - 1.5) / .75;
const ss = THREE.MathUtils.smoothstep;

export const HAZE = C(0xd9b89a);
export const windU = { value: 0 };

// ground height: flat around the buddy, soft rolling hills further out
export const hgt = (x, z) => {
  const r = Math.hypot(x, z), far = ss(r, 9, 70);
  const hills = (sn(x * .045 + 1.3) * .5 + Math.cos(z * .038 + x * .02) * .5 + sn(x * .1 - z * .06) * .22) * 6.5 * far;
  const near = sn(x * .33) * sn(z * .29) * .1 * ss(r, 2.5, 8);
  return hills + near;
};

// area kept short around the bench so blades never pierce the character
export const BENCH = { x: 0, z: .3, hx: 1.7, hz: .95 };
const benchDist = (x, z) => { const dx = Math.max(Math.abs(x - BENCH.x) - BENCH.hx, 0), dz = Math.max(Math.abs(z - BENCH.z) - BENCH.hz, 0); return Math.hypot(dx, dz); };
// grass height envelope: short through the centre (so the buddy reads clearly), tall framing the sides & near the lens
const heightEnv = (x, z) => {
  const side = ss(Math.abs(x), 1.6, 4.6), lens = ss(z, 4.2, 7.6);
  let h = .5 + side * .85 + lens * (.2 + side * .6) + ss(z, -6, 0) * .0;
  h *= .45 + .55 * ss(benchDist(x, z), .15, 1.6);
  return h;
};

export function buildMeadow(scene, quality = 1) {
  /* ---------- terrain ---------- */
  const tg = new THREE.PlaneGeometry(560, 560, 220, 220).rotateX(-Math.PI / 2);
  const tp = tg.attributes.position, tc = [];
  for (let i = 0; i < tp.count; i++) tp.setY(i, hgt(tp.getX(i), tp.getZ(i)));
  tg.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(tp.count * 3).fill(1), 3));
  tg.computeVertexNormals();
  const groundMat = new THREE.MeshStandardMaterial({ roughness: 1, color: 0xffffff, vertexColors: true });
  groundMat.onBeforeCompile = sh => {
    sh.uniforms.uSun = { value: LIGHT_DIR };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvWP=(modelMatrix*vec4(position,1.)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vWP;
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
      {
        vec2 q=vWP.xz;float r=length(q);
        // blade-streak noise stretched along the wind direction, plus broad patches of gold / deep olive
        float st=vn(vec2(q.x*.9+q.y*.35,q.y*3.4))*.55+vn(vec2(q.x*.28,q.y*.9))*.45;
        float pch=vn(q*.07)*.6+vn(q*.19+7.)*.4;
        vec3 deep=vec3(.075,.095,.03),olive=vec3(.2,.235,.07),gold=vec3(.46,.40,.14),hz=vec3(.43,.4,.24);
        vec3 g=mix(deep,olive,smoothstep(.2,.8,st));g=mix(g,gold,smoothstep(.45,.9,pch)*.55);
        g=mix(g,hz,smoothstep(70.,210.,r)*.55);              // distant hills fade toward soft haze
        diffuseColor.rgb=g;
      }`);
  };
  const ground = new THREE.Mesh(tg, groundMat); ground.receiveShadow = true; scene.add(ground);

  /* ---------- grass blades (instanced, shader-driven) ---------- */
  const SEG = 7, bv = [], bi = [];
  for (let i = 0; i < SEG; i++) bv.push(-1, i / SEG, 0, 1, i / SEG, 0);
  bv.push(0, 1, 0);
  for (let i = 0; i < SEG - 1; i++) { const a = i * 2; bi.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  bi.push((SEG - 1) * 2, (SEG - 1) * 2 + 1, SEG * 2);
  const bgeo = new THREE.InstancedBufferGeometry();
  bgeo.setAttribute('position', new THREE.Float32BufferAttribute(bv, 3)); bgeo.setIndex(bi);

  const pos = [], par = [], rr = [];
  const TUFTS = Math.floor(12000 * quality);
  const windYaw = Math.atan2(1, .28), CAMZ = 7.4;
  for (let n = 0; n < TUFTS; n++) {
    // sample in a fan around the lens: equal numbers per octave of distance => dense and sharp up close, carpet-like far away
    const d = .9 * Math.pow(80 / .9, Math.pow(R(), 1.2)), phi = (R() * 2 - 1) * 1.12;
    const x = Math.sin(phi) * d, z = CAMZ - Math.cos(phi) * d, r = Math.hypot(x, z);
    if (benchDist(x, z) < .05) continue;
    const y = hgt(x, z), env = heightEnv(x, z) * (1 + ss(r, 10, 45) * 1.1);
    const sizeScale = 1 + ss(r, 6, 45) * 1.8;
    const lean = sn(x * .21 + z * .17) * .7 + sn(x * .08 - z * .13) * .6;       // patches of different lean direction
    const K = 6 + Math.floor(R() * 8), tone = R(), tuftH = env * rnd(.75, 1.25);
    for (let k = 0; k < K; k++) {
      const off = Math.abs(gauss()) * .12 * sizeScale, oa = R() * TAU;
      const aligned = R() < .75;
      const yaw = (aligned ? windYaw + lean * .6 + gauss() * .45 : R() * TAU);
      const H = tuftH * rnd(.6, 1.25) * 1.3, W = rnd(.055, .1) * sizeScale * (.8 + H * .2);
      const bend = rnd(.55, 1.9) * (.55 + H * .45);
      pos.push(x + Math.cos(oa) * off, y, z + Math.sin(oa) * off);
      par.push(H, W, yaw, bend);
      rr.push(R() * TAU, Math.min(1, Math.max(0, tone + gauss() * .18)), R(), R());
    }
  }
  const GN = pos.length / 3;
  bgeo.setAttribute('aPos', new THREE.InstancedBufferAttribute(new Float32Array(pos), 3));
  bgeo.setAttribute('aP', new THREE.InstancedBufferAttribute(new Float32Array(par), 4));
  bgeo.setAttribute('aR', new THREE.InstancedBufferAttribute(new Float32Array(rr), 4));
  bgeo.instanceCount = GN;

  const grassMat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide, fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uT: windU, uSun: { value: LIGHT_DIR.clone() },
      root: { value: C(0x34471a) }, body: { value: C(0x6c8a30) }, light: { value: C(0x9fb040) }, gold: { value: C(0xffe48a) }, warm: { value: C(0xffd98c) }, amb: { value: C(0xcfc596) },
      shC: { value: new THREE.Vector4(-.35, .75, 1.7, 1.25) },
    }]),
    vertexShader: /* glsl */`
      attribute vec3 aPos;attribute vec4 aP;attribute vec4 aR;
      uniform float uT;varying float vT,vSide,vTone,vSeed;varying vec3 vN,vWP;
      #include <fog_pars_vertex>
      void main(){
        float t=position.y,side=position.x;
        float H=aP.x,W=aP.y,yaw=aP.z,bend=aP.w;
        // travelling gust field + per-blade flutter
        float g=sin(uT*1.15+aPos.x*.16+aPos.z*.1)*.5+sin(uT*.62-aPos.x*.05+aPos.z*.19)*.5;
        float gust=.55+.45*g;
        float flut=sin(uT*3.1+aR.x+aPos.x*.7)*.5+sin(uT*4.7+aR.x*1.7)*.5;
        float b=max(bend+gust*.55+flut*.07*t,.02);
        float th=b*t;                                     // constant-curvature arc, keeps blade length
        float rad=H/b;
        vec3 lp=vec3(0.);
        lp.y=rad*sin(th);lp.z=rad*(1.-cos(th));
        float taper=(.55+.45*sin(min(t*3.4,1.5708)))*(1.-pow(t,1.7));   // leaf profile: widest near the base, long pointed tip
        lp.x=side*W*taper*(.9+.1*sin(t*6.+aR.x));
        // subtle twist of the ribbon
        float tw=(aR.z-.5)*.7*t;lp.x*=cos(tw);lp.z+=side*W*taper*sin(tw)*.5;
        float c=cos(yaw),s=sin(yaw);
        vec3 wp=vec3(lp.x*c+lp.z*s,lp.y,-lp.x*s+lp.z*c)+aPos;
        // normal of the arc in local space (front face) rotated by yaw
        vec3 ln=vec3(0.,-sin(th),cos(th));
        vN=vec3(ln.x*c+ln.z*s,ln.y,-ln.x*s+ln.z*c);
        vT=t;vSide=side;vTone=aR.y;vSeed=aR.z;vWP=wp;
        vec4 mvPosition=modelViewMatrix*vec4(wp,1.);
        gl_Position=projectionMatrix*mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSun,root,body,light,gold,warm,amb;uniform vec4 shC;
      varying float vT,vSide,vTone,vSeed;varying vec3 vN,vWP;
      #include <fog_pars_fragment>
      void main(){
        vec3 n=normalize(vN);if(!gl_FrontFacing)n=-n;
        vec3 V=normalize(cameraPosition-vWP);vec3 L=normalize(uSun);
        float t=vT;
        // body colour: dark olive root -> mid olive -> yellow-green tip, with per-tuft tone variation
        vec3 tone=mix(body*vec3(.9,.96,.85),body*vec3(1.12,1.04,.8),vTone);
        vec3 col=mix(root,tone,smoothstep(0.,.5,t));
        col=mix(col,light*mix(vec3(.9,1.,.85),vec3(1.1,1.,.75),vTone),smoothstep(.45,1.,t)*.8);
        // centre-vein: slightly deeper in the middle of the blade
        col*=1.-.16*(1.-abs(vSide))*smoothstep(.05,.5,t);
        // sun comes from behind/right: wrap diffuse + translucent glow when we look into it
        float wrap=clamp(dot(n,L)*.5+.5,0.,1.);
        float trans=pow(clamp(dot(-V,L),0.,1.),2.2)*(.35+.65*abs(dot(n,V)));
        vec3 lit=col*(amb*.55+warm*(wrap*.42+trans*.95));
        // thin golden rim along the blade edge that faces the sun, strongest toward the tip
        float edge=smoothstep(.55,1.,abs(vSide));
        float facing=clamp(dot(vec3(n.x,0.,n.z),vec3(L.x,0.,L.z))*1.4+.45,0.,1.);
        float rim=edge*(.25+.75*smoothstep(.15,.9,t))*facing;
        lit+=gold*rim*1.9;
        lit+=gold*pow(1.-abs(dot(n,V)),3.)*.12*smoothstep(.3,1.,t);
        // ambient occlusion toward the root + contact shadow of the buddy
        lit*=mix(.28,1.,smoothstep(0.,.55,t));
        vec2 d=(vWP.xz-shC.xy)/shC.zw;lit*=1.-.55*smoothstep(1.,.15,length(d));
        gl_FragColor=vec4(lit,1.);
        #include <fog_fragment>
      }`,
  });
  const grass = new THREE.Mesh(bgeo, grassMat); grass.frustumCulled = false; scene.add(grass);

  /* ---------- clay daisies ---------- */
  const petalGeo = (() => {
    const parts = [], col = [], NP = 6;
    const push = (g, fn) => { g = g.toNonIndexed(); const pa = g.attributes.position; for (let i = 0; i < pa.count; i++) col.push(...fn(pa.getY(i))); parts.push(g); };
    for (let p = 0; p < NP; p++) {
      const g = new THREE.SphereGeometry(1, 20, 14); g.scale(.085, .028, .052);
      g.translate(.105, .004, 0); g.rotateZ(.09); g.rotateY(p / NP * TAU + .25);
      // cream-white top, soft lavender-grey underside baked into vertex colour
      push(g, y => { const k = ss(y, -.02, .03); return [.78 + .2 * k, .75 + .23 * k, .78 + .17 * k]; });
    }
    const ctr = new THREE.SphereGeometry(1, 20, 14); ctr.scale(.062, .036, .062); ctr.translate(0, .02, 0);
    push(ctr, () => [.93, .66, .1]);
    const merged = mergeGeos(parts);
    merged.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    merged.rotateX(.95);       // face tilts toward the camera
    return merged;
  })();
  const stemGeo = (() => { const g = new THREE.CylinderGeometry(.009, .013, 1, 6, 8, true); g.translate(0, .5, 0); return g; })();
  const swayShader = (sh, isStem) => {
    sh.uniforms.uT = windU;
    sh.vertexShader = 'uniform float uT;attribute float aH;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      float yy=${isStem ? 'position.y*aH' : 'aH'};
      vec4 ip=instanceMatrix[3];
      float gg=(sin(uT*1.15+ip.x*.16+ip.z*.1)*.5+sin(uT*.62-ip.x*.05+ip.z*.19)*.5)*.5+.55;
      float sw=gg*yy*yy*.55+sin(uT*2.3+ip.x*3.)*.02*yy;
      ${isStem ? 'transformed.y=position.y*aH;' : 'transformed.y+=aH;'}
      transformed.x+=sw;transformed.z+=sw*.2;`);
  };
  const FN = Math.floor(340 * quality);
  const heads = new THREE.InstancedMesh(petalGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .62, emissive: 0x2a2018, emissiveIntensity: .35 }), FN);
  const stems = new THREE.InstancedMesh(stemGeo, new THREE.MeshStandardMaterial({ color: 0x7e9a3c, roughness: .9 }), FN);
  heads.material.onBeforeCompile = sh => swayShader(sh, false); stems.material.onBeforeCompile = sh => swayShader(sh, true);
  const aH = new Float32Array(FN), o = new THREE.Object3D();
  let placed = 0;
  for (let tries = 0; placed < FN && tries < FN * 12; tries++) {
    const d = 2.4 * Math.pow(34 / 2.4, Math.pow(R(), 1.1)), phi = (R() * 2 - 1) * .95, x = Math.sin(phi) * d, z = CAMZ - Math.cos(phi) * d, r = Math.hypot(x, z);
    if (benchDist(x, z) < .6) continue;
    const env = heightEnv(x, z) * (1 + ss(r, 10, 45) * 1.1), H = env * rnd(.85, 1.3) + .1, s = .62 * (1 + ss(r, 6, 45) * 2.0) * rnd(.85, 1.25);
    aH[placed] = H;
    o.position.set(x, hgt(x, z), z); o.rotation.set(0, rnd(-.7, .7), 0); o.scale.setScalar(s); o.updateMatrix();
    heads.setMatrixAt(placed, o.matrix); stems.setMatrixAt(placed, o.matrix); placed++;
  }
  heads.count = stems.count = placed;
  heads.geometry.setAttribute('aH', new THREE.InstancedBufferAttribute(aH, 1)); stems.geometry.setAttribute('aH', new THREE.InstancedBufferAttribute(aH, 1));
  heads.frustumCulled = stems.frustumCulled = false; heads.castShadow = false;
  scene.add(stems, heads);

  /* ---------- soft far hills (mauve-olive, hazed) ---------- */
  const hillMat = new THREE.ShaderMaterial({ fog: false,     uniforms: { sunDir: { value: SUN_DIR.clone() }, base: { value: C(0x8d9068) }, hazeC: { value: C(0xe8bf98) }, far: { value: 0 } },
    vertexShader: 'varying vec3 vP,vN;void main(){vP=(modelMatrix*vec4(position,1.)).xyz;vN=normalize(mat3(modelMatrix)*normal);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `uniform vec3 sunDir,base,hazeC;uniform float far;varying vec3 vP,vN;
      void main(){float k=smoothstep(-2.,22.,vP.y);vec3 c=mix(base*.85,base*1.12,k);
        float s=pow(max(dot(normalize(vec3(vP.x,0.,vP.z)),normalize(vec3(sunDir.x,0.,sunDir.z))),0.),4.);
        c=mix(c,hazeC,.35+far*.35+s*.25);c+=vec3(.12,.07,0.)*s*k;gl_FragColor=vec4(c,1.);}` });
  [[-150, -215, 120, 14, 40, 0], [70, -240, 160, 16, 50, 1], [190, -200, 100, 12, 36, 0], [-20, -170, 90, 8, 28, 0]].forEach(([x, z, sx, sy, sz, f], i) => {
    const h = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 20), hillMat.clone()); h.material.uniforms.far.value = f; h.material.uniforms.base.value = C(i % 2 ? 0x9a8c70 : 0x8a8f66);
    h.scale.set(sx, sy, sz); h.position.set(x, -3, z); scene.add(h);
  });

  /* ---------- bubble trees (rounded olive clay clumps on the hills) ---------- */
  const leaf = [0x9aa45a, 0x8a964c, 0x76843f, 0x66752f].map(c => new THREE.MeshStandardMaterial({ color: c, roughness: .85, emissive: c, emissiveIntensity: .08 }));
  const trunk = new THREE.MeshStandardMaterial({ color: 0x7a5f4a, roughness: .9 });
  const tree = (x, z, s) => {
    const g = new THREE.Group(); g.position.set(x, hgt(x, z) - .2 * s, z);
    const t = new THREE.Mesh(new THREE.CylinderGeometry(.16 * s, .22 * s, 1.6 * s, 10), trunk); t.position.y = .5 * s; g.add(t);
    const n = 3 + Math.floor(R() * 3);
    for (let i = 0; i < n; i++) {
      const rr2 = (.75 + R() * .55) * s, b = new THREE.Mesh(new THREE.SphereGeometry(rr2, 28, 20), leaf[i % 4]);
      const ang = i / n * TAU + R(); b.position.set(Math.cos(ang) * .8 * s * (i ? 1 : 0), (1.7 + (i ? R() * .8 : 1.1)) * s, Math.sin(ang) * .8 * s * (i ? 1 : 0)); b.scale.y = .9; g.add(b);
    }
    scene.add(g);
  };
  [[-17.5, -26, 3.4], [-12.5, -22, 2.5], [-22, -30, 3.2], [-19, -20, 2.2]].forEach(a => tree(...a));              // big clump, left edge
  [[-3, -44, 2.4], [2.5, -46, 2.9], [8, -45, 2.1], [-8, -40, 1.9], [13, -48, 2.2], [-14, -48, 2.4]].forEach(a => tree(...a));  // horizon row
  [[22, -30, 2.9], [27, -33, 3.3], [30, -27, 2.5], [25, -24, 2], [34, -36, 3]].forEach(a => tree(...a));           // right clump by the sun
  for (let i = 0; i < 14; i++) tree(rnd(-60, 60), rnd(-90, -55), rnd(2.5, 4.5));

  return { ground, grass, update(t) { windU.value = t; }, stats: { blades: GN, flowers: placed } };
}

// tiny geometry merge (avoids importing BufferGeometryUtils for one use)
function mergeGeos(list) {
  const pos = [], nor = [], idx = []; let off = 0;
  for (const g0 of list) {
    const g = g0;
    const p = g.attributes.position.array, n = g.attributes.normal.array;
    for (let i = 0; i < p.length; i++) { pos.push(p[i]); nor.push(n[i]); }
    for (let i = 0; i < p.length / 3; i++) idx.push(off + i);
    off += p.length / 3;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return out;
}
