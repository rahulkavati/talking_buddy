// Post-processing: single scene render (MSAA + depth texture) -> gather depth-of-field -> bloom -> tone map -> grade.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

class DOFPass extends Pass {
  constructor(camera) {
    super();
    this.camera = camera;
    this.uniforms = {
      tDiffuse: { value: null }, tDepth: { value: null }, texel: { value: new THREE.Vector2() },
      focus: { value: 7 }, range: { value: 4 }, maxCoc: { value: 9 }, near: { value: camera.near }, far: { value: camera.far },
    };
    this.quad = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
      fragmentShader: /* glsl */`
        #include <packing>
        uniform sampler2D tDiffuse,tDepth;uniform vec2 texel;uniform float focus,range,maxCoc,near,far;varying vec2 vUv;
        float viewZ(vec2 uv){float d=texture2D(tDepth,uv).x;return -perspectiveDepthToViewZ(d,near,far);}
        float coc(float z){
          float d=z-focus;
          // foreground blurs a bit harder than background, like a fast lens
          float k=d<0.?abs(d)/(range*.55):abs(d)/(range*1.6);
          return clamp(k,0.,1.)*maxCoc;
        }
        void main(){
          float z=viewZ(vUv);float c0=coc(z);
          vec3 acc=texture2D(tDiffuse,vUv).rgb;float wsum=1.;
          const int N=26;float ga=2.39996323;
          for(int i=1;i<=N;i++){
            float fi=float(i);float r=sqrt(fi/float(N));float a=fi*ga;
            vec2 o=vec2(cos(a),sin(a))*r;
            // sample radius uses this pixel's CoC, samples are rejected if they are sharp and behind the centre (avoids halos)
            vec2 uv=vUv+o*c0*texel;
            float zs=viewZ(uv);float cs=coc(zs);
            float w=(zs<z)?1.:smoothstep(0.,1.,cs/max(r*c0,.001));
            w=max(w,c0>.5?.0:1.);
            vec3 s=texture2D(tDiffuse,uv).rgb;
            // bokeh weighting: brighter samples bloom slightly
            float lum=dot(s,vec3(.333));w*=1.+lum*lum*.6;
            acc+=s*w;wsum+=w;
          }
          gl_FragColor=vec4(acc/wsum,1.);
        }`,
    }));
  }
  setSize(w, h) { this.uniforms.texel.value.set(1 / w, 1 / h); }
  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.tDepth.value = readBuffer.depthTexture;
    this.uniforms.near.value = this.camera.near; this.uniforms.far.value = this.camera.far;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
  dispose() { this.quad.material.dispose(); this.quad.dispose(); }
}

export function createPost(renderer, scene, camera, w, h) {
  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
  rt.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  const dof = new DOFPass(camera); composer.addPass(dof);
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), .28, .6, .88));
  composer.addPass(new OutputPass());
  const grade = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, t: { value: 0 } },
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `uniform sampler2D tDiffuse;uniform float t;varying vec2 vUv;
      float h(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233))+t)*43758.5453);}
      void main(){vec3 c=texture2D(tDiffuse,vUv).rgb;
        float l=dot(c,vec3(.299,.587,.114));c=mix(vec3(l),c,1.06);
        c=mix(c,c*c*(3.-2.*c),.18);                                  // soft S-curve
        c=mix(c,c*vec3(1.04,1.,.93),.5);                              // warm golden-hour grade
        float v=smoothstep(.98,.3,distance(vUv,vec2(.5,.52)));c*=mix(.9,1.,v);
        c+=(h(vUv*900.)-.5)*.014;gl_FragColor=vec4(c,1.);}`,
  });
  composer.addPass(grade);
  return {
    composer, dof, grade,
    setSize(w, h) { composer.setSize(w, h); dof.setSize(w, h); },
  };
}
