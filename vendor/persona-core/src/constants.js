export const CROSSFADE_DURATION = 0.4
export const EMOTION_DECAY_DELAY = 4.0
export const EMOTION_DECAY_SPEED = 1.5
export const EMOTION_LERP_SPEED = 3.0
export const BLINK_DURATION = 0.15
// Saccades: small random eye movements every 1-3s so the gaze never holds
// perfectly still. Lerp is fast-but-not-instant — reads as an involuntary dart.
export const SACCADE_LERP_SPEED = 6.0

export const MOUTH_EXPRESSIONS = ['aa', 'ee', 'ih', 'oh', 'ou']
export const FACE_EXPRESSIONS = ['happy', 'sad', 'angry', 'surprised', 'relaxed']

export const CANONICAL_TO_VRM0 = {
  happy: 'joy',
  sad: 'sorrow',
  angry: 'angry',
  surprised: 'surprise',
  relaxed: 'relaxed',
}

// Viseme-based emotion fallback for models without expression blendshapes
export const VISEME_EMOTIONS = {
  happy:     { aa: 0.4, ih: 0.6 },
  sad:       { oh: 0.5, ee: 0.2 },
  angry:     { ee: 0.7, aa: 0.2 },
  surprised: { oh: 0.8, aa: 0.3 },
  relaxed:   { ou: 0.3 },
}

export const MIXAMO_VRM_MAP = {
  mixamorigHips: 'hips',
  mixamorigSpine: 'spine',
  mixamorigSpine1: 'chest',
  mixamorigSpine2: 'upperChest',
  mixamorigNeck: 'neck',
  mixamorigHead: 'head',
  mixamorigLeftShoulder: 'leftShoulder',
  mixamorigLeftArm: 'leftUpperArm',
  mixamorigLeftForeArm: 'leftLowerArm',
  mixamorigLeftHand: 'leftHand',
  mixamorigRightShoulder: 'rightShoulder',
  mixamorigRightArm: 'rightUpperArm',
  mixamorigRightForeArm: 'rightLowerArm',
  mixamorigRightHand: 'rightHand',
  mixamorigLeftUpLeg: 'leftUpperLeg',
  mixamorigLeftLeg: 'leftLowerLeg',
  mixamorigLeftFoot: 'leftFoot',
  mixamorigLeftToeBase: 'leftToes',
  mixamorigRightUpLeg: 'rightUpperLeg',
  mixamorigRightLeg: 'rightLowerLeg',
  mixamorigRightFoot: 'rightFoot',
  mixamorigRightToeBase: 'rightToes',
}

export const PHONEME_MAP = {
  a: { aa: 1.0 }, e: { ee: 1.0 }, i: { ih: 1.0 }, o: { oh: 1.0 }, u: { ou: 1.0 },
  'æ': { aa: 0.6, ee: 0.4 }, 'ɔ': { aa: 0.3, oh: 0.7 }, 'ə': { aa: 0.4, ih: 0.3 },
  'ɪ': { ih: 1.0 }, 'ʊ': { ou: 0.8, oh: 0.2 },
  m: {}, b: {}, p: {}, f: { ou: 0.2 }, v: { ou: 0.2 }, w: { ou: 0.8 },
  r: { ou: 0.4 }, l: { ih: 0.2 }, t: {}, d: {}, n: {},
  s: { ih: 0.3 }, z: { ih: 0.3 }, k: {}, g: {}, h: { aa: 0.3 },
  j: { ih: 0.5 }, y: { ih: 0.5 },
  ' ': {}, ',': {}, '.': {}, '!': {}, '?': {},
}
