/**
 * Primeta Persona Renderer for VS Code Webview
 *
 * Uses @primeta/persona-core for shared rendering logic.
 * This file handles VS Code-specific concerns: scene setup, base64 model loading,
 * and postMessage communication with the extension host.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

import {
  AvatarController,
  TtsClient,
  retargetClip,
} from '@primeta/persona-core';

// State
let renderer, scene, camera, controls, clock, vrm;
let disposed = false;
let modelBox = null;
const avatar = new AvatarController(THREE);
let audioCtx = null;
let pendingTokenResolve = null;

const ttsClient = new TtsClient({
  playAnimation: (name) => avatar.playAnimation(name),
  onSpeechDone: () => {
    vscode.postMessage({ type: 'speechDone' });
  },
  onTokenExpired: () => requestTtsToken(),
});

// Request a TTS token from the extension host.
// Returns a promise that resolves when the token arrives via 'ttsToken' message.
function requestTtsToken() {
  return new Promise((resolve) => {
    pendingTokenResolve = resolve;
    vscode.postMessage({ type: 'requestTtsToken' });
    // Timeout after 10s so we don't hang forever
    setTimeout(() => {
      if (pendingTokenResolve === resolve) {
        pendingTokenResolve = null;
        resolve();
      }
    }, 10000);
  });
}

const vscode = acquireVsCodeApi();

// --- Scene Setup ---

function init() {
  const canvas = document.getElementById('avatar-canvas');

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 1.2, 3.5);
  camera.lookAt(0, 1.35, 0);

  controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 1.35, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.enablePan = false;
  controls.enableRotate = false;
  controls.enableZoom = false;
  controls.update();

  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(1, 2, 2);
  scene.add(dir);

  clock = new THREE.Clock();

  const container = document.getElementById('avatar-area');
  const resize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    fitCameraToModel();
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(container);
  resize();

  animate();
  vscode.postMessage({ type: 'ready' });
}

// --- Render Loop ---

function animate() {
  if (disposed) return;
  requestAnimationFrame(animate);

  const delta = clock.getDelta();
  if (controls) controls.update();

  avatar.update(delta);

  renderer.render(scene, camera);
}

// --- Model Loading (base64, VS Code specific) ---

function base64ToArrayBuffer(base64) {
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) {
    view[i] = raw.charCodeAt(i);
  }
  return buffer;
}

function loadModelFromBase64(modelBase64, animationData) {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser, { autoUpdateHumanBones: true }));

  const buffer = base64ToArrayBuffer(modelBase64);

  loader.parse(buffer, '', async (gltf) => {
    if (disposed) return;

    const loaded = gltf.userData.vrm;
    if (!loaded) {
      console.warn('[persona] VRM not found in userData');
      gltf.scene.rotation.y = Math.PI;
      scene.add(gltf.scene);
      return;
    }

    // Clean up previous model
    if (vrm?.scene) {
      scene.remove(vrm.scene);
      VRMUtils.deepDispose(vrm.scene);
    }

    vrm = loaded;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    if (VRMUtils.combineMorphs) VRMUtils.combineMorphs(vrm);

    vrm.scene.position.set(0, 0, 0);
    scene.add(vrm.scene);

    // Compute bounding box for camera fitting
    modelBox = new THREE.Box3().setFromObject(vrm.scene);
    fitCameraToModel();

    const mixer = new THREE.AnimationMixer(vrm.scene);
    vrm.scene.traverse((obj) => { obj.frustumCulled = false; });

    avatar.initModel(vrm, clock, mixer);

    VRMUtils.rotateVRM0(vrm);

    // Register embedded animations from the GLTF
    for (const clip of gltf.animations) {
      avatar.anims.registerAction(clip.name, clip, clip.name === 'wave' ? 'once' : 'loop');
    }

    // Load server-provided FBX animations (base64-encoded)
    if (animationData && Object.keys(animationData).length > 0) {
      setStatus('Loading animations...');
      await loadFBXAnimationsFromBase64(animationData);
    }

    if (avatar.anims.hasAnimations) {
      if (avatar.anims.actions.idle) avatar.anims.play('idle');
    } else {
      avatar.setupProcedural();
    }

    hideStatus();
  }, (error) => {
    console.error('[persona] Failed to load VRM model:', error);
    setStatus('Failed to load model');
  });
}

// --- FBX Animation Loading (base64, VS Code specific) ---

async function loadFBXAnimationsFromBase64(animationData) {
  if (!animationData || Object.keys(animationData).length === 0) return;
  if (!vrm || !avatar.anims.mixer) return;

  const fbxLoader = new FBXLoader();

  for (const [name, base64] of Object.entries(animationData)) {
    try {
      const buffer = base64ToArrayBuffer(base64);
      const fbx = fbxLoader.parse(buffer, '');
      if (fbx.animations.length > 0) {
        const clip = retargetClip(THREE, fbx.animations[0], fbx, vrm);
        if (clip) {
          clip.name = name;
          avatar.anims.registerAction(name, clip);
        }
      }
    } catch { /* skip failed animations */ }
  }

  if (avatar.anims.hasAnimations && !avatar.anims.currentAction) {
    if (avatar.anims.actions.idle) avatar.anims.play('idle');
  }
}

