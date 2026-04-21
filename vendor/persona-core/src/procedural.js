/**
 * Set up procedural animation fallback when no FBX animations are available.
 * Returns { bones, baseRot } for use in proceduralAnimate().
 */
export function setupProceduralFallback(vrm) {
  const humanoid = vrm?.humanoid
  if (!humanoid) return { bones: {}, baseRot: {} }

  const getRawBone = (name) => {
    if (humanoid.getRawBoneNode) return humanoid.getRawBoneNode(name)
    if (humanoid.getBoneNode) return humanoid.getBoneNode(name)
    return null
  }

  const bones = {
    hips: getRawBone('hips'),
    spine: getRawBone('spine'),
    chest: getRawBone('chest'),
    neck: getRawBone('neck'),
    head: getRawBone('head'),
    leftUpperArm: getRawBone('leftUpperArm'),
    rightUpperArm: getRawBone('rightUpperArm'),
    leftLowerArm: getRawBone('leftLowerArm'),
    rightLowerArm: getRawBone('rightLowerArm'),
  }

  if (bones.leftUpperArm) bones.leftUpperArm.rotation.z = 1.1
  if (bones.rightUpperArm) bones.rightUpperArm.rotation.z = -1.1
  if (bones.leftLowerArm) bones.leftLowerArm.rotation.z = 0.3
  if (bones.rightLowerArm) bones.rightLowerArm.rotation.z = -0.3

  const baseRot = {}
  for (const [key, bone] of Object.entries(bones)) {
    if (!bone) continue
    baseRot[key] = { x: bone.rotation.x, y: bone.rotation.y, z: bone.rotation.z }
  }

  return { bones, baseRot }
}

/**
 * Apply procedural idle animation (breathing, swaying, nodding).
 */
export function proceduralAnimate(t, bones, baseRot) {
  const breathe = Math.sin(t * 1.2) * 0.015
  const sway = Math.sin(t * 0.6) * 0.02
  const nod = Math.sin(t * 0.9) * 0.01

  if (bones.hips && baseRot.hips) {
    bones.hips.rotation.y = baseRot.hips.y + sway * 0.6
    bones.hips.rotation.x = baseRot.hips.x + breathe * 0.2
  }
  if (bones.spine && baseRot.spine) {
    bones.spine.rotation.x = baseRot.spine.x + breathe * 0.6
  }
  if (bones.chest && baseRot.chest) {
    bones.chest.rotation.x = baseRot.chest.x + breathe * 0.4
    bones.chest.rotation.z = baseRot.chest.z + sway * 0.4
  }
  if (bones.neck && baseRot.neck) {
    bones.neck.rotation.x = baseRot.neck.x + nod * 0.3
    bones.neck.rotation.y = baseRot.neck.y + sway * 0.3
  }
  if (bones.head && baseRot.head) {
    bones.head.rotation.x = baseRot.head.x + nod * 0.8
    bones.head.rotation.y = baseRot.head.y + sway * 0.4
  }
  if (bones.leftUpperArm && baseRot.leftUpperArm) {
    bones.leftUpperArm.rotation.z = baseRot.leftUpperArm.z + sway * 0.2
  }
  if (bones.rightUpperArm && baseRot.rightUpperArm) {
    bones.rightUpperArm.rotation.z = baseRot.rightUpperArm.z - sway * 0.2
  }
}
