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
 * Removes code blocks, markdown formatting, and normalizes whitespace.
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitizeForTts(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')           // code blocks
    .replace(/`[^`]+`/g, '')                   // inline code
    .replace(/\[spoken\]|\[\/spoken\]/gi, '')  // spoken tags
    .replace(/\[(\w+)(?::\d+(?:\.\d+)?)?\]/g, '($1)')  // [happy] or [happy:0.8] → (happy)
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
 * @returns {{ emotion: string|null, intensity: number, displayText: string, ttsText: string }}
 */
export function processMessage(rawText) {
  const emotion = extractEmotionTag(rawText)
  const spoken = extractSpokenText(rawText)
  const ttsText = sanitizeForTts(spoken)
  const displayText = stripTags(rawText)

  return {
    emotion: emotion?.emotion || null,
    intensity: emotion?.intensity || 1.0,
    displayText,
    ttsText,
  }
}
