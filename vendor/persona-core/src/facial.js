import {
  FACE_EXPRESSIONS, CANONICAL_TO_VRM0, VISEME_EMOTIONS, MOUTH_EXPRESSIONS,
  EMOTION_DECAY_DELAY, EMOTION_DECAY_SPEED, EMOTION_LERP_SPEED, BLINK_DURATION,
} from './constants.js'

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

    // Idle blinking
    this._updateBlink(delta, clockElapsedTime, manager)
  }

  _updateBlink(delta, elapsed, manager) {
    if (this.current['surprised'] > 0.3) {
      this.blinkWeight = 0
      manager.setValue(this.resolveExprName('blink'), 0)
      return
    }

    if (this.blinkPhase === 'idle') {
      if (elapsed >= this.nextBlinkTime) this.blinkPhase = 'closing'
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
}
