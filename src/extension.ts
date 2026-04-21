import * as vscode from 'vscode';
import { ActionCableClient } from './cable/actioncable-client';
import { AvatarPanel } from './webview/avatar-panel';
import { fetchConfig } from './tts/tts-client';

let panel: AvatarPanel | undefined;
let cableClient: ActionCableClient | undefined;

/**
 * Get the workspace folder name to match against bridge names.
 * Bridge names in Claude Code default to the project directory name.
 */
function getWorkspaceName(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return folders[0].name;
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('primeta.showAvatar', () => {
      if (panel) {
        panel.reveal();
        return;
      }

      panel = new AvatarPanel(context);

      cableClient = new ActionCableClient({
        onMessage: (msg) => {
          panel?.handleAssistantMessage(msg.text, msg.state, msg.intensity);
        },
        onPersonaChanged: (msg) => {
          panel?.handlePersonaChanged(msg.persona_id);
        },
        onBridgeStatus: (msg) => {
          handleBridgeStatus(msg.event, msg.bridge_name);
        },
      });

      panel.setCableClient(cableClient);

      // Handle bridge switching from the webview dropdown
      panel.onSwitchBridge((bridgeName) => {
        connectToBridge(bridgeName);
      });

      // Connect to WebSocket immediately (no bridge name yet — user-wide events only)
      cableClient.connect();

      // Try to find and auto-connect to a matching bridge
      autoConnectBridge();

      panel.onDispose(() => {
        cableClient?.dispose();
        cableClient = undefined;
        panel = undefined;
      });
    }),

    vscode.commands.registerCommand('primeta.hideAvatar', () => {
      panel?.dispose();
    })
  );
}

/**
 * Check the server for open bridges and auto-connect if one matches
 * the current workspace folder name.
 */
async function autoConnectBridge() {
  const workspaceName = getWorkspaceName();

  try {
    const config = await fetchConfig();
    const bridges = config.bridges || [];

    // Update the bridge selector dropdown
    panel?.updateBridgeList(bridges);

    if (bridges.length === 0) {
      panel?.showWaiting(workspaceName);
      return;
    }

    // Look for a bridge matching the workspace folder name
    const match = workspaceName
      ? bridges.find((b: any) => b.name === workspaceName)
      : null;

    if (match) {
      connectToBridge(match.name);
    } else {
      // Connect to the first available bridge
      connectToBridge(bridges[0].name);
    }
  } catch (err: any) {
    vscode.window.showErrorMessage(`Primeta: ${err.message}`);
    panel?.showWaiting(workspaceName);
  }
}

/**
 * Claim a bridge and load its persona into the avatar panel.
 */
async function connectToBridge(bridgeName: string) {
  cableClient?.claimBridge(bridgeName);
  await panel?.loadBridge(bridgeName);

  // Update the dropdown to reflect current selection
  try {
    const config = await fetchConfig();
    const bridges = config.bridges || [];
    panel?.updateBridgeList(bridges, bridgeName);
  } catch { /* ignore */ }
}

/**
 * Handle bridge connect/disconnect events from the WebSocket.
 */
async function handleBridgeStatus(event: string, bridgeName: string) {
  // Refresh the bridge list on any connect/disconnect
  try {
    const config = await fetchConfig();
    const bridges = config.bridges || [];
    panel?.updateBridgeList(bridges, cableClient?.currentBridge);
  } catch { /* ignore */ }

  const workspaceName = getWorkspaceName();

  if (event === 'connected') {
    // If we're waiting and this bridge matches our workspace, auto-connect
    if (!cableClient?.currentBridge) {
      if (bridgeName === workspaceName) {
        connectToBridge(bridgeName);
      }
    }
  } else if (event === 'disconnected') {
    // If our claimed bridge disconnected, go back to waiting
    if (cableClient?.currentBridge === bridgeName) {
      cableClient.releaseBridge();
      panel?.showWaiting(workspaceName);
    }
  }
}

export function deactivate() {
  panel?.dispose();
  cableClient?.dispose();
}