// --- Camera fit-to-model ---

function fitCameraToModel() {
  if (!modelBox || !camera) return;

  const size = new THREE.Vector3();
  modelBox.getSize(size);

  const fov = camera.fov * (Math.PI / 180);
  const lookY = size.y / 2 + modelBox.min.y;
  const z = (size.y / 2) / Math.tan(fov / 2);

  camera.position.set(0, lookY, z);
  camera.lookAt(0, lookY, 0);
  if (controls) {
    controls.target.set(0, lookY, 0);
    controls.update();
  }
}

// --- Status display ---

function setStatus(text) {
  const el = document.getElementById('status');
  if (el) {
    el.textContent = text;
    el.style.display = text ? '' : 'none';
  }
}

function hideStatus() {
  const el = document.getElementById('status');
  if (el) el.style.display = 'none';
}

// --- Waiting state ---

function showWaiting(workspaceName) {
  const el = document.getElementById('waiting-state');
  if (el) el.classList.remove('hidden');

  const canvas = document.getElementById('avatar-canvas');
  if (canvas) canvas.style.opacity = '0';

  const wsEl = document.getElementById('waiting-workspace');
  if (wsEl) {
    wsEl.textContent = workspaceName
      ? `Looking for bridge "${workspaceName}"`
      : '';
  }

  hideStatus();
}

function hideWaiting() {
  const el = document.getElementById('waiting-state');
  if (el) el.classList.add('hidden');

  const canvas = document.getElementById('avatar-canvas');
  if (canvas) canvas.style.opacity = '1';
}

// --- Cancel speech ---

function cancelAllSpeech() {
  ttsClient.cancel();
  avatar.playAnimation('idle');
}

// --- Message handling from extension host ---

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'showWaiting':
      showWaiting(msg.workspaceName);
      break;
    case 'hideWaiting':
      hideWaiting();
      break;
    case 'config':
      hideWaiting();
      setStatus(`Loading ${msg.persona}...`);
      if (msg.modelBase64) {
        loadModelFromBase64(msg.modelBase64, msg.animationData || {});
      }
      break;
    case 'status':
      setStatus(msg.text);
      break;
    case 'speak':
      if (msg.text) {
        ttsClient.speak(msg.text, vrm);
      }
      break;
    case 'ttsToken':
      if (msg.ttsConfig) {
        ttsClient.configure({
          provider: msg.ttsConfig.provider,
          token: msg.ttsConfig.token,
          voiceId: msg.ttsConfig.voice_id,
          wsUrl: msg.ttsConfig.ws_url,
          modelId: msg.ttsConfig.model_id,
        });
      }
      if (pendingTokenResolve) {
        pendingTokenResolve();
        pendingTokenResolve = null;
      }
      break;
    case 'setEmotion':
      avatar.setEmotion(msg.name, msg.intensity || 1.0);
      break;
    case 'cancelSpeech':
      cancelAllSpeech();
      break;
    case 'updateBridges': {
      const select = document.getElementById('bridge-select');
      if (select) {
        select.innerHTML = '';
        if (msg.bridges && msg.bridges.length > 0) {
          msg.bridges.forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            if (name === msg.selectedBridge) opt.selected = true;
            select.appendChild(opt);
          });
        } else {
          const opt = document.createElement('option');
          opt.value = '';
          opt.textContent = 'No bridges';
          select.appendChild(opt);
        }
      }
      break;
    }
  }
});

// Sound toggle — starts muted, click to enable/disable
document.getElementById('sound-btn')?.addEventListener('click', () => {
  ttsClient.muted = !ttsClient.muted;

  if (!ttsClient.muted && !audioCtx) {
    audioCtx = new AudioContext();
    ttsClient._audioCtx = audioCtx;
  }

  const unmuted = !ttsClient.muted;

  // Update UI
  const btn = document.getElementById('sound-btn');
  const iconOff = document.getElementById('sound-icon-off');
  const iconOn = document.getElementById('sound-icon-on');
  const label = document.getElementById('sound-label');

  if (unmuted) {
    btn?.classList.add('active');
    if (iconOff) iconOff.style.display = 'none';
    if (iconOn) iconOn.style.display = '';
    if (label) label.textContent = 'Sound on';
  } else {
    btn?.classList.remove('active');
    if (iconOff) iconOff.style.display = '';
    if (iconOn) iconOn.style.display = 'none';
    if (label) label.textContent = 'Sound off';
    ttsClient.cancel();
  }
});

// Bridge selector
document.getElementById('bridge-select')?.addEventListener('change', (e) => {
  const bridgeName = e.target.value;
  if (bridgeName) {
    vscode.postMessage({ type: 'switchBridge', bridgeName });
  }
});

// Boot
init();
