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
import { VRMAnimationLoaderPlugin, VRMLookAtQuaternionProxy, createVRMAnimationClip } from '@pixiv/three-vrm-animation';

import {
  AvatarController,
  retargetClip,
  fixupLookAtApplier,
  extendPartialSpringChains,
  MOUTH_EXPRESSIONS,
  PHONEME_MAP,
} from '@primeta/persona-core';

// VRM 0.x uses uppercase single-letter viseme names
const VRM0_MOUTH_MAP = { aa: 'A', ee: 'E', ih: 'I', oh: 'O', ou: 'U' };
const LERP_SPEED = 12;

function buildMouthNameMap(manager) {
  if (!manager) return {};
  const has = (name) => { try { return manager.getExpression(name) != null; } catch { return false; } };
  const map = {};
  for (const expr of MOUTH_EXPRESSIONS) {
    if (has(expr)) map[expr] = expr;
    else if (VRM0_MOUTH_MAP[expr] && has(VRM0_MOUTH_MAP[expr])) map[expr] = VRM0_MOUTH_MAP[expr];
  }
  return map;
}

// Play TTS audio via AudioBufferSourceNode (Web Audio) instead of an
// <audio> element. Persona-core's speakWithLipSync uses <audio> to keep
// iOS Safari in "playback" session mode, but VS Code's webview is desktop
// Chromium — <audio>.play() hits the autoplay policy on every call, even
// with sticky activation. AudioBufferSourceNode only requires a resumed
// AudioContext, which the unlock overlay already provides.
let currentTtsSource = null;
let currentTtsAnimFrame = null;

function cancelTts() {
  if (currentTtsSource) {
    try { currentTtsSource.stop(); } catch {}
    currentTtsSource = null;
  }
  if (currentTtsAnimFrame) {
    cancelAnimationFrame(currentTtsAnimFrame);
    currentTtsAnimFrame = null;
  }
}

async function playBufferedTts({ audioBase64, phonemes, vrm, avatar, audioCtx, playAnimation, onDone }) {
  cancelTts();

  const raw = atob(audioBase64);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);

  const decoded = await audioCtx.decodeAudioData(buffer);

  const source = audioCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(audioCtx.destination);
  currentTtsSource = source;

  const manager = vrm?.expressionManager;
  const mouthMap = buildMouthNameMap(manager);
  const resolveName = (expr) => mouthMap[expr] || expr;

  const timeline = (phonemes || []).map(({ character, start, end }) => ({
    start, end, targets: PHONEME_MAP[character.toLowerCase()] || {},
  }));

  const current = {};
  for (const expr of MOUTH_EXPRESSIONS) current[expr] = 0;

  playAnimation('talking');
  if (supportsLipSyncSuppress && avatar?.facial) avatar.facial.suppressMouthOverride = true;

  let playStart = null;
  let lastFrame = performance.now() / 1000;

  function tick() {
    if (source !== currentTtsSource) return;
    const now = performance.now() / 1000;
    const dt = Math.min(now - lastFrame, 0.05);
    lastFrame = now;
    const elapsed = playStart !== null ? (now - playStart) : 0;
    const lerpFactor = 1 - Math.exp(-LERP_SPEED * dt);

    let target = {};
    for (let i = timeline.length - 1; i >= 0; i--) {
      if (elapsed >= timeline[i].start) {
        target = elapsed > timeline[i].end ? {} : timeline[i].targets;
        break;
      }
    }

    if (manager) {
      for (const expr of MOUTH_EXPRESSIONS) {
        const goal = target[expr] || 0;
        current[expr] = current[expr] + (goal - current[expr]) * lerpFactor;
        if (current[expr] < 0.001) current[expr] = 0;
        manager.setValue(resolveName(expr), current[expr]);
      }
    }

    currentTtsAnimFrame = requestAnimationFrame(tick);
  }

  source.onended = () => {
    if (source !== currentTtsSource) return;
    currentTtsSource = null;
    if (currentTtsAnimFrame) cancelAnimationFrame(currentTtsAnimFrame);
    currentTtsAnimFrame = null;
    if (manager) for (const expr of MOUTH_EXPRESSIONS) manager.setValue(resolveName(expr), 0);
    if (supportsLipSyncSuppress && avatar?.facial) avatar.facial.suppressMouthOverride = false;
    playAnimation('idle');
    onDone?.();
  };

  source.start();
  playStart = performance.now() / 1000;
  currentTtsAnimFrame = requestAnimationFrame(tick);
}

