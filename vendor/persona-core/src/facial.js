import {
  FACE_EXPRESSIONS, CANONICAL_TO_VRM0, VISEME_EMOTIONS, MOUTH_EXPRESSIONS,
  EMOTION_DECAY_DELAY, EMOTION_DECAY_SPEED, EMOTION_LERP_SPEED, BLINK_DURATION,
  SACCADE_LERP_SPEED,
} from './constants.js'

// Mouth-viseme weight above which we consider the character to be
// actively articulating and defer blinks. Set deliberately low so the
// gate is easy to satisfy — blinks push into inter-phoneme gaps where
// all visemes momentarily dip near zero.
const ARTICULATING_THRESHOLD = 0.2

/**
 * Build a map from canonical expression names to the names this VRM actually supports.
 * VRM 0.x uses: joy, sorrow, angry, surprise, relaxed
 * VRM 1.0 uses: happy, sad, angry, surprised, relaxed
 */
export function buildExpressionNameMap(vrm) {
  const manager = vrm?.expressionManager
  if (!manager) return {}

  const has = (name) => {
    try { return manager.getExpression(name) != null } catch { return false }
  }

  const map = {}
  for (const canonical of FACE_EXPRESSIONS) {
    if (has(canonical)) {
      map[canonical] = canonical
    } else {
      const vrm0Name = CANONICAL_TO_VRM0[canonical]
      if (vrm0Name && has(vrm0Name)) {
        map[canonical] = vrm0Name
      }
    }
  }
  if (has('blink')) map['blink'] = 'blink'

  // Flag whether any real emotion expressions were found
  const hasEmotions = FACE_EXPRESSIONS.some(e => map[e])
  map._useVisemeFallback = !hasEmotions

  return map
}

/**
 * Manages facial expression state — emotion targets, lerping, decay, and blinking.
 */
export class FacialExpressionState {
  constructor() {
    this.current = {}
    this.targets = {}
    for (const expr of FACE_EXPRESSIONS) {
      this.current[expr] = 0
      this.targets[expr] = 0
    }
    this.lastEmotionTime = 0
    this.blinkWeight = 0
    this.nextBlinkTime = 2 + Math.random() * 4
    this.blinkPhase = 'idle'
    this.expressionNameMap = {}
    // Saccades — signed offsets in [-1, 1] projected onto lookLeft/Right/Up/Down.
    this.saccadeYaw = 0
    this.saccadePitch = 0
    this.saccadeTargetYaw = 0
    this.saccadeTargetPitch = 0
    this.nextSaccadeTime = 1 + Math.random() * 2
    // When true, lip-sync's viseme animation owns the mouth; emotion-driven
    // mouth blendshapes are suppressed to avoid double-driving. Initialized
    // here so the property is part of the explicit API surface — callers
    // (and drift-detection in vendoring consumers) can rely on `'suppressMouthOverride' in this`.
    this.suppressMouthOverride = false
  }

  reset() {
    for (const expr of FACE_EXPRESSIONS) {
      this.current[expr] = 0
      this.targets[expr] = 0
    }
    this.lastEmotionTime = 0
    this.blinkWeight = 0
    this.nextBlinkTime = 2 + Math.random() * 4
    this.blinkPhase = 'idle'
    this.saccadeYaw = 0
    this.saccadePitch = 0
    this.saccadeTargetYaw = 0
    this.saccadeTargetPitch = 0
    this.nextSaccadeTime = 1 + Math.random() * 2
  }

  setExpressionNameMap(map) {
    this.expressionNameMap = map
  }

  resolveExprName(canonical) {
    return this.expressionNameMap[canonical] || canonical
  }

  /**
   * Set a VRM facial expression by canonical name (happy, sad, angry, surprised, relaxed).
   * Pass 'neutral' or any unrecognized name to clear all expressions.
   */
  setEmotion(expression, intensity, clockElapsedTime) {
    const weight = Math.min(Math.max(intensity, 0), 1)
    for (const expr of FACE_EXPRESSIONS) {
      this.targets[expr] = expr === expression ? weight : 0
    }
    this.lastEmotionTime = clockElapsedTime || 0
  }

