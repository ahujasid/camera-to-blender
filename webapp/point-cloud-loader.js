/**
 * Point Cloud Loader — Spiral Torus style (Panel E)
 *
 * Particles form a spinning spiral torus while loading, then reassemble
 * into the preview model shape when the GLB arrives.
 *
 * When an image blob is provided, particles start as the image pixels and
 * swoop through a vortex spiral into the torus formation.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

const POINT_COUNT = 18000;
const ASSEMBLE_DURATION = 3.5;
const CROSSFADE_DURATION = 1.8;
const IMAGE_HOLD_DURATION = 0.6;   // seconds to hold the flat image before moving to torus
function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
function easeInCubic(t) { return t * t * t; }

class PointCloudLoader {
  constructor() {
    this.canvas = document.getElementById('pointCloudCanvas');
    this.statusEl = document.getElementById('pointCloudStatus');
    this.statusTextEl = document.getElementById('pointCloudStatusText');
    this.modelViewer = document.getElementById('modelViewer');
    this.container = document.getElementById('modelViewerContainer');

    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.controls = null;
    this.composer = null;
    this.points = null;
    this.pointMaterial = null;

    this.posAttr = null;
    this.colorAttr = null;
    this.floatingPositions = null;   // spiral torus positions
    this.imagePositions = null;      // flat grid matching the captured photo
    this.imageColors = null;         // per-particle color sampled from photo
    this.targetPositions = null;     // sampled from model surface
    this.driftOffsets = null;        // per-particle motion params

    this.state = 'idle'; // idle | image | imageToTorus | floating | assembling | assembled | crossfading | done
    this.assembleStartTime = 0;
    this.crossfadeStartTime = 0;
    this.imageStartTime = 0;
    this.imageToTorusStartTime = 0;
    this.animFrameId = null;
    this.active = false;

    this._imageBlob = null;

    this._boundAnimate = this._animate.bind(this);
  }

  /**
   * Call before start() to supply the captured image for the opening animation.
   */
  setImageBlob(blob) {
    this._imageBlob = blob;
  }

  /**
   * Initialize the Three.js scene. Called once.
   */
  _initScene() {
    if (this.renderer) return;

    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || 400;
    const h = rect.height || 400;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false
    });
    this.renderer.setSize(w, h, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0a0f);

    this.camera = new THREE.PerspectiveCamera(40, w / h, 0.01, 100);
    this.camera.position.set(0, 0, 5.0);
    this.camera.lookAt(0, 0, 0);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.autoRotate = false;
    this.controls.target.set(0, 0, 0);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.1));

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.9, 0.4, 0.2);
    this.composer.addPass(bloom);
  }

  /**
   * Sample the image blob into imagePositions (flat 2D grid) and imageColors.
   * Returns a promise that resolves when sampling is done.
   */
  async _sampleImage(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const offscreen = document.createElement('canvas');
        // Sample at a manageable resolution
        const sampleW = 160;
        const sampleH = Math.round(160 * (img.height / img.width));
        offscreen.width = sampleW;
        offscreen.height = sampleH;
        const ctx = offscreen.getContext('2d');
        ctx.drawImage(img, 0, 0, sampleW, sampleH);
        const data = ctx.getImageData(0, 0, sampleW, sampleH).data;
        URL.revokeObjectURL(url);

        const count = POINT_COUNT;
        const positions = new Float32Array(count * 3);
        const colors = new Float32Array(count * 3);

        const imgAspect = sampleW / sampleH;
        const camAspect = this.camera.aspect || 1;

        // Compute the world-space size that exactly fills the viewport at z=0
        // with the camera at z=6.5, FOV=40°
        const camZ = 6.5;
        const fovRad = (40 * Math.PI) / 180;
        const screenHeight = 2 * camZ * Math.tan(fovRad / 2);
        const screenWidth = screenHeight * camAspect;

        // Fill the full screen, letterboxing or pillarboxing to match image aspect
        let fitWidth, fitHeight;
        if (imgAspect > camAspect) {
          fitWidth = screenWidth;
          fitHeight = screenWidth / imgAspect;
        } else {
          fitHeight = screenHeight;
          fitWidth = screenHeight * imgAspect;
        }

        for (let i = 0; i < count; i++) {
          // Pick a random pixel
          const px = Math.floor(Math.random() * sampleW);
          const py = Math.floor(Math.random() * sampleH);
          const idx = (py * sampleW + px) * 4;

          const r = data[idx]     / 255;
          const g = data[idx + 1] / 255;
          const b = data[idx + 2] / 255;

          // Map pixel coord to world space (centered, flat at z=0)
          const x = (px / sampleW - 0.5) * fitWidth;
          const y = -(py / sampleH - 0.5) * fitHeight; // flip Y

          positions[i * 3 + 0] = x;
          positions[i * 3 + 1] = y;
          positions[i * 3 + 2] = 0;

          colors[i * 3 + 0] = r;
          colors[i * 3 + 1] = g;
          colors[i * 3 + 2] = b;
        }

        this.imagePositions = positions;
        this.imageColors = colors;
        resolve();
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(); };
      img.src = url;
    });
  }

  /**
   * Create organic spiral torus distribution (Panel E).
   */
  _createFloatingCloud() {
    if (this.points) {
      this.scene.remove(this.points);
      this.points.geometry.dispose();
      this.pointMaterial.dispose();
    }

    const count = POINT_COUNT;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    this.driftOffsets = [];

    let particleIndex = 0;
    while (particleIndex < count) {
      const verticalBias = Math.pow(Math.random(), 0.4);
      const normalizedHeight = verticalBias * 2 - 1;

      const spiralTightness = 3;
      const baseAngle = Math.random() * Math.PI * 2;
      const spiralOffset = (1 - verticalBias) * spiralTightness * Math.PI * 2;
      const theta = baseAngle + spiralOffset;

      const baseRadius = 0.3 + (1 - verticalBias) * 0.5;
      const radius = baseRadius + Math.random() * 0.3;

      const x = radius * Math.cos(theta);
      const y = normalizedHeight * 0.6;
      const z = radius * Math.sin(theta);

      const finalX = x;
      const finalY = -z;
      const finalZ = y;

      if (finalY < 0 && Math.random() > 0.15) continue;

      positions[particleIndex * 3 + 0] = finalX + (Math.random() - 0.5) * 0.2;
      positions[particleIndex * 3 + 1] = finalY + (Math.random() - 0.5) * 0.2;
      positions[particleIndex * 3 + 2] = finalZ + (Math.random() - 0.5) * 0.1;

      const posX = positions[particleIndex * 3 + 0];
      const posY = positions[particleIndex * 3 + 1];
      const radiusFromCenter = Math.sqrt(posX * posX + posY * posY);

      this.driftOffsets.push({
        baseAngle: Math.atan2(posY, posX),
        radiusFromCenter,
        baseZ: positions[particleIndex * 3 + 2],
        oscillationSpeed: 0.15 + Math.random() * 0.4,
        oscillationArc: (Math.PI / 6) + Math.random() * (Math.PI / 4),
        phase: Math.random() * Math.PI * 2,
        pulseSpeed: 0.1 + Math.random() * 0.2,
        pulseAmount: 0.03 + Math.random() * 0.05,
        pulsePhase: Math.random() * Math.PI * 2,
        wobbleZ: (Math.random() - 0.5) * 0.05,
        wobbleSpeed: 0.15 + Math.random() * 0.35,
      });

      particleIndex++;
    }

    this.floatingPositions = new Float32Array(positions);

    const geom = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(positions, 3);
    this.colorAttr = new THREE.BufferAttribute(colors, 3);
    geom.setAttribute('position', this.posAttr);
    geom.setAttribute('color', this.colorAttr);

    this.pointMaterial = new THREE.PointsMaterial({
      size: 0.01,
      sizeAttenuation: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
    });

    this.points = new THREE.Points(geom, this.pointMaterial);
    this.scene.add(this.points);
  }

  /**
   * Build per-particle vortex params for the spiral inward motion.
   */
  /**
   * Start the loader. If an image blob was set, begin from image-particle state.
   */
  async start() {
    this._initScene();
    this._createFloatingCloud();
    this._resize();

    this.canvas.style.display = 'block';
    this.canvas.style.opacity = '1';
    this.modelViewer.style.opacity = '0';
    this.modelViewer.style.pointerEvents = 'none';
    this.statusEl.style.display = 'none';

    this.active = true;

    if (this._imageBlob) {
      // Sample image pixels into particle positions/colors
      await this._sampleImage(this._imageBlob);
      this._imageBlob = null; // free reference

      // Overwrite particle positions with flat image layout
      for (let i = 0; i < POINT_COUNT * 3; i++) {
        this.posAttr.array[i] = this.imagePositions[i];
        this.colorAttr.array[i] = this.imageColors[i];
      }
      this.posAttr.needsUpdate = true;
      this.colorAttr.needsUpdate = true;

      // Push camera back so flat image fills frame nicely
      this.camera.position.set(0, 0, 6.5);

      this.state = 'image';
      this.imageStartTime = performance.now();
    } else {
      this.state = 'floating';
    }

    if (!this.animFrameId) {
      this._animate();
    }
  }

  updateProgress(text) {
    if (this.statusTextEl) {
      this.statusTextEl.textContent = text;
    }
  }

  async assembleFromURL(glbUrl) {
    if (this.state === 'done' || this.state === 'crossfading') return;

    // Wait until particles are in torus formation before snapshotting for assembly
    while (this.state === 'image' || this.state === 'imageToTorus') {
      await new Promise(r => setTimeout(r, 50));
    }

    if (this.state === 'done' || this.state === 'crossfading') return;

    this.statusTextEl.textContent = 'Materializing...';

    try {
      const loader = new GLTFLoader();
      const gltf = await new Promise((resolve, reject) => {
        loader.load(glbUrl, resolve, undefined, reject);
      });

      const model = gltf.scene;

      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = 1.5 / maxDim;
      model.position.sub(center);
      model.scale.multiplyScalar(scale);
      model.updateMatrixWorld(true);

      const surfacePoints = [];
      model.traverse(node => {
        if (!node.isMesh) return;
        node.updateWorldMatrix(true, false);
        const geo = node.geometry.index
          ? node.geometry.toNonIndexed()
          : node.geometry;
        const pos = geo.getAttribute('position');
        const totalTris = Math.floor(pos.count / 3);
        const v0 = new THREE.Vector3(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3();

        for (let i = 0; i < totalTris; i++) {
          const base = i * 3;
          v0.set(pos.getX(base), pos.getY(base), pos.getZ(base)).applyMatrix4(node.matrixWorld);
          v1.set(pos.getX(base+1), pos.getY(base+1), pos.getZ(base+1)).applyMatrix4(node.matrixWorld);
          v2.set(pos.getX(base+2), pos.getY(base+2), pos.getZ(base+2)).applyMatrix4(node.matrixWorld);
          surfacePoints.push({ v0: v0.clone(), v1: v1.clone(), v2: v2.clone() });
        }
      });

      if (surfacePoints.length === 0) {
        console.warn('[PointCloud] No surface points found, skipping assembly');
        this._finishImmediately();
        return;
      }

      const count = POINT_COUNT;
      this.targetPositions = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        const tri = surfacePoints[Math.floor(Math.random() * surfacePoints.length)];
        let u = Math.random(), v = Math.random();
        if (u + v > 1) { u = 1 - u; v = 1 - v; }
        const w = 1 - u - v;
        this.targetPositions[i*3+0] = tri.v0.x * w + tri.v1.x * u + tri.v2.x * v;
        this.targetPositions[i*3+1] = tri.v0.y * w + tri.v1.y * u + tri.v2.y * v;
        this.targetPositions[i*3+2] = tri.v0.z * w + tri.v1.z * u + tri.v2.z * v;
      }

      // Always start assembly from image positions, not whatever posAttr currently holds
      this.floatingPositions = new Float32Array(this.imagePositions);

      this.state = 'assembling';
      this.assembleStartTime = performance.now();

    } catch (err) {
      console.error('[PointCloud] Failed to load GLB for assembly:', err);
      this._finishImmediately();
    }
  }

  crossfadeToModel() {
    if (this.state === 'done' || this.state === 'crossfading') return;
    this._startCrossfade();
  }

  _startCrossfade() {
    this.state = 'crossfading';
    this.crossfadeStartTime = performance.now();
    this.statusEl.style.display = 'none';
    this.modelViewer.style.pointerEvents = '';
  }

  _finishImmediately() {
    this.state = 'done';
    this.active = false;
    this.canvas.style.display = 'none';
    this.modelViewer.style.opacity = '1';
    this.modelViewer.style.pointerEvents = '';
    this.statusEl.style.display = 'none';
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  stop() {
    this.state = 'idle';
    this.active = false;
    this._imageBlob = null;
    this.canvas.style.display = 'none';
    this.canvas.style.opacity = '1';
    this.modelViewer.style.opacity = '0';
    this.modelViewer.style.pointerEvents = 'none';
    this.statusEl.style.display = 'none';
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  skipToModelViewer() {
    this.state = 'done';
    this.active = false;
    this.canvas.style.display = 'none';
    this.modelViewer.style.opacity = '1';
    this.modelViewer.style.pointerEvents = '';
    this.statusEl.style.display = 'none';
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  _resize() {
    if (!this.renderer) return;
    const rect = this.container.getBoundingClientRect();
    const w = rect.width || 400;
    const h = rect.height || 400;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _animate() {
    if (!this.active && this.state === 'done') {
      this.animFrameId = null;
      return;
    }

    this.animFrameId = requestAnimationFrame(this._boundAnimate);

    const time = performance.now() / 1000;
    this.controls.update();

    if (this.state === 'image') {
      this._updateImageHold(time);
    } else if (this.state === 'imageToTorus') {
      this._updateImageToTorus(time);
    } else if (this.state === 'floating') {
      this._updateFloating(time);
    } else if (this.state === 'assembling') {
      this._updateAssembly(time);
    } else if (this.state === 'assembled') {
      this._updateAssembled(time);
    } else if (this.state === 'crossfading') {
      this._updateCrossfade();
    }

    this.composer.render();
  }

  /**
   * Hold the image flat for a moment before the vortex begins.
   */
  _updateImageHold(time) {
    if (!this.posAttr || !this.colorAttr) return;

    const elapsed = (performance.now() - this.imageStartTime) / 1000;

    // Subtle shimmer on the image particles
    const arr = this.posAttr.array;
    const colors = this.colorAttr.array;
    const shimmer = 0.85 + 0.15 * Math.sin(time * 4);
    for (let i = 0; i < POINT_COUNT; i++) {
      colors[i * 3 + 0] = this.imageColors[i * 3 + 0] * shimmer;
      colors[i * 3 + 1] = this.imageColors[i * 3 + 1] * shimmer;
      colors[i * 3 + 2] = this.imageColors[i * 3 + 2] * shimmer;
    }
    this.colorAttr.needsUpdate = true;

    if (elapsed >= IMAGE_HOLD_DURATION) {
      // Snapshot current image positions as the assembly start point
      this.floatingPositions = new Float32Array(this.posAttr.array);
      this.state = 'assembling';
      this.assembleStartTime = performance.now();
    }
  }

  _updateFloating(time) {
    if (!this.posAttr || !this.colorAttr || !this.driftOffsets) return;

    const count = POINT_COUNT;
    const arr = this.posAttr.array;
    const colors = this.colorAttr.array;
    const pulse = 0.7 + 0.3 * Math.sin(time * 3);

    for (let i = 0; i < count; i++) {
      const d = this.driftOffsets[i];

      const oscillation = Math.sin(time * d.oscillationSpeed + d.phase) * d.oscillationArc;
      const currentAngle = d.baseAngle + oscillation;

      const radialPulse = Math.sin(time * d.pulseSpeed + d.pulsePhase) * d.pulseAmount;
      const currentRadius = d.radiusFromCenter + radialPulse;

      const x = currentRadius * Math.cos(currentAngle);
      const y = currentRadius * Math.sin(currentAngle);
      const wobbleZ = Math.sin(time * d.wobbleSpeed + d.pulsePhase) * d.wobbleZ;

      arr[i * 3 + 0] = x;
      arr[i * 3 + 1] = y;
      arr[i * 3 + 2] = d.baseZ + wobbleZ;

      let brightness = 1.0;
      if (y < 0) {
        const normalizedY = Math.abs(y / (currentRadius || 1));
        brightness = Math.max(0.4, 1.0 - normalizedY * 0.6);
      }

      const b = brightness * pulse;
      colors[i * 3 + 0] = b;
      colors[i * 3 + 1] = b;
      colors[i * 3 + 2] = b;
    }

    this.posAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
  }

  _updateAssembly(time) {
    if (!this.posAttr || !this.floatingPositions || !this.targetPositions) return;

    const elapsed = (performance.now() - this.assembleStartTime) / 1000;
    const t = Math.min(elapsed / ASSEMBLE_DURATION, 1);
    const eased = easeOutCubic(t);

    const count = POINT_COUNT;
    const arr = this.posAttr.array;

    for (let i = 0; i < count * 3; i++) {
      arr[i] = this.floatingPositions[i] + (this.targetPositions[i] - this.floatingPositions[i]) * eased;
    }
    this.posAttr.needsUpdate = true;

    if (this.colorAttr) {
      const colors = this.colorAttr.array;
      const brightness = 0.7 + eased * 0.3;
      const pulse = 0.7 + 0.3 * Math.sin(time * 3);
      const b = brightness * pulse;
      for (let i = 0; i < count * 3; i++) {
        colors[i] = b;
      }
      this.colorAttr.needsUpdate = true;
    }

    this.pointMaterial.size = 0.01 + (1 - eased) * 0.008;
    this.camera.position.z = 5.0 - eased * 1.5;

    if (t >= 1) {
      this.state = 'assembled';
      this.assembledStartTime = performance.now();
    }
  }

  _updateAssembled(_time) {
    if (!this.points) return;
    const elapsed = (performance.now() - this.assembledStartTime) / 1000;
    this.points.rotation.y = elapsed * 0.08;
  }

  _updateCrossfade() {
    const elapsed = (performance.now() - this.crossfadeStartTime) / 1000;
    const t = Math.min(elapsed / CROSSFADE_DURATION, 1);
    const eased = easeInCubic(t);

    this.canvas.style.opacity = String(1 - eased);
    this.modelViewer.style.opacity = String(eased);

    if (t >= 1) {
      this.state = 'done';
      this.active = false;
      this.canvas.style.display = 'none';
    }
  }
}

const pointCloudLoader = new PointCloudLoader();
window.pointCloudLoader = pointCloudLoader;

window.addEventListener('resize', () => {
  if (pointCloudLoader.active) {
    pointCloudLoader._resize();
  }
});
