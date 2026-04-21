import { MIXAMO_VRM_MAP } from './constants.js'

/**
 * Normalize Mixamo bone names: "mixamorig:Hips" / "mixamorig_Hips" → "mixamorigHips"
 */
export function normalizeBoneName(name) {
  return name.replace(/^mixamorig[:_]/, 'mixamorig')
}

/**
 * Retarget a Mixamo FBX animation clip onto VRM normalized bones.
 * Port of pixiv/three-vrm's loadMixamoAnimation.js example.
 *
 * @param {THREE} THREE - Three.js module
 * @param {AnimationClip} fbxClip - The source FBX animation clip
 * @param {Group} fbxRoot - The parsed FBX scene root
 * @param {VRM} vrm - The target VRM instance
 * @returns {AnimationClip|null} Retargeted clip, or null if no tracks matched
 */
export function retargetClip(THREE, fbxClip, fbxRoot, vrm) {
  const humanoid = vrm.humanoid
  const isVRM0 = vrm.meta?.metaVersion === '0'
  const tracks = []

  const restRotationInverse = new THREE.Quaternion()
  const parentRestWorldRotation = new THREE.Quaternion()
  const _quatA = new THREE.Quaternion()

  const mixamoHipsNode = fbxRoot.getObjectByName('mixamorigHips') || fbxRoot.getObjectByName('mixamorig:Hips')
  let hipsPositionScale = 0.01
  if (mixamoHipsNode) {
    const motionHipsHeight = mixamoHipsNode.position.y
    if (motionHipsHeight > 0) {
      const vrmHipsHeight = humanoid.normalizedRestPose?.hips?.position?.[1]
        ?? humanoid.getNormalizedBoneNode('hips')?.position?.y
        ?? 1.0
      hipsPositionScale = vrmHipsHeight / motionHipsHeight
    }
  }

  for (const track of fbxClip.tracks) {
    const trackSplitted = track.name.split('.')
    const mixamoRigName = trackSplitted[0]
    const propertyName = trackSplitted[1]

    const normalizedName = normalizeBoneName(mixamoRigName)
    const vrmBoneName = MIXAMO_VRM_MAP[normalizedName]
    const vrmNodeName = humanoid.getNormalizedBoneNode(vrmBoneName)?.name
    const mixamoRigNode = fbxRoot.getObjectByName(mixamoRigName)

    if (vrmNodeName == null || mixamoRigNode == null) continue

    mixamoRigNode.getWorldQuaternion(restRotationInverse).invert()
    mixamoRigNode.parent.getWorldQuaternion(parentRestWorldRotation)

    if (track instanceof THREE.QuaternionKeyframeTrack) {
      for (let i = 0; i < track.values.length; i += 4) {
        const flatQuaternion = track.values.slice(i, i + 4)
        _quatA.fromArray(flatQuaternion)
        _quatA.premultiply(parentRestWorldRotation).multiply(restRotationInverse)
        _quatA.toArray(flatQuaternion)
        flatQuaternion.forEach((v, index) => { track.values[index + i] = v })
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(
        `${vrmNodeName}.${propertyName}`,
        track.times,
        track.values.map((v, i) => (isVRM0 && i % 2 === 0 ? -v : v)),
      ))
    } else if (track instanceof THREE.VectorKeyframeTrack) {
      const value = track.values.map((v, i) =>
        (isVRM0 && i % 3 !== 1 ? -v : v) * hipsPositionScale
      )
      tracks.push(new THREE.VectorKeyframeTrack(
        `${vrmNodeName}.${propertyName}`,
        track.times,
        value,
      ))
    }
  }

  if (tracks.length === 0) return null
  return new THREE.AnimationClip('vrmAnimation', fbxClip.duration, tracks)
}
