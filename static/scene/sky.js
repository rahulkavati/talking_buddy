// Sunset sky dome (mauve -> peach -> gold), soft sun, puffy clay clouds and drifting sun-motes.
import * as THREE from 'three';

// visual sun disc sits low and right of centre (like the reference); the light that shades things is art-directed a bit higher
export const SUN_DIR = new THREE.Vector3(Math.sin(.3) * Math.cos(.17), Math.sin(.17), -Math.cos(.3) * Math.cos(.17)).normalize();
export const LIGHT_DIR = new THREE.Vector3(.34, .44, -.83).normalize();
const rnd = (a, b) => a + Math.random() * (b - a);
const C = h => new THREE.Color(h);

export function buildSky(scene) {
  // ---- gradient dome with analytic sun + halo ----
  const dome = new THREE.Mesh(new THREE.SphereGeometry(300, 48, 24), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { gain: { value: 1. }, glowK: { value: .25 }, sunDir: { value: SUN_DIR.clone() }, top: { value: C(0xbda8b8) }, mid: { value: C(0xefbaa2) }, low: { value: C(0xf8cf8a) }, glow: { value: C(0xffc870) }, core: { value: C(0xfffbe6) } },
    vertexShader: 'varying vec3 vD;void main(){vD=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `uniform vec3 sunDir,top,mid,low,glow,core;uniform float gain,glowK;varying vec3 vD;
      void main(){
        vec3 d=normalize(vD);float h=clamp(d.y,0.,1.);
        vec3 c=mix(low,mid,smoothstep(0.,.09,h));c=mix(c,top,smoothstep(.07,.3,h));
        float s=max(dot(d,sunDir),0.);
        c+=glow*pow(s,6.)*glowK+glow*pow(s,40.)*.35;                      // wide warm glow + tighter halo
        c=mix(c,core,smoothstep(.99935,.99975,s));                     // soft disc
        c+=core*pow(s,900.)*.8;
        c=mix(c,low*.92,1.-smoothstep(-.12,0.,d.y));                      // below horizon blends to haze
        float sunMask=smoothstep(.9990,.99975,dot(d,sunDir));
        c=c*gain;c=mix(c,vec3(1.,.95,.7)*1.35,sunMask);              // lift sky out of the tonemapper's mud; disc blows out to white-gold
        gl_FragColor=vec4(c,1.);}`,
  }));
  scene.add(dome);

  // ---- clay clouds: flat-bottomed clusters of spheres, shaded pink-mauve -> cream-peach ----
  const cloudMat = new THREE.ShaderMaterial({
    fog: false,
    uniforms: { sunDir: { value: SUN_DIR.clone() }, lit: { value: C(0xffe4d6) }, mid: { value: C(0xf0c2bc) }, dark: { value: C(0xd2a8b4) }, warm: { value: C(0xffd8a8) } },
    vertexShader: 'varying vec3 vN;void main(){vN=normalize(mat3(modelMatrix)*normal);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `uniform vec3 sunDir,lit,mid,dark,warm;varying vec3 vN;
      void main(){vec3 n=normalize(vN);float up=n.y*.5+.5;float sun=max(dot(n,sunDir),0.);
        vec3 c=mix(dark,mid,smoothstep(.15,.6,up));c=mix(c,lit,smoothstep(.55,1.,up));
        c=mix(c,warm,pow(sun,2.)*.55);gl_FragColor=vec4(c,1.);}`,
  });
  const clouds = [];
  const mkCloud = (x, y, z, s, lobes) => {
    const g = new THREE.Group();
    lobes.forEach(([dx, dy, r]) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 20), cloudMat); m.position.set(dx, dy, 0); m.scale.set(1, .86, .7); g.add(m); });
    // flat soft base
    const base = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), cloudMat); base.scale.set(lobes.reduce((a, l) => Math.max(a, Math.abs(l[0]) + l[2]), 0) * 1.02, 3.2, 7); base.position.y = -2.2; g.add(base);
    g.position.set(x, y, z); g.scale.setScalar(s); g.lookAt(0, 6, 0); scene.add(g); clouds.push(g); return g;
  };
  mkCloud(-78, 40, -170, 1.7, [[-14, 0, 9], [-2, 5, 13], [11, 1, 10], [22, -1, 7]]);      // big cloud top-left
  mkCloud(-20, 26, -210, .7, [[-6, 0, 6], [3, 2, 8], [11, 0, 5]]);
  mkCloud(120, 56, -175, 1.45, [[-12, -1, 8], [-1, 6, 12], [11, 0, 9]]);                   // top-right, over the sun
  mkCloud(40, 22, -230, .6, [[-8, 0, 5], [0, 1.5, 7], [9, 0, 4]]);
  mkCloud(8, 52, -190, 1.0, [[-10, 0, 7], [2, 3, 9], [13, 0, 6]]);

  // ---- floating sun-motes (pollen) ----
  const dotTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 32; const g = c.getContext('2d'), r = g.createRadialGradient(16, 16, 0, 16, 16, 16); r.addColorStop(0, 'rgba(255,240,190,1)'); r.addColorStop(1, 'rgba(255,240,190,0)'); g.fillStyle = r; g.fillRect(0, 0, 32, 32); return new THREE.CanvasTexture(c); })();
  const PN = 160, pp = new Float32Array(PN * 3), pv = new Float32Array(PN);
  for (let i = 0; i < PN; i++) { pp.set([rnd(-9, 9), rnd(.2, 4), rnd(-10, 6)], i * 3); pv[i] = rnd(.04, .16); }
  const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(pp, 3));
  scene.add(new THREE.Points(pg, new THREE.PointsMaterial({ size: .09, map: dotTex, transparent: true, opacity: .8, depthWrite: false, blending: THREE.AdditiveBlending })));

  return {
    dome,
    update(t, dt) {
      clouds.forEach((c, i) => { c.position.x += dt * (.25 + i * .04); if (c.position.x > 150) c.position.x = -150; });
      const p = pg.attributes.position.array;
      for (let i = 0; i < PN; i++) { p[i * 3 + 1] += pv[i] * dt; p[i * 3] += Math.sin(t * .5 + i) * dt * .15; if (p[i * 3 + 1] > 5) p[i * 3 + 1] = .2; }
      pg.attributes.position.needsUpdate = true;
    },
  };
}
