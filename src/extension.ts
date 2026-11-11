import * as vscode from 'vscode';
import { ActionCableClient } from './cable/actioncable-client';
import { AvatarPanel } from './webview/avatar-panel';
import { fetchConfig } from './tts/tts-client';
import { selectAutoConnectBridge } from './bridge-selection';

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

function updateHasApiTokenContext() {
  const token = vscode.workspace.getConfiguration('primeta').get<string>('apiToken', '');
  vscode.commands.executeCommand('setContext', 'primeta.hasApiToken', !!token);
}

export function activate(context: vscode.ExtensionContext) {
  // Drive the sidebar's two viewsWelcome states ("enter a token" vs
  // "open the avatar") based on whether an API token is configured.
  updateHasApiTokenContext();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('primeta.apiToken')) updateHasApiTokenContext();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('primeta.setApiToken', async () => {
      const current = vscode.workspace.getConfiguration('primeta').get<string>('apiToken', '');
      const value = await vscode.window.showInputBox({
        title: 'Primeta API Token',
        prompt: 'Paste the token from your primeta.ai settings page',
        placeHolder: 'Your API token',
        password: true,
        value: current,
        ignoreFocusOut: true,
      });
      if (value === undefined) return; // cancelled
      await vscode.workspace.getConfiguration('primeta').update(
        'apiToken',
        value.trim(),
        vscode.ConfigurationTarget.Global,
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('primeta.showPersona', () => {
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
      }, {
        getSettings: () => {
          const config = vscode.workspace.getConfiguration('primeta');
          return {
            serverUrl: config.get<string>('serverUrl', 'https://primeta.ai'),
            apiToken: config.get<string>('apiToken', ''),
          };
        },
      });

      panel.setCableClient(cableClient);

      // Handle bridge switching from the webview dropdown
      panel.onSwitchBridge((bridgeName) => {
        connectToBridge(bridgeName);
      });

      // Connect to WebSocket immediately (no bridge name yet — user-wide events only)
      void cableClient.connect();

      // Try to find and auto-connect to a matching bridge
      autoConnectBridge();

      panel.onDispose(() => {
        cableClient?.dispose();
        cableClient = undefined;
        panel = undefined;
      });
    }),

    vscode.commands.registerCommand('primeta.hidePersona', () => {
      panel?.dispose();
    })
  );
}

/**
 * Check the server for open bridges and auto-connect only if one matches
 * the current workspace folder name. Otherwise stay in the waiting state and
 * let the user pick a session from the dropdown — never claim an arbitrary
 * bridge (it may belong to another project's session).
 */
async function autoConnectBridge() {
  const workspaceName = getWorkspaceName();

  try {
    const config = await fetchConfig();
    const bridges = config.bridges || [];

    const match = selectAutoConnectBridge(bridges, workspaceName);
    if (match) {
      panel?.updateBridgeList(bridges, match);
      connectToBridge(match);
    } else {
      panel?.showWaiting(workspaceName, bridges.length);
      // No selection: the dropdown shows a "select a session" placeholder.
      panel?.updateBridgeList(bridges, null);
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
      const match = selectAutoConnectBridge([{ name: bridgeName }], workspaceName);
      if (match) connectToBridge(match);
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
