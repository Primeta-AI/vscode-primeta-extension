import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { fetchConfig, downloadFile, synthesize, PrimetaConfig } from '../tts/tts-client';
import { ActionCableClient } from '../cable/actioncable-client';

export class AvatarPanel {
  private panel: vscode.WebviewPanel;
  private disposeCallbacks: Array<() => void> = [];
  private config: PrimetaConfig | null = null;
  private cableClient: ActionCableClient | null = null;
  private currentBridgeName: string | null = null;
  private onSwitchBridgeCallbacks: Array<(bridgeName: string) => void> = [];

  constructor(private context: vscode.ExtensionContext) {
    this.panel = vscode.window.createWebviewPanel(
      'primetaAvatar',
      'Primeta',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(context.extensionPath, 'dist')),
          vscode.Uri.file(path.join(context.extensionPath, 'assets')),
        ],
      }
    );

    this.panel.webview.html = this.getHtml();

    this.panel.onDidDispose(() => {
      this.disposeCallbacks.forEach(cb => cb());
    });

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'ready') {
        // Webview is ready — show waiting state until extension.ts calls loadBridge
        this.panel.webview.postMessage({ type: 'showWaiting' });
      } else if (msg.type === 'switchBridge') {
        this.onSwitchBridgeCallbacks.forEach(cb => cb(msg.bridgeName));
      }
    });
  }

  setCableClient(client: ActionCableClient) {
    this.cableClient = client;
  }

  /** Show the waiting/empty state in the webview */
  showWaiting(workspaceName?: string | null) {
    this.currentBridgeName = null;
    this.cancelSpeech();
    this.panel.webview.postMessage({
      type: 'showWaiting',
      workspaceName: workspaceName || undefined,
    });
  }

  /**
   * Load a bridge — fetch its config from the server and send
   * the persona model + animations to the webview.
   */
  async loadBridge(bridgeName: string) {
    this.currentBridgeName = bridgeName;

    try {
      this.config = await fetchConfig(bridgeName);

      const persona = this.config.persona;
      if (!persona) {
        vscode.window.showWarningMessage('Primeta: No persona configured for this bridge.');
        return;
      }

      this.panel.webview.postMessage({ type: 'hideWaiting' });
      this.panel.webview.postMessage({ type: 'status', text: `Loading ${persona.name}...` });

      let modelBase64: string | null = null;
      if (persona.model_url) {
        const modelBuffer = await downloadFile(persona.model_url);
        modelBase64 = modelBuffer.toString('base64');
      }

      const animationData: Record<string, string> = {};
      if (persona.animation_urls) {
        for (const [trigger, url] of Object.entries(persona.animation_urls)) {
          try {
            const buf = await downloadFile(url);
            animationData[trigger] = buf.toString('base64');
          } catch { /* skip failed animations */ }
        }
      }

      this.panel.webview.postMessage({
        type: 'config',
        persona: persona.name,
        personaId: persona.id,
        modelBase64,
        animationData,
        voiceId: persona.voice_id,
        bridgeName,
        ttsConfigured: this.config.user.tts_configured,
      });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Primeta: ${err.message}`);
    }
  }

  /**
   * Called when the server broadcasts a persona_changed event.
   * Re-fetches config for the current bridge and swaps the model.
   */
  async handlePersonaChanged(personaId: number) {
    if (!this.currentBridgeName) return;

    try {
      this.config = await fetchConfig(this.currentBridgeName);
      const persona = this.config.persona;
      if (!persona) return;

      this.panel.webview.postMessage({ type: 'status', text: `Switching to ${persona.name}...` });

      let modelBase64: string | null = null;
      if (persona.model_url) {
        const modelBuffer = await downloadFile(persona.model_url);
        modelBase64 = modelBuffer.toString('base64');
      }

      const animationData: Record<string, string> = {};
      if (persona.animation_urls) {
        for (const [trigger, url] of Object.entries(persona.animation_urls)) {
          try {
            const buf = await downloadFile(url);
            animationData[trigger] = buf.toString('base64');
          } catch { /* skip */ }
        }
      }

      this.cancelSpeech();

      this.panel.webview.postMessage({
        type: 'config',
        persona: persona.name,
        personaId: persona.id,
        modelBase64,
        animationData,
        voiceId: persona.voice_id,
        bridgeName: this.currentBridgeName,
        ttsConfigured: this.config.user.tts_configured,
      });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Primeta: ${err.message}`);
    }
  }

  /** Called by ActionCable client when spoken text arrives from the bridge */
  async handleAssistantMessage(text: string, state?: string, intensity?: number) {
    if (state) {
      this.panel.webview.postMessage({ type: 'setEmotion', name: state, intensity: intensity || 1.0 });
    }
    if (text) {
      this.sendTtsText(text);
    }
  }

  /** Update the bridge selector dropdown in the webview */
  updateBridgeList(bridges: Array<{ name: string }>, selectedBridge?: string | null) {
    this.panel.webview.postMessage({
      type: 'updateBridges',
      bridges: bridges.map(b => b.name),
      selectedBridge: selectedBridge || this.currentBridgeName,
    });
  }

  onSwitchBridge(callback: (bridgeName: string) => void) {
    this.onSwitchBridgeCallbacks.push(callback);
  }

  reveal() {
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  /**
   * Synthesize via /api/tts using the Bearer token the extension host
   * holds, then hand the audio + phoneme timeline to the webview for
   * playback. Synth happens here (not in the webview) because the API
   * uses Bearer auth and the webview sandbox has no token access.
   */
  async sendTtsText(text: string) {
    if (!this.config?.user.tts_configured) return;
    try {
      const voiceId = this.config.persona?.voice_id || undefined;
      const { audioBase64, phonemes } = await synthesize(text, voiceId);
      this.panel.webview.postMessage({
        type: 'speakData',
        audioBase64,
        phonemes,
      });
    } catch (err: any) {
      console.error('[Primeta TTS] synth failed:', err.message);
    }
  }

  private cancelSpeech() {
    this.panel.webview.postMessage({ type: 'cancelSpeech' });
  }

  onDispose(callback: () => void) {
    this.disposeCallbacks.push(callback);
  }

  dispose() {
    this.panel.dispose();
  }

  private getHtml(): string {
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'dist', 'webview.js'))
    );

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${this.panel.webview.cspSource} https: blob:; script-src 'nonce-${nonce}' ${this.panel.webview.cspSource}; style-src 'unsafe-inline'; media-src blob: data:; connect-src https: http: ws: wss: blob:;">
  <title>Primeta</title>
  <style>
    /* Primeta brand palette — mirrors @theme tokens in the Rails app
       (app/assets/tailwind/application.css). Keep in sync. */
    :root {
      --primeta-accent: #0d7d6e;
      --primeta-accent-rgb: 13, 125, 110;
      --primeta-accent-dk: #0a635a;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      height: 100vh;
      overflow: hidden;
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #ccc);
      font-family: var(--vscode-font-family, monospace);
      font-size: 13px;
    }
    #avatar-area {
      width: 100%;
      height: 100%;
      position: relative;
    }
    canvas {
      width: 100%;
      height: 100%;
      display: block;
      transition: opacity 0.3s ease;
    }
    #status {
      position: absolute;
      top: 8px;
      left: 8px;
      color: var(--vscode-descriptionForeground, #888);
      font-size: 11px;
      z-index: 1;
    }

    /* Waiting state */
    #waiting-state {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 20px;
      z-index: 10;
      background: var(--vscode-editor-background, #1e1e1e);
    }
    #waiting-state.hidden { display: none; }
    #waiting-icon {
      width: 64px;
      height: 64px;
      color: var(--primeta-accent);
      animation: glow-pulse 2s ease-in-out infinite;
    }
    #waiting-text {
      font-size: 13px;
      color: var(--vscode-descriptionForeground, #888);
      text-align: center;
      line-height: 1.5;
    }
    #waiting-workspace {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #666);
      font-style: italic;
    }
    @keyframes glow-pulse {
      0%, 100% {
        filter: drop-shadow(0 0 6px rgba(var(--primeta-accent-rgb), 0.3));
        opacity: 0.7;
      }
      50% {
        filter: drop-shadow(0 0 20px rgba(var(--primeta-accent-rgb), 0.8));
        opacity: 1;
      }
    }

    /* Bottom toolbar */
    #toolbar {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 30;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 10px;
      background: rgba(0,0,0,0.4);
      backdrop-filter: blur(8px);
      border-top: 1px solid rgba(255,255,255,0.08);
      opacity: 0;
      transform: translateY(4px);
      transition: opacity 0.2s ease, transform 0.2s ease;
    }
    /* Reveal on hover or while any child has focus (keyboard access, open
       bridge dropdown). focus-within keeps the bar up while interacting. */
    #avatar-area:hover #toolbar,
    #toolbar:focus-within {
      opacity: 1;
      transform: translateY(0);
    }
    #bridge-select {
      font-size: 11px;
      font-family: var(--vscode-font-family, monospace);
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 4px;
      color: rgba(255,255,255,0.7);
      padding: 3px 6px;
      cursor: pointer;
      max-width: 160px;
    }
    #bridge-select:focus { outline: 1px solid rgba(var(--primeta-accent-rgb), 0.5); }

    /* Sound toggle — compact square icon button, matches bridge-select height. */
    #sound-btn {
      width: 26px;
      height: 26px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.15);
      background: rgba(255,255,255,0.08);
      color: rgba(255,255,255,0.6);
      cursor: pointer;
      transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    }
    #sound-btn:hover {
      background: rgba(var(--primeta-accent-rgb), 0.18);
      border-color: rgba(var(--primeta-accent-rgb), 0.4);
      color: rgba(255,255,255,0.9);
    }
    #sound-btn.active {
      border-color: rgba(var(--primeta-accent-rgb), 0.5);
      color: var(--primeta-accent);
      background: rgba(var(--primeta-accent-rgb), 0.12);
    }
    #sound-btn svg { width: 14px; height: 14px; display: block; }

    /* Audio unlock overlay — full-screen click target shown when a
       TTS-configured bridge connects, until the user satisfies Chrome's
       autoplay-policy gesture requirement. A small toolbar button gets
       missed, so we overlay the whole panel. Dismissed on first click. */
    #audio-unlock {
      position: absolute;
      inset: 0;
      z-index: 40;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 18px;
      background: rgba(0,0,0,0.72);
      backdrop-filter: blur(10px);
      cursor: pointer;
      color: rgba(255,255,255,0.92);
      font-family: var(--vscode-font-family, monospace);
      text-align: center;
      padding: 24px;
      transition: opacity 0.25s ease;
    }
    #audio-unlock.hidden { opacity: 0; pointer-events: none; }
    #audio-unlock-icon {
      width: 72px;
      height: 72px;
      border-radius: 50%;
      border: 2px solid rgba(var(--primeta-accent-rgb), 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      animation: unlock-pulse 1.8s ease-in-out infinite;
    }
    #audio-unlock-icon svg { width: 36px; height: 36px; color: rgba(var(--primeta-accent-rgb), 0.95); }
    #audio-unlock-title {
      font-size: 15px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    #audio-unlock-sub {
      font-size: 12px;
      opacity: 0.6;
      max-width: 240px;
      line-height: 1.45;
    }
    @keyframes unlock-pulse {
      0%, 100% {
        box-shadow: 0 0 0 0 rgba(var(--primeta-accent-rgb), 0.45);
      }
      50% {
        box-shadow: 0 0 0 14px rgba(var(--primeta-accent-rgb), 0);
      }
    }
  </style>