  /**
   * Update facial expressions each frame. Applies decay, lerping, and blinking.
   * Writes directly to the VRM expression manager.
   */
  update(delta, clockElapsedTime, vrm) {
    const manager = vrm?.expressionManager
    if (!manager) return

    // Decay: if no emotion set recently, fade all targets toward 0
    const timeSinceEmotion = clockElapsedTime - this.lastEmotionTime
    if (timeSinceEmotion > EMOTION_DECAY_DELAY) {
      const decayFactor = 1 - Math.exp(-EMOTION_DECAY_SPEED * delta)
      for (const expr of FACE_EXPRESSIONS) {
        this.targets[expr] *= (1 - decayFactor)
        if (this.targets[expr] < 0.01) this.targets[expr] = 0
      }
    }

    // Lerp current values toward targets
    const lerpFactor = 1 - Math.exp(-EMOTION_LERP_SPEED * delta)
    for (const expr of FACE_EXPRESSIONS) {
      const target = this.targets[expr]
      this.current[expr] += (target - this.current[expr]) * lerpFactor
      if (this.current[expr] < 0.005) this.current[expr] = 0
    }

    if (this.expressionNameMap._useVisemeFallback && !this.suppressMouthOverride) {
      // Viseme fallback: blend mouth shapes to fake emotions (only when
      // no real speech lipsync is active, otherwise we'd fight it)
      const visemeWeights = {}
      for (const v of MOUTH_EXPRESSIONS) visemeWeights[v] = 0
      for (const expr of FACE_EXPRESSIONS) {
        if (this.current[expr] > 0 && VISEME_EMOTIONS[expr]) {
          for (const [v, w] of Object.entries(VISEME_EMOTIONS[expr])) {
            visemeWeights[v] = Math.max(visemeWeights[v], w * this.current[expr])
          }
        }
      }
      for (const v of MOUTH_EXPRESSIONS) {
        try { manager.setValue(v, visemeWeights[v]) } catch {}
      }
    }

    // Always write real face expressions to the VRM expression manager.
    // This runs regardless of viseme fallback state — models with real
    // face blendshapes get their emotions applied during speech.
    for (const expr of FACE_EXPRESSIONS) {
      try { manager.setValue(this.resolveExprName(expr), this.current[expr]) } catch {}
    }

    // Idle blinking + small eye movements
    this._updateBlink(delta, clockElapsedTime, manager)
    this._updateSaccade(delta, clockElapsedTime, vrm)
  }

  _isArticulating(manager) {
    for (const v of MOUTH_EXPRESSIONS) {
      try {
        const val = manager.getValue(this.resolveExprName(v)) || 0
        if (val > ARTICULATING_THRESHOLD) return true
      } catch {}
    }
    return false
  }

  _updateBlink(delta, elapsed, manager) {
    if (this.current['surprised'] > 0.3) {
      this.blinkWeight = 0
      manager.setValue(this.resolveExprName('blink'), 0)
      return
    }

    if (this.blinkPhase === 'idle') {
      if (elapsed >= this.nextBlinkTime) {
        // Defer the blink if the mouth is mid-viseme — blinking on a
        // held-open shape reads unnatural. Re-check in a beat; most
        // phoneme transitions drop mouth weights to near zero briefly.
        if (this._isArticulating(manager)) {
          this.nextBlinkTime = elapsed + 0.15
        } else {
          this.blinkPhase = 'closing'
        }
      }
    }

    if (this.blinkPhase === 'closing') {
      this.blinkWeight += delta / BLINK_DURATION
      if (this.blinkWeight >= 1) { this.blinkWeight = 1; this.blinkPhase = 'opening' }
    } else if (this.blinkPhase === 'opening') {
      this.blinkWeight -= delta / BLINK_DURATION
      if (this.blinkWeight <= 0) {
        this.blinkWeight = 0
        this.blinkPhase = 'idle'
        this.nextBlinkTime = elapsed + 2 + Math.random() * 4
      }
    }

    manager.setValue(this.resolveExprName('blink'), this.blinkWeight)
  }

  // Micro-saccades keep the gaze from feeling frozen. Every 1-3s pick a
  // small random yaw/pitch in degrees, lerp to it, hold, then move again.
  // ~30% of targets are "center" so eyes mostly rest forward.
  //
  // Drives vrm.lookAt.yaw/pitch (not look* expressions) so the VRM's own
  // applier propagates the gaze — either to eye bones (VRM 0.x typical) or
  // to look* blendshapes (VRM 1.0). Writing the blendshapes directly
  // wouldn't work on bone-applier models, and would get overwritten on
  // expression-applier models whenever a lookAt target was set.
  _updateSaccade(delta, elapsed, vrm) {
    const lookAt = vrm?.lookAt
    if (!lookAt) return

    if (elapsed >= this.nextSaccadeTime) {
      const r = Math.random()
      if (r < 0.3) {
        this.saccadeTargetYaw = 0
        this.saccadeTargetPitch = 0
      } else {
        // Yaw/pitch in degrees are INPUTS to the VRM lookAt applier's range
        // map — the actual eye rotation (bone applier) or blendshape
        // weight (expression applier) is scaled down from here. Default
        // bone-applier output scale is 10 at inputMaxValue 90, so yaw of
        // ~30° produces ~3° visible eye rotation; for expression applier
        // same yaw maps to ~0.33 blendshape weight. Values chosen so both
        // appliers produce a visible but subtle saccade on default rigs.
        this.saccadeTargetYaw = (Math.random() - 0.5) * 60   // ±30°
        this.saccadeTargetPitch = (Math.random() - 0.5) * 30 // ±15°
      }
      this.nextSaccadeTime = elapsed + 1 + Math.random() * 2
    }

    const lerp = 1 - Math.exp(-SACCADE_LERP_SPEED * delta)
    this.saccadeYaw += (this.saccadeTargetYaw - this.saccadeYaw) * lerp
    this.saccadePitch += (this.saccadeTargetPitch - this.saccadePitch) * lerp

    try {
      lookAt.yaw = this.saccadeYaw
      lookAt.pitch = this.saccadePitch
    } catch {}
  }
}
