# Changelog

## [0.2.0] - 2026-04-24

### Added

- Saccades — small involuntary eye movements for natural eye contact
- Breathing overlay layered on top of scripted animations
- Spring chain completion for VRoid bust/hair/skirt rigs (full chain physics from a single authored joint)
- LookAt applier fixup — falls back to `lookLeft/Right/Up/Down` blendshapes on VRoid models that ship without dedicated eye bones
- Face-voice emotion parity — mouth reflects the active emotion when not speaking
- User-controllable orbit camera (rotate + zoom; pan disabled, distance clamped)
- One-time audio-unlock overlay shown when a TTS-configured bridge connects (works around Chrome's autoplay policy)

### Changed

- Renamed displayed extension name from "Primeta Avatar" to "Primeta"
- Renamed user-facing setting label from "Bridge API token" to "API token"
- Renamed Show/Hide Avatar commands to Show/Hide Persona (command IDs `primeta.showAvatar`/`hideAvatar` → `primeta.showPersona`/`hidePersona`)
- TTS now synthesized server-side via `/api/tts` and streamed as buffered audio + phonemes (was: WebSocket TTS from the webview, which couldn't authenticate without cookies)
- Sync vendored persona-core to upstream commit d737f04

### Security

- CSP nonce now uses `crypto.randomBytes` instead of `Math.random()`

### Removed

- Dead client-side TTS token-fetch flow (`fetchTtsToken`, `requestTtsToken`, `ttsToken` postMessage protocol, `handleTtsTokenRequest`)
- Unused REST helpers (`switchPersona`, `sendMessage`)
- Sticky-activation `<audio>` trick (irrelevant to the `AudioBufferSourceNode` playback path)

## [0.1.0] - 2026-03-28

### Added

- 3D VRM avatar rendering in a VS Code side panel using Three.js
- Text-to-speech with phoneme-based lip-sync animation
- Emotion-driven facial expressions (joy, surprise, anger, sadness, thinking, and more)
- Persona switching with multiple AI character support
- Real-time bridge connection via ActionCable WebSocket
- Procedural idle animations (breathing, swaying, blinking)
- Commands: Show Avatar, Hide Avatar
- Configuration: server URL and API token settings
