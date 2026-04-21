import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

export interface TtsResult {
  audioBase64: string;
  phonemes: Array<{ character: string; start: number; end: number }>;
}

export interface PrimetaConfig {
  user: {
    display_name: string;
    tts_provider: string;
    tts_configured: boolean;
  };
  persona: {
    id: number;
    name: string;
    slug: string;
    model_url: string | null;
    voice_id: string | null;
    animation_urls: Record<string, string>;
  } | null;
  personas?: Array<{ id: number; name: string; slug: string }>;
  bridges?: Array<{ name: string; type: string }>;
}

function getSettings() {
  const config = vscode.workspace.getConfiguration('primeta');
  return {
    serverUrl: config.get<string>('serverUrl', 'https://primeta.ai'),
    apiToken: config.get<string>('apiToken', ''),
  };
}

function apiRequest(method: string, path: string, body?: string): Promise<{ statusCode: number; body: Buffer }> {
  const settings = getSettings();
  const url = new URL(path, settings.serverUrl);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${settings.apiToken}`,
    'Accept': 'application/json',
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  return new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode || 500, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export async function fetchConfig(bridgeName?: string): Promise<PrimetaConfig> {
  const settings = getSettings();
  if (!settings.apiToken) {
    throw new Error('No API token configured. Set primeta.apiToken in VS Code settings (find your token on the Primeta Settings page).');
  }

  const path = bridgeName
    ? `/api/config?bridge_name=${encodeURIComponent(bridgeName)}`
    : '/api/config';

  const res = await apiRequest('GET', path);

  if (res.statusCode === 401) {
    throw new Error('Invalid API token. Check primeta.apiToken in settings.');
  }
  if (res.statusCode !== 200) {
    throw new Error(`Server error: ${res.statusCode}`);
  }

  return JSON.parse(res.body.toString());
}

/**
 * Download a file from any URL, following redirects. Returns raw Buffer.
 * Used to fetch model/animation files from Active Storage proxy URLs
 * in Node.js (no CORS issues) before passing to the webview.
 */
export async function downloadFile(fileUrl: string, maxRedirects = 5): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const url = new URL(fileUrl);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    transport.get(fileUrl, (res) => {
      // Follow redirects
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
        if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
        return downloadFile(res.headers.location, maxRedirects - 1).then(resolve, reject);
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`Download failed: ${res.statusCode}`));
      }

      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

export interface TtsTokenData {
  provider: string;
  token: string;
  voice_id: string;
  ws_url: string;
  model_id?: string;
}

export async function fetchTtsToken(voiceId?: string): Promise<TtsTokenData> {
  const body: Record<string, string> = {};
  if (voiceId) body.voice_id = voiceId;

  const res = await apiRequest('POST', '/api/tts_token', JSON.stringify(body));

  if (res.statusCode === 401) {
    throw new Error('Invalid API token.');
  }
  if (res.statusCode !== 200) {
    const errBody = res.body.toString().slice(0, 200);
    throw new Error(`TTS token error: ${res.statusCode} ${errBody}`);
  }

  return JSON.parse(res.body.toString());
}

export async function switchPersona(personaId: number): Promise<PrimetaConfig> {
  const res = await apiRequest('PATCH', '/api/config', JSON.stringify({
    persona_id: personaId,
  }));

  if (res.statusCode !== 200) {
    throw new Error(`Failed to switch persona: ${res.statusCode}`);
  }

  return JSON.parse(res.body.toString());
}

export async function sendMessage(text: string, bridgeName?: string): Promise<void> {
  const res = await apiRequest('POST', '/api/messages', JSON.stringify({
    text,
    bridge_name: bridgeName,
  }));

  if (res.statusCode === 401) {
    throw new Error('Invalid API token.');
  }
  if (res.statusCode === 422) {
    const data = JSON.parse(res.body.toString());
    throw new Error(data.error || 'No bridge connected');
  }
  if (res.statusCode !== 202) {
    throw new Error(`Send failed: ${res.statusCode}`);
  }
}

export async function synthesize(text: string, voiceId?: string): Promise<TtsResult> {
  const settings = getSettings();
  if (!settings.apiToken) {
    throw new Error('No API token configured.');
  }

  const res = await apiRequest('POST', '/api/tts', JSON.stringify({
    text,
    voice_id: voiceId,
  }));

  if (res.statusCode === 401) {
    throw new Error('Invalid API token.');
  }
  if (res.statusCode !== 200) {
    const errBody = res.body.toString().slice(0, 200);
    throw new Error(`TTS error: ${res.statusCode} ${errBody}`);
  }

  const data = JSON.parse(res.body.toString());
  return {
    audioBase64: data.audio_base64,
    phonemes: data.phonemes || [],
  };
}
