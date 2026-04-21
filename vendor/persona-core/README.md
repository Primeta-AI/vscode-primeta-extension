# @primeta/persona-core

Shared VRM persona rendering core — Three.js scene, facial expressions, lip sync, FBX retargeting, and TTS streaming.

## Installation

```bash
bun add @primeta/persona-core
```

The package requires `three` (>=0.160.0) and `@pixiv/three-vrm` (>=3.0.0) as peer dependencies.

## Architecture

```
AvatarController (orchestrator)
├── FacialExpressionState — emotion blending, decay, blinking
├── AnimationManager — FBX body animations with crossfade
└── Procedural fallback — breathing/swaying when no FBX clips

TtsClient (speech)
├── ElevenLabs provider — WebSocket streaming + phoneme alignment
├── Cartesia provider — WebSocket streaming + PCM audio
└── speakWithLipSync() — phoneme-driven mouth animation

Utilities
├── retargetClip() — Mixamo FBX → VRM bone retargeting
├── processMessage() — emotion tag extraction + TTS text cleanup
└── Constants — timing, mappings, expression arrays
```

## Exports

```javascript
import {
  AvatarController,   // Main orchestrator
  TtsClient,          // Text-to-speech streaming
  retargetClip,       // FBX retargeting
  processMessage,     // Message parsing
  sanitizeForTts,     // Clean text for TTS
  stripTags,          // Remove bracket tags
  extractEmotionTag,  // Parse [emotion:intensity]
} from "@primeta/persona-core"
```

---

## AvatarController

High-level API that orchestrates facial expressions and body animations on a VRM model.

### Setup

```javascript
import { AvatarController } from "@primeta/persona-core"

const avatar = new AvatarController(THREE)
avatar.initModel(vrm, clock, mixer)
```

### Methods

| Method | Description |
|--------|-------------|
| `initModel(vrm, clock, mixer)` | Initialize with loaded VRM model and Three.js AnimationMixer |
| `setAnimation(trigger, intensity?)` | Trigger emotion + body animation from tag string (e.g. `"[joy]"`, `"[angry:0.5]"`) |
| `setEmotion(emotion, intensity?)` | Set facial emotion only, no body animation |
| `playAnimation(name)` | Play a named body animation only, no facial change |
| `setupProcedural()` | Set up procedural idle animation fallback (breathing, swaying) |
| `update(delta)` | Call every frame from the render loop |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `facial` | `FacialExpressionState` | Facial expression state manager |
| `anims` | `AnimationManager` | Body animation manager |
| `vrm` | VRM | The loaded VRM model |

---

## FacialExpressionState

Manages facial blend shapes with emotion targeting, smooth lerping, automatic decay, and periodic blinking.

### Supported Emotions

`neutral`, `joy`, `fun`, `angry`, `sorrow`, `surprised`, `confused`, `curious`, `proud`, `embarrassed`, `excited`, `concerned`, `thinking`, `listening`

### Methods

| Method | Description |
|--------|-------------|
| `setEmotion(emotion, intensity, clockTime)` | Set target emotion with intensity 0.0–1.0 |
| `setExpressionNameMap(map)` | Provide VRM-specific expression name mappings |
| `resolveExprName(canonical)` | Get VRM-specific name for a canonical expression |
| `reset()` | Reset all expression states to zero |
| `update(delta, clockTime, vrm)` | Update each frame — handles lerp, decay, blinking |

### Behavior

- Emotions lerp toward target at `EMOTION_LERP_SPEED` (3.0)
- After `EMOTION_DECAY_DELAY` (4.0s) without a new emotion, expressions decay exponentially
- Blinking occurs randomly every 2–6 seconds with a 0.15s duration
- Blinking is suppressed during the `surprised` emotion

---

## AnimationManager

Manages body animation actions on a Three.js AnimationMixer with crossfade transitions.

### Methods

| Method | Description |
|--------|-------------|
| `setMixer(mixer)` | Set the Three.js AnimationMixer |
| `registerAction(name, clip, loopMode?)` | Register an animation clip. `loopMode`: `"loop"` (default), `"once"`, `"once_then_idle"` |
| `play(name)` | Play a named animation with crossfade (0.4s) |
| `reset()` | Clear all registered actions |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `actions` | Object | Map of name → THREE.AnimationAction |
| `currentAnimName` | String | Name of currently playing animation |
| `hasAnimations` | Boolean | True if any actions are registered |

---

## TtsClient

Client-side TTS streaming via WebSocket. Supports ElevenLabs and Cartesia providers with real-time lip sync.

### Setup

```javascript
import { TtsClient } from "@primeta/persona-core"

const tts = new TtsClient({
  playAnimation: (name) => avatar.playAnimation(name),
  onSpeechDone: () => { /* speech finished */ },
  onTokenExpired: () => { /* refresh token */ },
  audioContext: null, // optional, creates one if needed
})

tts.configure({
  provider: "elevenlabs",  // or "cartesia"
  token: "...",
  voiceId: "...",
  wsUrl: "wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input",
  modelId: "eleven_flash_v2_5",
})
```

### Methods

| Method | Description |
|--------|-------------|
| `configure({ provider, token, voiceId, wsUrl, modelId })` | Set TTS credentials and provider |
| `speak(text, vrm)` | Synthesize and play text with lip sync |
| `cancel()` | Cancel in-progress speech |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `muted` | Boolean | Controls whether speech plays audio |
| `isConfigured` | Boolean | True if provider, token, and voiceId are set |
| `needsToken` | Boolean | True if token is missing or consumed |

### Providers

**ElevenLabs:** WebSocket streaming with phoneme alignment data for precise lip sync. Uses `eleven_flash_v2_5` model. Requires single-use tokens.

