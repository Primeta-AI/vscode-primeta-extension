# Primeta

3D VRM avatar overlay with text-to-speech lip-sync for Claude Code in VS Code.

Primeta brings your AI assistant to life with an animated 3D character that speaks, emotes, and reacts in real time as you work.

## Features

- **3D Avatar Rendering** — Full VRM model support powered by Three.js, displayed in a VS Code side panel
- **Text-to-Speech with Lip-Sync** — Hear responses spoken aloud with phoneme-accurate mouth animation
- **Emotion-Driven Expressions** — Avatar reacts with facial expressions: joy, surprise, anger, sadness, thinking, and more
- **Persona Switching** — Choose from multiple AI personas, each with their own model and personality
- **Real-Time Bridge Connection** — Connects to your Primeta server via ActionCable WebSocket for live communication
- **Idle Animations** — Procedural breathing, swaying, and blinking for a natural presence

## Commands

Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run:

| Command | Description |
|---------|-------------|
| `Primeta: Show Avatar` | Open the avatar panel |
| `Primeta: Hide Avatar` | Close the avatar panel |

## Configuration

Configure the extension in VS Code Settings (`Cmd+,` / `Ctrl+,`) under **Primeta**:

| Setting | Default | Description |
|---------|---------|-------------|
| `primeta.serverUrl` | `https://primeta.ai` | Your Primeta server URL |
| `primeta.apiToken` | — | API token from your Primeta Settings page |

## Getting Started

1. Install the extension from the VS Code Marketplace
2. Click the **Primeta** icon in the activity bar (left sidebar)
3. Click **Set API Token** and paste the token from your [primeta.ai settings page](https://primeta.ai/settings)
4. Click **Show Persona**

For spoken responses driven by Claude Code, set up the MCP bridge by following the [MCP setup guide](https://primeta.ai/docs/mcp). Prefer the Command Palette? `Primeta: Set API Token` and `Primeta: Show Persona` do the same thing. The server URL defaults to `https://primeta.ai`; change it under Settings → Primeta if you run a self-hosted instance.

The avatar panel will open beside your editor and look for a Primeta bridge matching your workspace folder name. Once connected, your AI assistant's responses will appear as spoken, animated messages through the avatar.

If your account has voice configured, the panel will show a one-time **Click to enable voice** prompt — VS Code's webview (like any browser) requires a user click before it will play audio. Click anywhere on the prompt to enable speech for the session.

You can drag inside the avatar panel to rotate the camera around the model and use the scroll wheel to zoom in or out.

## Requirements

- A Primeta account with an API token (required — the extension is a client for the Primeta server, not a standalone tool)
- Network access to your Primeta server
- A configured TTS provider on your Primeta account if you want spoken responses (the avatar still animates and emotes without TTS)

## License

See [LICENSE](LICENSE) for details.
