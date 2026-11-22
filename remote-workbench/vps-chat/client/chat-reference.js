const uuid = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const prefix = 'vps-workbench://conversation/v1/';
const linkPattern = new RegExp('^(local-sdk|ssh-vps)/(codex|claude|claude-sdk|antigravity)/([a-f0-9]{64})/(' + uuid +
  ')(?:/(' + uuid + '))?$');
const quoteMarker = '\n\n引用资料（仅供参考）\n';
export const maxQuoteLength = 2048;

export function parseConversationLink(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  const uri = value.trim();
  if (!uri.startsWith(prefix)) return null;
  const match = linkPattern.exec(uri.slice(prefix.length));
  if (!match) return null;
  const [, location, provider, targetId, sessionId, turnId] = match;
  if (location === 'local-sdk' && provider === 'claude') return null;
  return { location, provider, targetId, sessionId, ...(turnId && { turnId }) };
}

export function conversationLink({ location, provider, targetId, sessionId, turnId }) {
  const value = prefix + [location, provider, targetId, sessionId, ...(turnId ? [turnId] : [])].join('/');
  return parseConversationLink(value) ? value : null;
}

export function quotedPrompt(prompt, quote) {
  return quote ? prompt + quoteMarker + JSON.stringify(quote) : prompt;
}

export function readQuotedPrompt(prompt) {
  const split = prompt.lastIndexOf(quoteMarker);
  if (split < 0) return { prompt };
  try {
    const quote = JSON.parse(prompt.slice(split + quoteMarker.length));
    if (typeof quote !== 'string' || !quote.trim() || quote.length > maxQuoteLength) return { prompt };
    return { prompt: prompt.slice(0, split), quote };
  } catch { return { prompt }; }
}