**Cartesia:** WebSocket streaming with raw PCM f32le audio. Uses approximate phoneme timing for lip sync.

---

## speakWithLipSync()

Low-level function that plays audio with phoneme-driven mouth animation on a VRM model.

```javascript
import { speakWithLipSync } from "@primeta/persona-core/lip-sync"

const handle = speakWithLipSync({
  audioBase64: "...",     // base64 audio (or audioBuffer)
  audioBuffer: null,      // raw ArrayBuffer (takes priority)
  phonemes: [             // { character, start, end } in seconds
    { character: "H", start: 0.0, end: 0.05 },
    { character: "eh", start: 0.05, end: 0.12 },
  ],
  vrm: vrm,
  audioCtx: audioContext,
  playAnimation: (name) => avatar.playAnimation(name),
  onDone: () => { /* playback finished */ },
})

// Cancel playback
handle.cancel()
```

### Mouth Expressions

Maps phoneme characters to VRM mouth blend shapes:

- **VRM 1.0:** `aa`, `ee`, `ih`, `oh`, `ou`
- **VRM 0.x:** `A`, `E`, `I`, `O`, `U` (auto-detected)

---

## retargetClip()

Retargets Mixamo FBX animations onto VRM normalized bone structure.

```javascript
import { retargetClip } from "@primeta/persona-core"

const clip = retargetClip(THREE, fbxClip, fbxRoot, vrm)
if (clip) {
  avatar.anims.registerAction("idle", clip)
}
```

### Supported Bones

22 Mixamo bones mapped to VRM humanoid structure:

Hips, Spine, Spine1, Spine2, Neck, Head, LeftShoulder, LeftArm, LeftForeArm, LeftHand, RightShoulder, RightArm, RightForeArm, RightHand, LeftUpLeg, LeftLeg, LeftFoot, LeftToeBase, RightUpLeg, RightLeg, RightFoot, RightToeBase

---

## Text Processing

### processMessage(rawText)

One-pass processing of message text. Extracts emotion tags and prepares text for display and TTS.

```javascript
import { processMessage } from "@primeta/persona-core"

const { emotion, intensity, displayText, ttsText } = processMessage(
  "[joy:0.8] That's great news, Dalton!"
)
// emotion: "joy"
// intensity: 0.8
// displayText: "That's great news, Dalton!"
// ttsText: "That's great news, Dalton!"
```

### Other Utilities

| Function | Description |
|----------|-------------|
| `extractEmotionTag(text)` | Extract `[emotion]` or `[emotion:intensity]` → `{ emotion, intensity }` |
| `extractSpokenText(text)` | Extract content between `[spoken]...[/spoken]` tags |
| `stripTags(text)` | Remove all bracket tags from text |
| `sanitizeForTts(text)` | Clean text for TTS — removes code blocks, markdown, links, excess whitespace |

---

## Constants

### Timing

| Constant | Value | Description |
|----------|-------|-------------|
| `CROSSFADE_DURATION` | 0.4s | Animation crossfade time |
| `EMOTION_DECAY_DELAY` | 4.0s | Seconds before emotion starts fading |
| `EMOTION_DECAY_SPEED` | 1.5 | Exponential decay rate |
| `EMOTION_LERP_SPEED` | 3.0 | Expression interpolation speed |
| `BLINK_DURATION` | 0.15s | Blink animation length |

### Expression Arrays

| Constant | Values |
|----------|--------|
| `MOUTH_EXPRESSIONS` | `aa`, `ee`, `ih`, `oh`, `ou` |
| `FACE_EXPRESSIONS` | `happy`, `sad`, `angry`, `surprised`, `relaxed` |

### Mappings

| Constant | Description |
|----------|-------------|
| `CANONICAL_TO_VRM0` | VRM 1.0 expression names → VRM 0.x equivalents |
| `STATE_FACE_MAP` | Emotion states → expression names with weights |
| `MIXAMO_VRM_MAP` | 22-bone Mixamo → VRM humanoid bone mapping |
| `PHONEME_MAP` | Character → mouth expression mapping |

---

## Integration Examples

### Rails (Stimulus Controller)

```javascript
// avatar_controller.js
import { AvatarController, retargetClip } from "@primeta/persona-core"

this._avatar = new AvatarController(this.THREE)
this._avatar.initModel(vrm, clock, mixer)

// Load and retarget FBX animation
const clip = retargetClip(this.THREE, fbx.animations[0], fbx, this._avatar.vrm)
this._avatar.anims.registerAction("idle", clip, "loop")

// In render loop
this._avatar.update(delta)
```

### Rails (Chat Controller with TTS)

```javascript
// chat_controller.js
import { TtsClient, processMessage } from "@primeta/persona-core"

this._ttsClient = new TtsClient({
  playAnimation: (name) => this.triggerAnimation(name),
  onSpeechDone: () => this._onSpeechDone(),
  onTokenExpired: () => this._refreshTtsToken(),
})

// On new message
const { emotion, intensity, ttsText } = processMessage(rawText)
this.triggerAnimation(`[${emotion}]`, intensity)
this._ttsClient.speak(ttsText, vrm)
```

### VS Code Extension

```javascript
// avatar-renderer.js
import { AvatarController, TtsClient, retargetClip } from "@primeta/persona-core"

const avatar = new AvatarController(THREE)
const tts = new TtsClient({
  playAnimation: (name) => avatar.playAnimation(name),
  onSpeechDone: () => vscode.postMessage({ type: "speechDone" }),
  onTokenExpired: () => requestTtsToken(),
})

avatar.initModel(vrm, clock, mixer)
tts.speak(text, avatar.vrm)
```
