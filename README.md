# Primeta Avatar

3D VRM avatar overlay with text-to-speech lip-sync for Claude Code in VS Code.

Primeta Avatar brings your AI assistant to life with an animated 3D character that speaks, emotes, and reacts in real time as you work.

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

Configure the extension in VS Code Settings (`Cmd+,` / `Ctrl+,`) under **Primeta Avatar**:

| Setting | Default | Description |
|---------|---------|-------------|
| `primeta.serverUrl` | `https://primeta.ai` | Your Primeta server URL |
| `primeta.apiToken` | — | Bridge API token from your Primeta Settings page |

## Getting Started

1. Install the extension from the VS Code Marketplace
2. Open VS Code Settings and search for "Primeta"
3. Set your **Server URL** (use `https://primeta.ai` or your self-hosted instance)
4. Paste your **API Token** from the Primeta Settings page
5. Run `Primeta: Show Avatar` from the Command Palette

The avatar panel will open beside your editor. Once connected, your AI assistant's responses will appear as spoken, animated messages through the avatar.

## Requirements

- A Primeta account with an API token
- Network access to your Primeta server

## License

See [LICENSE](LICENSE) for details.
