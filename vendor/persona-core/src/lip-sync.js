import { MOUTH_EXPRESSIONS, PHONEME_MAP } from './constants.js'

const LERP_SPEED = 12

// VRM 0.x uses uppercase single-letter viseme names
const VRM0_MOUTH_MAP = { aa: 'A', ee: 'E', ih: 'I', oh: 'O', ou: 'U' }

/**
 * Build a name map for mouth expressions, falling back to VRM 0.x names.
 */
function buildMouthNameMap(manager) {
  if (!manager) return {}
  const has = (name) => { try { return manager.getExpression(name) != null } catch { return false } }
  const map = {}
  for (const expr of MOUTH_EXPRESSIONS) {
    if (has(expr)) {
      map[expr] = expr
    } else if (VRM0_MOUTH_MAP[expr] && has(VRM0_MOUTH_MAP[expr])) {
      map[expr] = VRM0_MOUTH_MAP[expr]
    }
  }
  return map
}

function getTargetWeights(character) {
  return PHONEME_MAP[character.toLowerCase()] || {}
}

function lerp(a, b, t) {
  return a + (b - a) * t
}

/**
 * Play audio with phoneme-driven lip sync on a VRM model.
 *
 * @param {Object} opts
 * @param {string} [opts.audioBase64] - Base64-encoded audio data
 * @param {ArrayBuffer} [opts.audioBuffer] - Raw audio data (takes priority over audioBase64)
 * @param {Array}  opts.phonemes - Array of { character, start, end }
 * @param {VRM}    opts.vrm - The VRM instance
 * @param {Function} opts.playAnimation - Function to trigger body animations
 * @param {Function} opts.onDone - Called when speech finishes
 * @returns {{ cancel: Function }} Handle to cancel playback
 */
