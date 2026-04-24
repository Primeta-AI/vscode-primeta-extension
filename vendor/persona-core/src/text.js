/**
 * Text processing utilities for persona messages.
 * Handles emotion tag parsing, TTS sanitization, and spoken text extraction.
 */

/**
 * Extract an emotion tag with optional intensity from text.
 * Matches patterns like [joy], [angry:0.5], [neutral:1.0]
 *
 * @param {string} text
 * @returns {{ emotion: string, intensity: number } | null}
 */
export function extractEmotionTag(text) {
  const match = text.match(/\[([a-z]+)(?::(\d*\.?\d+))?\]/i)
  if (!match) return null
  return {
    emotion: match[1],
    intensity: match[2] ? parseFloat(match[2]) : 1.0,
  }
}

/**
 * Extract content between [spoken]...[/spoken] tags.
 * Falls back to the full text if no spoken tags are found.
 *
 * @param {string} text
 * @returns {string}
 */
export function extractSpokenText(text) {
  const match = text.match(/\[spoken\]([\s\S]*?)\[\/spoken\]/i)
  return match ? match[1] : text
}

/**
 * Strip all bracket tags (emotion, spoken, etc.) from text.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripTags(text) {
  return text
    .replace(/\[spoken\]|\[\/spoken\]/gi, '')
    .replace(/\[[^\]]+\]\s*/g, '')
    .trim()
}

/**
 * Sanitize text for TTS playback.
 *
 * Only converts `[tag]` → `(tag)` when `tag` is in `allowedTags` — so the
 * voice only emotes in ways this persona's face can also render. Unknown
 * or persona-unsupported tags are dropped entirely rather than rendered
 * as literal bracketed speech. Pass `null` to allow every tag through
 * unfiltered (used for generic sanitization outside a persona context).
 *
 * @param {string} text
 * @param {Set<string>|Array<string>|null} [allowedTags] — lowercase tag names the persona supports
 * @returns {string}
 */
export function sanitizeForTts(text, allowedTags) {
  const set = allowedTags instanceof Set
    ? allowedTags
    : (Array.isArray(allowedTags) ? new Set(allowedTags.map(t => t.toLowerCase())) : null)
  return text
    .replace(/```[\s\S]*?```/g, '')           // code blocks
    .replace(/`[^`]+`/g, '')                   // inline code
    .replace(/\[spoken\]|\[\/spoken\]/gi, '')  // spoken tags
    .replace(/\[([^\]]+)\]/g, (_, inner) => {
      const clean = inner.trim().toLowerCase()
      if (clean.startsWith('/')) return ''     // closing tag
      const tag = clean.split(':')[0]
      if (set === null) return `(${tag})`       // legacy: unconditional convert
      return set.has(tag) ? `(${tag})` : ''
    })
    .replace(/#{1,6}\s+/g, '')                 // markdown headings
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')  // bold/italic
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')   // markdown links → text
    .replace(/^[-*]\s+/gm, '')                 // list bullets
    .replace(/\n{2,}/g, '. ')                  // collapse blank lines
    .replace(/\n/g, ' ')                       // flatten newlines
    .replace(/\s{2,}/g, ' ')                   // collapse whitespace
    .trim()
}

/**
 * Process a raw message for avatar display and TTS.
 * Extracts emotion, spoken text, and sanitized TTS text in one pass.
 *
 * @param {string} rawText
 * @param {{ allowedTags?: Set<string>|Array<string>|null }} [options]
 * @returns {{ emotion: string|null, intensity: number, displayText: string, ttsText: string }}
 */
export function processMessage(rawText, options = {}) {
  const emotion = extractEmotionTag(rawText)
  const spoken = extractSpokenText(rawText)
  const ttsText = sanitizeForTts(spoken, options.allowedTags)
  const displayText = stripTags(rawText)

  return {
    emotion: emotion?.emotion || null,
    intensity: emotion?.intensity || 1.0,
    displayText,
    ttsText,
  }
}
