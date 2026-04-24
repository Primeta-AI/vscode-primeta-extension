export {
  CROSSFADE_DURATION, EMOTION_DECAY_DELAY, EMOTION_DECAY_SPEED, EMOTION_LERP_SPEED,
  BLINK_DURATION, MOUTH_EXPRESSIONS, FACE_EXPRESSIONS, CANONICAL_TO_VRM0,
  MIXAMO_VRM_MAP, PHONEME_MAP,
} from './constants.js'

export { buildExpressionNameMap, FacialExpressionState } from './facial.js'
export { retargetClip, normalizeBoneName } from './retarget.js'
export { setupProceduralFallback, proceduralAnimate, applyBreathingOverlay } from './procedural.js'
export { extendPartialSpringChains, fixupLookAtApplier } from './spring-bones.js'
export { speakWithLipSync } from './lip-sync.js'
export { TtsClient } from './tts-client.js'
export { AnimationManager, ANIM_PRIORITY } from './animation.js'
export { AvatarController } from './avatar-controller.js'

export {
  extractEmotionTag, extractSpokenText, stripTags,
  sanitizeForTts, processMessage,
} from './text.js'
