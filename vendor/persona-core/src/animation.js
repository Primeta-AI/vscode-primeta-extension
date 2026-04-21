import { CROSSFADE_DURATION } from './constants.js'

/**
 * Animation priority levels.
 * Higher number = higher priority. Equal or higher can interrupt.
 * When a prioritized animation finishes, falls back to the base layer.
 */
export const ANIM_PRIORITY = {
  BASE: 0,     // idle, talking (TTS-driven)
  HOOK: 1,     // coding event reactions
  TOOL: 2      // explicit primeta_animate calls
}

/**
 * Manages animation actions on a Three.js AnimationMixer.
 */
export class AnimationManager {
  constructor(THREE) {
    this.THREE = THREE
    this.mixer = null
    this.actions = {}
    this.loopModes = {}
    this.currentAction = null
    this.currentAnimName = ''
    this.currentPriority = ANIM_PRIORITY.BASE
    this.baseAnimName = '__idle'  // what to return to when priority anim finishes
  }

  setMixer(mixer) {
    this.mixer = mixer
    this.actions = {}
    this.loopModes = {}
    this.currentAction = null
    this.currentAnimName = ''
    this.currentPriority = ANIM_PRIORITY.BASE
    this.baseAnimName = '__idle'
  }

  /**
   * Register an animation clip as a named action.
   * @param {string} name - Trigger name (e.g. 'idle', 'talking', 'wave')
   * @param {AnimationClip} clip - The Three.js animation clip
   * @param {string} [loopMode] - 'loop', 'once', or 'once_then_idle'
   */
  registerAction(name, clip, loopMode = 'loop') {
    if (!this.mixer) return
    const action = this.mixer.clipAction(clip)
    if (loopMode === 'once' || loopMode === 'once_then_idle') {
      action.loop = this.THREE.LoopOnce
      action.clampWhenFinished = true
    } else {
      action.loop = this.THREE.LoopRepeat
    }
    this.actions[name] = action
    this.loopModes[name] = loopMode
  }

  /**
   * Play a named animation with crossfade.
   * @param {string} name - Animation name
   * @param {string} [loopOverride] - 'once', 'once_then_idle', or 'loop'
   * @param {number} [priority=ANIM_PRIORITY.BASE] - Priority level
   */
  play(name, loopOverride, priority = ANIM_PRIORITY.BASE) {
    // Case-insensitive lookup — MCP clients may send any casing
    if (!this.actions[name]) {
      const match = Object.keys(this.actions).find(k => k.toLowerCase() === name.toLowerCase())
      if (match) { name = match } else {
        if (name !== '__idle' && this.actions['__idle']) {
          this.play('__idle', null, priority)
        }
        return
      }
    }

    // Lower priority cannot interrupt higher
    if (priority < this.currentPriority && this.currentAnimName !== name) return

    if (name === this.currentAnimName && !loopOverride) return

    // Track base animation (talking/idle) so we can return to it
    if (priority === ANIM_PRIORITY.BASE) {
      this.baseAnimName = name
    }

    const newAction = this.actions[name]

    // Apply loop override if provided
    const effectiveLoop = loopOverride || this.loopModes[name]
    if (loopOverride) {
      this.loopModes[name] = loopOverride
    }
    if (effectiveLoop === 'once' || effectiveLoop === 'once_then_idle') {
      newAction.loop = this.THREE.LoopOnce
      newAction.clampWhenFinished = true
    } else if (effectiveLoop === 'loop') {
      newAction.loop = this.THREE.LoopRepeat
      newAction.clampWhenFinished = false
    }

    newAction.reset()
    newAction.setEffectiveWeight(1)

    if (this.currentAction) {
      this.currentAction.crossFadeTo(newAction, CROSSFADE_DURATION, true)
    }

    newAction.play()
    this.currentAction = newAction
    this.currentAnimName = name
    this.currentPriority = priority

    // For one-shot priority animations, return to base when done
    if (priority > ANIM_PRIORITY.BASE && (effectiveLoop === 'once' || effectiveLoop === 'once_then_idle')) {
      const onFinished = (e) => {
        if (e.action === newAction) {
          this.mixer.removeEventListener('finished', onFinished)
          this.currentPriority = ANIM_PRIORITY.BASE
          if (this.baseAnimName && this.actions[this.baseAnimName]) {
            this.play(this.baseAnimName, null, ANIM_PRIORITY.BASE)
          }
        }
      }
      this.mixer.addEventListener('finished', onFinished)
    }
  }

  getLoopMode(name) {
    return this.loopModes[name] || 'loop'
  }

  get hasAnimations() {
    return Object.keys(this.actions).length > 0
  }

  reset() {
    this.actions = {}
    this.loopModes = {}
    this.currentAction = null
    this.currentAnimName = ''
  }
}
