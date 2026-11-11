import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';

// This layer sits behind the VRM renderer so the avatar remains the visual focus.
const host = document.getElementById('canvas-container');
const foreground = host.querySelector('canvas');
const canvas = document.createElement('canvas');
canvas.className = 'environment-canvas';
canvas.style.cssText = 'position:absolute;inset:0;z-index:0;pointer-events:none';
host.insertBefore(canvas, foreground);

// Render a posed copy above the environment. The original renderer is kept
// hidden so the imported T-pose cannot remain visible underneath it.
const avatarCanvas = document.createElement('canvas');
avatarCanvas.className = 'avatar-canvas';
avatarCanvas.style.cssText = 'position:absolute;inset:0;z-index:1;pointer-events:none';
host.insertBefore(avatarCanvas, foreground);
if (foreground) foreground.style.visibility = 'hidden';
const avatarRenderer = new THREE.WebGLRenderer({ canvas: avatarCanvas, antialias: true, alpha: true });
avatarRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
avatarRenderer.setSize(innerWidth, innerHeight);
avatarRenderer.outputColorSpace = THREE.SRGBColorSpace;
avatarRenderer.toneMapping = THREE.ACESFilmicToneMapping;
avatarRenderer.toneMappingExposure = 1.15;
const avatarScene = new THREE.Scene();
const avatarCamera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, .1, 100);
avatarCamera.position.set(0, 1.35, 5.25);
avatarCamera.lookAt(0, 1.2, 0);
avatarScene.add(new THREE.HemisphereLight(0xffe5d5, 0x160707, 2.3));
const avatarKey = new THREE.DirectionalLight(0xffb58e, 3);
avatarKey.position.set(-2, 4, 3);
avatarScene.add(avatarKey);
let posedVrm = null;
let speaking = false;
const avatarLoader = new GLTFLoader();
avatarLoader.register(parser => new VRMLoaderPlugin(parser));
avatarLoader.load('/static/CoolAlien.vrm', gltf => {
  posedVrm = gltf.userData.vrm;
  avatarScene.add(posedVrm.scene);
  const box = new THREE.Box3().setFromObject(posedVrm.scene);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  posedVrm.scene.position.y -= center.y - size.y * .5;
  posedVrm.scene.rotation.y = Math.PI;
}, undefined, error => console.error('Posed VRM load failed', error));
window.animateSpeaking = value => { speaking = value; };
const bone = name => posedVrm?.humanoid?.getNormalizedBoneNode(name);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x0b2224, 9, 62);
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, .1, 180);
camera.position.set(0, 2.7, 6.8);
camera.lookAt(0, 1.8, -12);
scene.add(new THREE.HemisphereLight(0xc7fff0, 0x061316, 2.1));
const sun = new THREE.DirectionalLight(0xbaffea, 3.2);
sun.position.set(-8, 12, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -12;
sun.shadow.camera.right = 12;
sun.shadow.camera.top = 12;
sun.shadow.camera.bottom = -4;
scene.add(sun);
const glow = new THREE.PointLight(0xff6fae, 4.5, 24);
glow.position.set(0, 2, -9);
scene.add(glow);

// A deep star sky with slow twinkle rather than a flat background image.
const starCount = 900;
const starPositions = new Float32Array(starCount * 3);
for (let i = 0; i < starCount; i++) {
  starPositions[i * 3] = (Math.random() - .5) * 95;
  starPositions[i * 3 + 1] = Math.random() * 34 + 3;
  starPositions[i * 3 + 2] = -Math.random() * 90 - 6;
}
const starGeometry = new THREE.BufferGeometry();
starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
const starMaterial = new THREE.PointsMaterial({ color: 0xd7fff0, size: .075, transparent: true, opacity: .85 });
scene.add(new THREE.Points(starGeometry, starMaterial));

// A softly undulating terrain replaces the artificial grid. Dust motion keeps the
// world alive without making it look like a computer floor.
const terrainGeometry = new THREE.PlaneGeometry(90, 110, 120, 150);
const terrainPositions = terrainGeometry.attributes.position;
for (let i = 0; i < terrainPositions.count; i++) {
  const x = terrainPositions.getX(i);
  const z = terrainPositions.getY(i);
  const dune = Math.sin(x * .11 + Math.sin(z * .06)) * .24 + Math.cos(z * .16) * .12;
  const detail = Math.sin(x * .65 + z * .4) * .018;
  terrainPositions.setY(i, dune + detail);
}
terrainGeometry.computeVertexNormals();
terrainGeometry.rotateX(-Math.PI / 2);
const ground = new THREE.Mesh(terrainGeometry, new THREE.MeshStandardMaterial({
  color: 0x173d3a, roughness: .93, metalness: .02
}));
ground.position.set(0, -.25, -34);
ground.receiveShadow = true;
scene.add(ground);

// Layered mesas at the horizon create depth through atmospheric perspective.
const mesaMaterial = new THREE.MeshStandardMaterial({ color: 0x102c2c, roughness: 1 });
for (let i = 0; i < 12; i++) {
  const mesa = new THREE.Mesh(new THREE.ConeGeometry(1.8 + Math.random() * 2.8, 2.2 + Math.random() * 2.2, 7), mesaMaterial);
  mesa.position.set((i - 5.5) * 2.8, .3, -18 - Math.random() * 13);
  mesa.scale.x = 1.4 + Math.random();
  mesa.scale.z = .6 + Math.random() * .6;
  mesa.rotation.y = Math.random() * Math.PI;
  mesa.castShadow = true;
  scene.add(mesa);
}

const dustGeometry = new THREE.BufferGeometry();
const dustPositions = new Float32Array(360 * 3);
const dustSpeed = new Float32Array(360);
for (let i = 0; i < 360; i++) {
  dustPositions[i * 3] = (Math.random() - .5) * 22;
  dustPositions[i * 3 + 1] = Math.random() * 4;
  dustPositions[i * 3 + 2] = Math.random() * -38;
  dustSpeed[i] = .025 + Math.random() * .045;
}
dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
scene.add(new THREE.Points(dustGeometry, new THREE.PointsMaterial({ color: 0xff8fc5, size: .035, transparent: true, opacity: .42 })));

// Low-poly horizon rocks echo the uploaded ARES reference without hiding the avatar.
const rockMaterial = new THREE.MeshStandardMaterial({ color: 0x28514b, roughness: .96 });
for (let i = 0; i < 34; i++) {
  const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(.22 + Math.random() * .7, 2), rockMaterial);
  const side = i % 2 ? -1 : 1;
  rock.position.set(side * (3 + Math.random() * 9), -.05, -4 - Math.random() * 17);
  rock.scale.y = .45 + Math.random() * .8;
  rock.rotation.set(Math.random(), Math.random(), Math.random());
  rock.castShadow = true;
  rock.receiveShadow = true;
  scene.add(rock);
}

