import { VRMSpringBoneJoint } from '@pixiv/three-vrm-springbone'
import { VRMLookAtExpressionApplier, VRMLookAtRangeMap } from '@pixiv/three-vrm'

// Secondary-bone name fragments that suggest a bone chain worth completing
// when the VRM author only marked the root joint as a spring. VRoid's
// default export commonly includes the second joint in the rig
// (J_Sec_L_Bust2, Hair_02, etc.) but leaves it out of the spring groups,
// which produces a single-pivot motion instead of a natural chain.
const CHAIN_TOKEN = /bust|breast|hair|bangs|tail|ponytail|pigtail|skirt|ribbon|ear|coat|cape/i

// A child bone name qualifies as "the next link" if the parent is named
// "...Prefix<N>" and the child is "...Prefix<N+1>" (possibly with "_end").
function isNextInChain(parentName, childName) {
  if (!parentName || !childName) return false
  const m = parentName.match(/^(.+?)(\d+)(?:_end)?$/i)
  if (!m) return false
  const prefix = m[1]
  const nextIdx = parseInt(m[2], 10) + 1
  return childName === `${prefix}${nextIdx}` ||
         childName === `${prefix}${nextIdx}_end`
}

/**
 * Many VRoid-0.x exports declare a "Bone" lookAt applier but ship without
 * `leftEye` / `rightEye` humanoid bones — so the applier's applyYawPitch is
 * a silent no-op and eye motion (saccades, lookAt targets, future gaze
 * tracking) can never render. Meanwhile the same files often include
 * lookLeft/Right/Up/Down blendshapes that go unused.
 *
 * This fixup detects the mismatch at load and swaps the applier to
 * VRMLookAtExpressionApplier so the blendshapes actually drive the eyes.
 * No-ops if the applier is already expression-based, if the eye bones DO
 * exist (bone applier will work), or if no look blendshapes exist (no
 * fallback to swap to).
 *
 * Returns true if the applier was swapped.
 */
export function fixupLookAtApplier(vrm) {
  const lookAt = vrm?.lookAt
  const applier = lookAt?.applier
  if (!applier) return false

  // Bail if already expression-based
  if (applier.constructor?.type !== 'bone') return false

  // If eye bones exist, the bone applier works — don't touch it
  const humanoid = vrm.humanoid
  const hasLeftEye = humanoid?.getRawBoneNode('leftEye') != null
  const hasRightEye = humanoid?.getRawBoneNode('rightEye') != null
  if (hasLeftEye && hasRightEye) return false

  // Need at least one look-* blendshape to swap to expression applier
  const em = vrm.expressionManager
  if (!em) return false
  const hasAnyLookExpr = ['lookLeft', 'lookRight', 'lookUp', 'lookDown']
    .some((name) => {
      try { return em.getExpression(name) != null } catch { return false }
    })
  if (!hasAnyLookExpr) return false

  // Build expression-scale range maps (output 0-1, not the 10x that bone
  // appliers use for degree output). Using three-vrm's default inputMaxValue
  // of 90° which matches the schema default.
  const mk = () => new VRMLookAtRangeMap(90, 1)
  lookAt.applier = new VRMLookAtExpressionApplier(em, mk(), mk(), mk(), mk())
  return true
}

/**
 * After a VRM is loaded, extend any incomplete secondary-bone spring chains
 * so physics propagates through the whole chain instead of just the root
 * pivot. Uses the parent joint's own settings + colliders so author tuning
 * is preserved — this only adds bones to existing springs, never fabricates
 * physics on chains the author chose to leave static.
 *
 * Returns the number of joints added (for logging).
 */
export function extendPartialSpringChains(vrm) {
  const manager = vrm?.springBoneManager
  if (!manager) return 0

  const alreadySprung = new Set()
  for (const j of manager.joints) alreadySprung.add(j.bone)

  // Snapshot before mutation so we don't chase joints we just added.
  const seedJoints = Array.from(manager.joints)
  let added = 0

  for (const parent of seedJoints) {
    const parentName = parent.bone?.name
    if (!parentName || !CHAIN_TOKEN.test(parentName)) continue
    if (!parent.bone.children) continue

    for (const child of parent.bone.children) {
      if (alreadySprung.has(child)) continue
      if (!isNextInChain(parentName, child.name)) continue

      const settings = parent.settings ? { ...parent.settings } : undefined
      const tail = (child.children && child.children[0]) || null
      const joint = new VRMSpringBoneJoint(
        child,
        tail,
        settings,
        parent.colliderGroups || []
      )
      manager.addJoint(joint)
      alreadySprung.add(child)
      added++
    }
  }

  return added
}