// State
let renderer, scene, camera, controls, clock, vrm;
let modelBox = null;
const avatar = new AvatarController(THREE);
let audioCtx = null;
let muted = true;
let audioUnlocked = false;
let ttsConfigured = false;
let supportsLipSyncSuppress = true;

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
  controls.enableRotate = true;
  controls.enableZoom = true;
  controls.enablePan = false;
  controls.minDistance = 0.5;
  controls.maxDistance = 8.0;
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

function loadModelFromBase64(modelBase64, animationData, animationMetadata) {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser, { autoUpdateHumanBones: true }));

  const buffer = base64ToArrayBuffer(modelBase64);

  loader.parse(buffer, '', async (gltf) => {
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

    fixupLookAtApplier(vrm);
    extendPartialSpringChains(vrm);

    vrm.scene.position.set(0, 0, 0);
    scene.add(vrm.scene);

    // Compute bounding box for camera fitting
    modelBox = new THREE.Box3().setFromObject(vrm.scene);
    fitCameraToModel();

    const mixer = new THREE.AnimationMixer(vrm.scene);
    vrm.scene.traverse((obj) => { obj.frustumCulled = false; });

    avatar.initModel(vrm, clock, mixer);

    // Detect persona-core API drift once per model load. The lip-sync path
    // toggles avatar.facial.suppressMouthOverride to hand the mouth off
    // between emotion-driven blendshapes and viseme-driven animation; if a
    // future persona-core sync renames or removes the flag, fall through
    // silently with a single warning instead of a per-frame TypeError.
    supportsLipSyncSuppress = !!(avatar.facial && 'suppressMouthOverride' in avatar.facial);
    if (!supportsLipSyncSuppress) {
      console.warn('[persona] avatar.facial.suppressMouthOverride missing — persona-core API may have changed; lip-sync will not suppress emotion mouth shapes');
    }

    VRMUtils.rotateVRM0(vrm);

    // Pre-create the look-at proxy once so concurrent VRMA loads don't each
    // create their own (the auto-create path in createVRMAnimationClip races
    // and ends up adding multiple proxies to vrm.scene).
    if (vrm.lookAt && !vrm.scene.children.find(o => o instanceof VRMLookAtQuaternionProxy)) {
      const proxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
      proxy.name = 'VRMLookAtQuaternionProxy';
      vrm.scene.add(proxy);
    }

    // Register embedded animations from the GLTF
    for (const clip of gltf.animations) {
      avatar.anims.registerAction(clip.name, clip, clip.name === 'wave' ? 'once' : 'loop');
    }

    // Load server-provided FBX animations (base64-encoded)
    if (animationData && Object.keys(animationData).length > 0) {
      setStatus('Loading animations...');
      await loadAnimationsFromBase64(animationData, animationMetadata);
    }

    if (avatar.anims.hasAnimations) {
      // System-state animations are registered with "__"-prefixed keys
      // (__idle, __talking, …) by /api/config's build_animation_urls.
      if (avatar.anims.actions.__idle) avatar.anims.play('__idle');
    } else {
      avatar.setupProcedural();
    }

    hideStatus();
  }, (error) => {
    console.error('[persona] Failed to load VRM model:', error);
    setStatus('Failed to load model');
  });
}

// --- Animation loading (base64, VS Code specific) ---
//
// The extension pre-fetches animation files in Node and forwards them as
// base64. We sniff the decoded buffer's magic bytes to pick the right
// loader: glTF binary (used by .vrma) vs FBX. This mirrors the URL-based
// detection in primeta-rails' avatar_controller.js — see
// `app/javascript/controllers/avatar_controller.js`.

const GLTF_MAGIC = 0x46546C67; // 'glTF' (little-endian DWORD)

function isGltfBuffer(buffer) {
  if (!buffer || buffer.byteLength < 4) return false;
  return new DataView(buffer).getUint32(0, true) === GLTF_MAGIC;
}