export function speakWithLipSync({ audioBase64, audioBuffer, phonemes, vrm, avatar, audioCtx, audioDestination, playAnimation, onDone, skipAnimationStart }) {
  if (!skipAnimationStart) playAnimation('talking')
  if (avatar?.facial) avatar.facial.suppressMouthOverride = true

  let cancelled = false
  let audioSource = null
  let animFrameId = null
  const outerMouthMap = buildMouthNameMap(vrm?.expressionManager)

  const cancel = () => {
    if (cancelled) return
    cancelled = true
    if (animFrameId) cancelAnimationFrame(animFrameId)
    try { audioSource?.stop() } catch {}
    if (audioEl) { audioEl.pause(); audioEl.src = '' }
    if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null }
    if (avatar?.facial) avatar.facial.suppressMouthOverride = false
    const manager = vrm?.expressionManager
    if (manager) {
      for (const expr of MOUTH_EXPRESSIONS) {
        manager.setValue(outerMouthMap[expr] || expr, 0)
      }
    }
    // Resolve the outer promise so the TTS queue doesn't stall waiting for
    // an onended that pause() never produces.
    if (!finished) {
      finished = true
      onDone?.()
    }
  }

  // Track the <audio> element for cancellation
  let audioEl = null
  let blobUrl = null
  // Hoisted so the catch block can read it — `let` inside try is block-scoped
  // and previously caused a ReferenceError when play() rejected, swallowing
  // onDone() and hanging the TTS queue.
  let finished = false

  ;(async () => {
    try {
      // Accept either raw ArrayBuffer or base64-encoded audio
      let rawBuffer
      if (audioBuffer) {
        // Clone the ArrayBuffer since decodeAudioData consumes it
        rawBuffer = audioBuffer.slice ? audioBuffer.slice(0) : audioBuffer
      } else if (audioBase64) {
        const raw = atob(audioBase64)
        rawBuffer = new ArrayBuffer(raw.length)
        const view = new Uint8Array(rawBuffer)
        for (let i = 0; i < raw.length; i++) {
          view[i] = raw.charCodeAt(i)
        }
      } else {
        onDone?.()
        return
      }

      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
      if (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted') await audioCtx.resume()

      // Create a Blob URL from the raw audio data for the <audio> element.
      // Using <audio> instead of AudioBufferSourceNode because iOS switches
      // the audio session to "playback" mode for media elements, which
      // bypasses the silent mode switch. Web Audio API alone stays in
      // "ambient" mode and respects the silent switch.
      const audioBlob = new Blob([audioBuffer || rawBuffer], { type: 'audio/mpeg' })
      blobUrl = URL.createObjectURL(audioBlob)

      // Also decode for duration info (used for fallback timeout)
      const decodedAudio = await audioCtx.decodeAudioData(rawBuffer)
      if (cancelled) return

      // Create <audio> element and route through AudioContext for lip sync
      audioEl = new Audio(blobUrl)
      audioEl.crossOrigin = 'anonymous'
      const sourceNode = audioCtx.createMediaElementSource(audioEl)
      sourceNode.connect(audioDestination || audioCtx.destination)

      const manager = vrm?.expressionManager
      if (!manager) {
        audioEl.onended = () => {
          if (finished) return
          finished = true
          cleanup()
          onDone?.()
        }
        if (cancelled) return
        await audioEl.play()
        return
      }

      const mouthMap = buildMouthNameMap(manager)
      const resolve = (expr) => mouthMap[expr] || expr

      const timeline = (phonemes || []).map(({ character, start, end }) => ({
        start, end, targets: getTargetWeights(character),
      }))

      const current = {}
      for (const expr of MOUTH_EXPRESSIONS) current[expr] = 0

      let playStartTime = null
      let lastFrameTime = performance.now() / 1000

      function animateLipSync() {
        if (cancelled) return
        const now = performance.now() / 1000
        const dt = Math.min(now - lastFrameTime, 0.05)
        lastFrameTime = now

        const elapsed = playStartTime !== null ? (now - playStartTime) : 0
        const lerpFactor = 1 - Math.exp(-LERP_SPEED * dt)

        let target = {}
        for (let i = timeline.length - 1; i >= 0; i--) {
          if (elapsed >= timeline[i].start) {
            target = elapsed > timeline[i].end ? {} : timeline[i].targets
            break
          }
        }

        for (const expr of MOUTH_EXPRESSIONS) {
          const goal = target[expr] || 0
          current[expr] = lerp(current[expr], goal, lerpFactor)
          if (current[expr] < 0.001) current[expr] = 0
          manager.setValue(resolve(expr), current[expr])
        }

        animFrameId = requestAnimationFrame(animateLipSync)
      }

      audioEl.onended = () => {
        if (finished) return
        finished = true
        if (animFrameId) cancelAnimationFrame(animFrameId)
        let closeFrames = 0
        function closeAnimation() {
          closeFrames++
          let allZero = true
          for (const expr of MOUTH_EXPRESSIONS) {
            current[expr] *= 0.7
            if (current[expr] < 0.001) current[expr] = 0
            else allZero = false
            manager.setValue(resolve(expr), current[expr])
          }
          if (!allZero && closeFrames < 15) {
            requestAnimationFrame(closeAnimation)
          } else {
            for (const expr of MOUTH_EXPRESSIONS) manager.setValue(resolve(expr), 0)
            if (avatar?.facial) avatar.facial.suppressMouthOverride = false
            cleanup()
            onDone?.()
          }
        }
        closeAnimation()
      }

      if (cancelled) return
      await audioEl.play()
      playStartTime = performance.now() / 1000
      animFrameId = requestAnimationFrame(animateLipSync)

      // Fallback timeout in case onended never fires
      setTimeout(() => {
        if (!cancelled && !finished) {
          finished = true
          if (animFrameId) cancelAnimationFrame(animFrameId)
          for (const expr of MOUTH_EXPRESSIONS) manager.setValue(resolve(expr), 0)
          if (avatar?.facial) avatar.facial.suppressMouthOverride = false
          cleanup()
          onDone?.()
        }
      }, (decodedAudio.duration + 2) * 1000)
    } catch (err) {
      console.error('[avatar-core] lip sync error:', err)
      // Autoplay blocked (iOS, no user gesture, etc.) — surface this
      // BEFORE onDone so the app can clear the TTS queue before the
      // onDone → drain chain pulls the next sentence and hits the same
      // error. Dispatching after onDone causes every queued sentence to
      // fail independently.
      if (err?.name === 'NotAllowedError' && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('tts:blocked'))
      }
      if (!finished) {
        finished = true
        cleanup()
        onDone?.()
      }
    }
  })()

  function cleanup() {
    if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null }
    if (audioEl) { audioEl.pause(); audioEl.src = ''; audioEl = null }
  }

  return { cancel }
}
