import * as vscode from 'vscode';
import * as path from 'path';
import { fetchConfig, fetchTtsToken, downloadFile, PrimetaConfig } from '../tts/tts-client';
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
      'Primeta Avatar',
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
      } else if (msg.type === 'requestTtsToken') {
        this.handleTtsTokenRequest();
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
   * Send text to the webview for client-side TTS.
   * Fetches a session token from the server if needed, then lets
   * the webview handle the TTS WebSocket connection directly.
   */
  async sendTtsText(text: string) {
    if (!this.config?.user.tts_configured) return;

    this.panel.webview.postMessage({
      type: 'speak',
      text,
    });
  }

  /**
   * Called when the webview requests a TTS token (via onTokenExpired in TtsClient).
   * Fetches from the server and sends back to the webview.
   */
  private async handleTtsTokenRequest() {
    try {
      const voiceId = this.config?.persona?.voice_id || undefined;
      const tokenData = await fetchTtsToken(voiceId);
      this.panel.webview.postMessage({
        type: 'ttsToken',
        ttsConfig: tokenData,
      });
    } catch (err: any) {
      console.error('[Primeta TTS] Token fetch failed:', err.message);
      this.panel.webview.postMessage({
        type: 'ttsToken',
        ttsConfig: null,
      });
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

    const iconUri = this.panel.webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'assets', 'icon.png'))
    );

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${this.panel.webview.cspSource} https: blob:; script-src 'nonce-${nonce}' ${this.panel.webview.cspSource}; style-src 'unsafe-inline'; media-src blob:; connect-src https: http: ws: wss: blob:;">
  <title>Primeta Avatar</title>
  <style>
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
      border-radius: 50%;
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
        filter: drop-shadow(0 0 6px rgba(232, 93, 38, 0.3));
        opacity: 0.7;
      }
      50% {
        filter: drop-shadow(0 0 20px rgba(232, 93, 38, 0.8));
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
    #bridge-select:focus { outline: 1px solid rgba(232, 93, 38, 0.5); }

    /* Sound toggle */
    #sound-toggle {
    }
    #sound-btn {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 6px 12px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.15);
      background: rgba(0,0,0,0.5);
      backdrop-filter: blur(8px);
      color: rgba(255,255,255,0.5);
      font-size: 11px;
      font-family: var(--vscode-font-family, monospace);
      cursor: pointer;
      transition: all 0.2s;
    }
    #sound-btn:hover {
      background: rgba(232, 93, 38, 0.2);
      border-color: rgba(232, 93, 38, 0.4);
      color: rgba(255,255,255,0.8);
    }
    #sound-btn.active {
      border-color: rgba(232, 93, 38, 0.5);
      color: rgba(232, 93, 38, 0.9);
    }
    #sound-btn svg { width: 14px; height: 14px; }
  </style>
</head>
<body>
  <div id="avatar-area">
    <canvas id="avatar-canvas"></canvas>
    <div id="status"></div>
    <div id="waiting-state">
      <img id="waiting-icon" src="${iconUri}" alt="Primeta" />
      <div id="waiting-text">Waiting for bridge...</div>
      <div id="waiting-workspace"></div>
    </div>
    <div id="toolbar">
      <select id="bridge-select" title="Switch session">
        <option value="">No bridges</option>
      </select>
      <div id="sound-toggle">
        <button id="sound-btn" title="Toggle sound">
          <svg id="sound-icon-off" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
            <path d="M10 3.75a.75.75 0 00-1.264-.546L4.703 7H3.167a.75.75 0 00-.7.48A6.985 6.985 0 002 10c0 .887.165 1.737.468 2.52.111.29.39.48.699.48h1.536l4.033 3.796A.75.75 0 0010 16.25V3.75z" />
            <path fill-rule="evenodd" d="M14.28 5.22a.75.75 0 011.06 0l.72.72.72-.72a.75.75 0 111.06 1.06l-.72.72.72.72a.75.75 0 11-1.06 1.06l-.72-.72-.72.72a.75.75 0 01-1.06-1.06l.72-.72-.72-.72a.75.75 0 010-1.06z" clip-rule="evenodd" />
          </svg>
          <svg id="sound-icon-on" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" style="display:none;">
            <path d="M10 3.75a.75.75 0 00-1.264-.546L4.703 7H3.167a.75.75 0 00-.7.48A6.985 6.985 0 002 10c0 .887.165 1.737.468 2.52.111.29.39.48.699.48h1.536l4.033 3.796A.75.75 0 0010 16.25V3.75z" />
            <path d="M15.95 5.05a.75.75 0 00-1.06 1.06 5.5 5.5 0 010 7.78.75.75 0 001.06 1.06 7 7 0 000-9.9z" />
            <path d="M13.829 7.172a.75.75 0 00-1.06 1.06 2.5 2.5 0 010 3.536.75.75 0 001.06 1.06 4 4 0 000-5.656z" />
          </svg>
        </button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