async function loadAnimationsFromBase64(animationData, animationMetadata) {
  if (!animationData || Object.keys(animationData).length === 0) return;
  if (!vrm || !avatar.anims.mixer) return;

  for (const [name, base64] of Object.entries(animationData)) {
    try {
      const buffer = base64ToArrayBuffer(base64);
      const clip = isGltfBuffer(buffer)
        ? await parseVRMAClip(buffer, name)
        : parseFBXClip(buffer, name);

      if (clip) {
        const loopMode = animationMetadata?.[name]?.loop_mode || 'loop';
        avatar.anims.registerAction(name, clip, loopMode);
      }
    } catch (err) {
      console.error('[persona] animation load failed for', name, err);
    }
  }

  if (avatar.anims.hasAnimations && !avatar.anims.currentAction) {
    // System-state key convention — see comment in loadModel().
    if (avatar.anims.actions.__idle) avatar.anims.play('__idle');
  }
}

function parseFBXClip(buffer, name) {
  const fbx = new FBXLoader().parse(buffer, '');
  if (fbx.animations.length === 0) {
    console.warn('[persona] FBX for', name, 'contained no animations');
    return null;
  }
  const clip = retargetClip(THREE, fbx.animations[0], fbx, vrm);
  if (!clip) {
    console.warn('[persona] retargetClip returned null for', name);
    return null;
  }
  clip.name = name;
  return clip;
}

function parseVRMAClip(buffer, name) {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  return new Promise((resolve, reject) => {
    loader.parse(
      buffer,
      '',
      (gltf) => {
        const vrmAnims = gltf.userData.vrmAnimations;
        if (!vrmAnims || vrmAnims.length === 0) {
          console.warn('[persona] VRMA for', name, 'contained no animations');
          resolve(null);
          return;
        }
        const clip = createVRMAnimationClip(vrmAnims[0], vrm);
        clip.name = name;
        resolve(clip);
      },
      (err) => reject(err)
    );
  });
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
  cancelTts();
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
      ttsConfigured = !!msg.ttsConfigured;
      if (ttsConfigured && !audioUnlocked) showAudioUnlock();
      if (msg.modelBase64) {
        loadModelFromBase64(msg.modelBase64, msg.animationData || {}, msg.animationMetadata || {});
      }
      break;
    case 'status':
      setStatus(msg.text);
      break;
    case 'speakData':
      (async () => {
        if (!msg.audioBase64 || !vrm || muted) return;
        if (!audioCtx) audioCtx = new AudioContext();
        if (audioCtx.state === 'suspended') await audioCtx.resume();
        try {
          await playBufferedTts({
            audioBase64: msg.audioBase64,
            phonemes: msg.phonemes,
            vrm,
            avatar,
            audioCtx,
            playAnimation: (name) => avatar.playAnimation(name),
            onDone: () => vscode.postMessage({ type: 'speechDone' }),
          });
        } catch (err) {
          console.error('[Primeta TTS] playback failed:', err);
        }
      })();
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

// Click-target shown when a TTS-configured config arrives. Establishes
// the user activation Chrome's autoplay policy requires before
// AudioContext.resume() will unsuspend. One click unlocks audio for the
// whole session.
function unlockAudio() {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  audioUnlocked = true;
  muted = false;
  hideAudioUnlock();
  syncSoundButtonUI();
}

function showAudioUnlock() {
  document.getElementById('audio-unlock')?.classList.remove('hidden');
}

function hideAudioUnlock() {
  document.getElementById('audio-unlock')?.classList.add('hidden');
}

function syncSoundButtonUI() {
  const unmuted = !muted;
  const btn = document.getElementById('sound-btn');
  const iconOff = document.getElementById('sound-icon-off');
  const iconOn = document.getElementById('sound-icon-on');
  btn?.classList.toggle('active', unmuted);
  if (iconOff) iconOff.style.display = unmuted ? 'none' : '';
  if (iconOn) iconOn.style.display = unmuted ? '' : 'none';
}

document.getElementById('audio-unlock')?.addEventListener('click', () => {
  unlockAudio();
});

// Sound toggle. If the user clicks this before clicking the unlock
// overlay, treat it as the unlock gesture (it satisfies the same Chrome
// activation requirement).
document.getElementById('sound-btn')?.addEventListener('click', () => {
  if (muted) {
    unlockAudio();
  } else {
    muted = true;
    cancelTts();
    syncSoundButtonUI();
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