</head>
<body>
  <div id="avatar-area">
    <canvas id="avatar-canvas"></canvas>
    <div id="status"></div>
    <div id="audio-unlock" class="hidden">
      <div id="audio-unlock-icon">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
          <path d="M10 3.75a.75.75 0 00-1.264-.546L4.703 7H3.167a.75.75 0 00-.7.48A6.985 6.985 0 002 10c0 .887.165 1.737.468 2.52.111.29.39.48.699.48h1.536l4.033 3.796A.75.75 0 0010 16.25V3.75z" />
          <path d="M15.95 5.05a.75.75 0 00-1.06 1.06 5.5 5.5 0 010 7.78.75.75 0 001.06 1.06 7 7 0 000-9.9z" />
          <path d="M13.829 7.172a.75.75 0 00-1.06 1.06 2.5 2.5 0 010 3.536.75.75 0 001.06 1.06 4 4 0 000-5.656z" />
        </svg>
      </div>
      <div id="audio-unlock-title">Click to enable voice</div>
      <div id="audio-unlock-sub">Your browser requires a click before it will play audio.</div>
    </div>
    <div id="waiting-state">
      <svg id="waiting-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="square">
        <path d="M16 14 L12 14 L12 50 L16 50" />
        <path d="M48 14 L52 14 L52 50 L48 50" />
        <circle cx="32" cy="32" r="6" fill="currentColor" stroke="none" />
      </svg>
      <div id="waiting-text">Waiting for connection...</div>
      <div id="waiting-workspace"></div>
    </div>
    <div id="toolbar">
      <select id="bridge-select" title="Switch session">
        <option value="">No bridges</option>
      </select>
      <button id="sound-btn" title="Toggle sound">
          <svg id="sound-icon-off" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
            <path d="M10 3.75a.75.75 0 00-1.264-.546L4.703 7H3.167a.75.75 0 00-.7.48A6.985 6.985 0 002 10c0 .887.165 1.737.468 2.52.111.29.39.48.699.48h1.536l4.033 3.796A.75.75 0 0010 16.25V3.75z" />
            <path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M13.5 7 L18 13 M18 7 L13.5 13" />
          </svg>
          <svg id="sound-icon-on" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" style="display:none;">
            <path d="M10 3.75a.75.75 0 00-1.264-.546L4.703 7H3.167a.75.75 0 00-.7.48A6.985 6.985 0 002 10c0 .887.165 1.737.468 2.52.111.29.39.48.699.48h1.536l4.033 3.796A.75.75 0 0010 16.25V3.75z" />
            <path d="M15.95 5.05a.75.75 0 00-1.06 1.06 5.5 5.5 0 010 7.78.75.75 0 001.06 1.06 7 7 0 000-9.9z" />
            <path d="M13.829 7.172a.75.75 0 00-1.06 1.06 2.5 2.5 0 010 3.536.75.75 0 001.06 1.06 4 4 0 000-5.656z" />
          </svg>
      </button>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// CSP nonces must be unguessable; Math.random() isn't. Using
// crypto.randomBytes — base64 is allowed in nonce values per RFC 7636.
function getNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}
