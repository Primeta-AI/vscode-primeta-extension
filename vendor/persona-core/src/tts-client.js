import { speakWithLipSync } from './lip-sync.js'

/**
 * TTS client — streams audio from server-side proxy with progressive playback.
 *
 * Usage:
 *   const tts = new TtsClient({ playAnimation, onSpeechDone })
 *   tts.voiceId = 'xxx'
 *   tts.speak(text)
 */
export class TtsClient {
  constructor({ playAnimation, onSpeechDone, audioContext, getVrm, getAvatar }) {
    this._playAnimation = playAnimation
    this._onSpeechDone = onSpeechDone
    this._audioCtx = audioContext || null
    this._getVrm = getVrm
    this._getAvatar = getAvatar
    this._volume = 1.0
    this._currentSpeech = null
    this._proxyUrl = '/tts_proxy'
    this.voiceId = null
    this.muted = true
  }

  _startAmplitudeLipSync(sourceNode) {
    const vrm = this._getVrm?.()
    if (!vrm?.expressionManager) return null

    const avatar = this._getAvatar?.()
    if (avatar?.facial) avatar.facial.suppressMouthOverride = true

    const analyser = this._audioCtx.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.85
    sourceNode.connect(analyser)
    const data = new Uint8Array(analyser.frequencyBinCount)

    const has = (name) => { try { return vrm.expressionManager.getExpression(name) != null } catch { return false } }
    // VRM 1.x lowercase, fall back to VRM 0.x uppercase
    const resolve = (lc, uc) => has(lc) ? lc : (has(uc) ? uc : null)
    const names = {
      aa: resolve('aa', 'A'),
      ih: resolve('ih', 'I'),
      oh: resolve('oh', 'O'),
      ee: resolve('ee', 'E'),
      ou: resolve('ou', 'U'),
    }
    if (!names.aa && !names.ih && !names.oh) {
      if (avatar?.facial) avatar.facial.suppressMouthOverride = false
      return null
    }

    // Sample rate / fftSize → bin Hz width
    const binHz = this._audioCtx.sampleRate / analyser.fftSize
    const bandSum = (loHz, hiHz) => {
      const lo = Math.max(1, Math.floor(loHz / binHz))
      const hi = Math.min(data.length - 1, Math.ceil(hiHz / binHz))
      let sum = 0, n = 0
      for (let i = lo; i <= hi; i++) { sum += data[i]; n++ }
      return n > 0 ? (sum / n) / 255 : 0
    }

    let rafId
    const current = { aa: 0, ih: 0, oh: 0 }
    const SMOOTH = 0.18

    const loop = () => {
      analyser.getByteFrequencyData(data)
      // Rough formant bands: aa ~700Hz, oh ~500Hz, ih ~2000Hz, ee ~2500Hz
      const lowEnergy  = bandSum(80, 500)    // bass / 'oh'-ish
      const midEnergy  = bandSum(500, 1500)  // 'aa'
      const highEnergy = bandSum(1500, 4000) // 'ih'/'ee'

      const overall = Math.min(1, (lowEnergy + midEnergy + highEnergy) * 1.4)
      // If silent, decay all to 0
      if (overall < 0.05) {
        current.aa *= 0.6; current.ih *= 0.6; current.oh *= 0.6
      } else {
        const total = lowEnergy + midEnergy + highEnergy + 0.0001
        const tAa = (midEnergy / total) * overall
        const tIh = (highEnergy / total) * overall * 0.8
        const tOh = (lowEnergy / total) * overall * 0.7
        current.aa += (tAa - current.aa) * SMOOTH
        current.ih += (tIh - current.ih) * SMOOTH
        current.oh += (tOh - current.oh) * SMOOTH
      }

      try {
        if (names.aa) vrm.expressionManager.setValue(names.aa, current.aa < 0.01 ? 0 : current.aa)
        if (names.ih) vrm.expressionManager.setValue(names.ih, current.ih < 0.01 ? 0 : current.ih)
        if (names.oh) vrm.expressionManager.setValue(names.oh, current.oh < 0.01 ? 0 : current.oh)
      } catch {}

      rafId = requestAnimationFrame(loop)
    }
    rafId = requestAnimationFrame(loop)

    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      try {
        if (names.aa) vrm.expressionManager.setValue(names.aa, 0)
        if (names.ih) vrm.expressionManager.setValue(names.ih, 0)
        if (names.oh) vrm.expressionManager.setValue(names.oh, 0)
      } catch {}
      try { analyser.disconnect() } catch {}
      if (avatar?.facial) avatar.facial.suppressMouthOverride = false
    }
  }

  get isConfigured() {
    return !!this.voiceId
  }

  async speak(text, vrmArg, opts = {}) {
    if (this.muted || !this.voiceId) return

    this.cancel()

    if (!this._audioCtx) this._audioCtx = new AudioContext()
    if (this._audioCtx.state === 'suspended') await this._audioCtx.resume()

    if (!this._gainNode) {
      this._gainNode = this._audioCtx.createGain()
      this._gainNode.connect(this._audioCtx.destination)
    }
    this._gainNode.gain.value = this._volume

    try {
      const csrf = document.querySelector('meta[name="csrf-token"]')?.content
      const vrm = vrmArg || this._getVrm?.()
      const useJsonForLipSync = !!vrm?.expressionManager

      const response = await fetch(this._proxyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': useJsonForLipSync ? 'application/json' : 'audio/mpeg',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {})
        },
        body: JSON.stringify({
          text,
          voice_id: this.voiceId,
          message_id: opts.messageId,
          format: useJsonForLipSync ? 'json' : undefined
        })
      })

      if (!response.ok) {
        throw new Error(`TTS proxy error: ${response.status}`)
      }

      if (useJsonForLipSync) {
        const data = await response.json()
        await this._playWithLipSync(data, vrm)
      } else if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mpeg')) {
        await this._playStreaming(response)
      } else {
        await this._playBuffered(response)
      }
    } catch (err) {
      console.error('[TTS]', err)
      this._playAnimation('idle')
      this._onSpeechDone?.()
    }
  }

  cancel() {
    if (this._currentSpeech) {
      this._currentSpeech.cancel()
      this._currentSpeech = null
    }
  }

  async _playWithLipSync(data, vrm, { skipAnimationStart = false } = {}) {
    if (!skipAnimationStart) this._playAnimation('talking')
    const avatar = this._getAvatar?.()
    return new Promise((resolve) => {
      const handle = speakWithLipSync({
        audioBase64: data.audio_base64,
        phonemes: data.phonemes,
        vrm,
        avatar,
        audioCtx: this._audioCtx,
        audioDestination: this._gainNode,
        playAnimation: (name) => this._playAnimation(name),
        skipAnimationStart,
        onDone: () => {
          this._currentSpeech = null
          this._onSpeechDone?.()
          resolve()
        }
      })
      this._currentSpeech = handle
    })
  }

  async _playStreaming(response) {
    const mediaSource = new MediaSource()
    const audio = new Audio()
    audio.src = URL.createObjectURL(mediaSource)

    const sourceNode = this._audioCtx.createMediaElementSource(audio)
    sourceNode.connect(this._gainNode)

    this._playAnimation('talking')
    const stopLipSync = this._startAmplitudeLipSync(sourceNode)

    let cancelled = false
    this._currentSpeech = {
      cancel: () => {
        cancelled = true
        audio.pause()
        URL.revokeObjectURL(audio.src)
        audio.src = ''
        stopLipSync?.()
        this._playAnimation('idle')
        this._onSpeechDone?.()
      }
    }

    await new Promise((resolve) => {
      mediaSource.addEventListener('sourceopen', async () => {
        const sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg')
        const reader = response.body.getReader()

        const appendChunk = (chunk) => {
          return new Promise((res) => {
            if (sourceBuffer.updating) {
              sourceBuffer.addEventListener('updateend', () => res(), { once: true })
            } else {
              sourceBuffer.appendBuffer(chunk)
              sourceBuffer.addEventListener('updateend', () => res(), { once: true })
            }
          })
        }

        let started = false
        while (true) {
          if (cancelled) break
          const { done, value } = await reader.read()
          if (done) break
          await appendChunk(value)
          if (!started) {
            audio.play().catch(() => {})
            started = true
          }
        }

        if (!cancelled) {
          if (mediaSource.readyState === 'open') mediaSource.endOfStream()

          const cleanup = () => {
            URL.revokeObjectURL(audio.src)
            stopLipSync?.()
            this._currentSpeech = null
            this._playAnimation('idle')
            this._onSpeechDone?.()
            resolve()
          }

          if (audio.ended) {
            cleanup()
          } else {
            audio.onended = cleanup
          }
        } else {
          resolve()
        }
      }, { once: true })
    })
  }

  async _playBuffered(response) {
    const arrayBuffer = await response.arrayBuffer()
    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      this._playAnimation('idle')
      this._onSpeechDone?.()
      return
    }

    this._playAnimation('talking')

    // Use <audio> element instead of AudioBufferSourceNode so iOS
    // switches to "playback" audio session (bypasses silent switch).
    const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' })
    const blobUrl = URL.createObjectURL(blob)
    const audio = new Audio(blobUrl)
    const sourceNode = this._audioCtx.createMediaElementSource(audio)
    sourceNode.connect(this._gainNode)
    const stopLipSync = this._startAmplitudeLipSync(sourceNode)

    audio.onended = () => {
      stopLipSync?.()
      URL.revokeObjectURL(blobUrl)
      this._currentSpeech = null
      this._onSpeechDone?.()
    }

    await audio.play()
    this._currentSpeech = {
      cancel: () => {
        audio.pause()
        audio.src = ''
        URL.revokeObjectURL(blobUrl)
        stopLipSync?.()
        this._playAnimation('idle')
        this._onSpeechDone?.()
      }
    }
  }
}
