/**
 * High-level avatar controller that orchestrates facial expressions and body animations.
 * Both web UI and VS Code extension use this instead of calling facial + anims separately.
 */

import { FacialExpressionState, buildExpressionNameMap } from './facial.js'
import { AnimationManager } from './animation.js'
import { setupProceduralFallback, proceduralAnimate } from './procedural.js'

export class AvatarController {
  constructor(THREE) {
    this.facial = new FacialExpressionState()
    this.anims = new AnimationManager(THREE)
    this.THREE = THREE
    this.vrm = null
    this.clock = null
    this.bones = {}
    this.baseRot = {}
  }

  /**
   * Initialize with a loaded VRM model.
   * Sets up expression name map, animation mixer, and procedural fallback.
   */
  initModel(vrm, clock, mixer) {
    this.vrm = vrm
    this.clock = clock

    this.facial.reset()
    this.facial.setExpressionNameMap(buildExpressionNameMap(vrm))

    this.anims.setMixer(mixer)
    this.bones = {}
    this.baseRot = {}
    this._fingerBones = null
    this._setupFingerCurl(vrm)
  }

  /**
   * Set up procedural animation fallback (when no FBX animations are loaded).
   */
  setupProcedural() {
    const fallback = setupProceduralFallback(this.vrm)
    this.bones = fallback.bones
    this.baseRot = fallback.baseRot
  }

  /**
   * Trigger an emotion + body animation from a tag string.
   * Accepts raw tags like "[joy]", "[angry:0.5]", or bare names like "thinking".
   */
  setAnimation(trigger, intensity = 1.0) {
    const name = trigger.replace(/^\[|\]$/g, '')
    this.facial.setEmotion(name, intensity, this.clock?.elapsedTime || 0)
    if (this.anims.hasAnimations) {
      this.anims.play(name)
    }
  }

  /**
   * Set a VRM facial expression (happy, sad, angry, surprised, relaxed).
   * Pass 'neutral' to clear all expressions.
   */
  setEmotion(emotion, intensity = 1.0) {
    this.facial.setEmotion(emotion, intensity, this.clock?.elapsedTime || 0)
  }

  /**
   * Play only a body animation (no facial change).
   * Optional loopOverride: 'once', 'once_then_idle', or 'loop'.
   * Optional priority from ANIM_PRIORITY (BASE, HOOK, TOOL).
   */
  playAnimation(name, loopOverride, priority) {
    this.anims.play(name, loopOverride, priority)
  }

  /**
   * Find finger bones in the VRM humanoid and store for per-frame curl.
   */
  _setupFingerCurl(vrm) {
    const humanoid = vrm?.humanoid
    if (!humanoid) return

    const getBone = (name) => humanoid.getRawBoneNode?.(name) || humanoid.getBoneNode?.(name)

    // Collect all finger bones (proximal, intermediate, distal) for both hands
    const fingerNames = [
      'Thumb', 'Index', 'Middle', 'Ring', 'Little'
    ]
    const segments = ['Proximal', 'Intermediate', 'Distal']
    const sides = ['left', 'right']

    // Get raw bone nodes — traverse the scene to find actual Three.js bones
    // rather than using VRM humanoid which may normalize transforms
    const allBones = {}
    vrm.scene.traverse((node) => {
      if (node.isBone) allBones[node.name] = node
    })

    const fingers = []
    for (const side of sides) {
      for (const finger of fingerNames) {
        for (const seg of segments) {
          const boneName = `${side}${finger}${seg}`
          // Try VRM humanoid first, then direct scene traversal
          const vrmBone = getBone(boneName)
          // Get the actual Three.js bone node name from VRM
          const rawNode = vrmBone || allBones[boneName]
          if (rawNode) {
            fingers.push({ bone: rawNode, finger, seg, side })
          }
        }
      }
    }

    this._fingerBones = fingers.length > 0 ? fingers : null
    console.log('[persona] Finger bones found:', fingers.length)
  }

  /**
   * Apply natural finger curl — slight inward bend at rest.
   * Called after the animation mixer so it layers on top of body animations.
   * Mixamo FBX doesn't animate fingers, so these rotations won't conflict.
   */
  _applyFingerCurl(t) {
    if (!this._fingerBones) return

    // Subtle breathing motion on the curl so hands feel alive
    const breathe = Math.sin(t * 0.8) * 0.03

    for (const { bone, finger, seg, side } of this._fingerBones) {
      if (finger === 'Thumb') {
        // Thumb tucks inward across the palm
        bone.rotation.z += side === 'left' ? 0.1 : -0.1
      } else {
        // Fingers curl — try Z axis (common for VRM finger curl)
        const curl = seg === 'Proximal' ? 0.25 : seg === 'Intermediate' ? 0.35 : 0.2
        bone.rotation.z += side === 'left' ? curl + breathe : -(curl + breathe)
      }
    }
  }

  /**
   * Call every frame from the render loop.
   */
  update(delta) {
    if (!this.vrm) return

    if (this.anims.hasAnimations && this.anims.mixer) {
      this.anims.mixer.update(delta)

      // Expose hips world position for camera follow
      const hips = this.vrm.humanoid?.getRawBoneNode('hips')
      if (hips) {
        if (!this._trackVec3) this._trackVec3 = new this.THREE.Vector3()
        hips.getWorldPosition(this._trackVec3)
        this.hipsWorldPos = this._trackVec3
      }
    } else {
      proceduralAnimate(this.clock?.elapsedTime || 0, this.bones, this.baseRot)
    }

    this.facial.update(delta, this.clock?.elapsedTime || 0, this.vrm)
    this.vrm.update(delta)

    // Apply finger curl last — after mixer and VRM update so it doesn't get overwritten
    this._applyFingerCurl(this.clock?.elapsedTime || 0)
  }
}