const clock = new THREE.Clock();
function loop() {
  requestAnimationFrame(loop);
  const dt = clock.getDelta();
  const p = dustGeometry.attributes.position.array;
  for (let i = 0; i < 360; i++) {
    p[i * 3] += dustSpeed[i] * dt * 2;
    p[i * 3 + 2] += dt * .06;
    if (p[i * 3] > 12) p[i * 3] = -12;
    if (p[i * 3 + 2] > 3) p[i * 3 + 2] = -38;
  }
  dustGeometry.attributes.position.needsUpdate = true;
  starMaterial.opacity = .72 + Math.sin(clock.elapsedTime * 1.7) * .14;
  // Expressive default idle: breathing, weight shift, and a relaxed curious sway.
  camera.position.x = Math.sin(clock.elapsedTime * .28) * .045;
  camera.position.y = 2.7 + Math.sin(clock.elapsedTime * .55) * .025;
  camera.lookAt(0, 1.8, -12);
  if (foreground) {
    const t = clock.elapsedTime;
    const sway = Math.sin(t * .55) * .18;
    const bob = Math.sin(t * .8) * .35;
    const tilt = Math.sin(t * .55 + .6) * .22;
    const breathe = 1 + Math.sin(t * 1.1) * .004;
    foreground.style.transform = `translateX(${sway}px) translateY(${bob}px) rotate(${tilt}deg) scale(${breathe})`;
  }
  if (posedVrm) {
    posedVrm.update(dt);
    const t = clock.elapsedTime;
    const hips = bone('hips');
    const chest = bone('chest');
    const head = bone('head');
    const leftArm = bone('leftUpperArm');
    const rightArm = bone('rightUpperArm');
    const leftForearm = bone('leftLowerArm');
    const rightForearm = bone('rightLowerArm');
    const leftLeg = bone('leftUpperLeg');
    const rightLeg = bone('rightUpperLeg');
    const leftShin = bone('leftLowerLeg');
    const rightShin = bone('rightLowerLeg');
    // Lower the arms from the imported T-pose into a relaxed conversational pose.
    if (leftArm) leftArm.rotation.z = .84 + Math.sin(t * .65) * .025;
    if (rightArm) rightArm.rotation.z = -.66 - Math.sin(t * .65) * .04;
    if (leftForearm) leftForearm.rotation.z = .18 + Math.sin(t * .8) * .02;
    if (rightForearm) rightForearm.rotation.z = -.06 - Math.sin(t * .8) * .03;
    if (hips) {
      hips.rotation.y = -.06 + Math.sin(t * .45) * .025;
      hips.rotation.z = .07 + Math.sin(t * .8) * .012;
    }
    if (chest) {
      chest.rotation.y = .035 + Math.sin(t * .5) * .018;
      chest.rotation.z = -.035 + Math.sin(t * .65) * .012;
    }
    if (leftLeg) leftLeg.rotation.z = -.035 + Math.sin(t * .5) * .012;
    if (rightLeg) rightLeg.rotation.z = .075 + Math.sin(t * .5) * .012;
    if (leftShin) leftShin.rotation.z = .018;
    if (rightShin) rightShin.rotation.z = -.045;
    if (head) {
      head.rotation.y = -.045 + Math.sin(t * .42) * .06;
      head.rotation.x = .035 + Math.sin(t * .7) * .025;
      head.rotation.z = -.035 + Math.sin(t * .55) * .018;
    }
    const expressions = posedVrm.expressionManager;
    if (expressions) {
      expressions.setValue('blink', Math.sin(t * .7) > .997 ? 1 : 0);
      expressions.setValue('a', speaking ? .18 + Math.abs(Math.sin(t * 11)) * .45 : 0);
      expressions.update();
    }
    avatarRenderer.render(avatarScene, avatarCamera);
  }
  renderer.render(scene, camera);
}
loop();
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  avatarRenderer.setSize(innerWidth, innerHeight);
  avatarCamera.aspect = innerWidth / innerHeight;
  avatarCamera.updateProjectionMatrix();
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});
