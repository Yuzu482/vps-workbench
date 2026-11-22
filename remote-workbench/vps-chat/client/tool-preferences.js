export async function readToolPreferences(settings, knownTools, read) {
  const normalizePath = (path) => path.replaceAll('\\', '/').toLowerCase();
  const target = [settings.host.toLowerCase(), settings.port, settings.user, normalizePath(settings.identityPath),
    normalizePath(settings.knownHostsPath), settings.expectedIpv4, settings.expectedIpv6];
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(target)));
  const key = 'dsh-vps-chat-tools:v1:' + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  try {
    const saved = read(key);
    const ids = saved && saved.length <= 256 ? JSON.parse(saved) : null;
    if (Array.isArray(ids) && ids.every((id) => knownTools.includes(id))) return { key, ids: [...new Set(ids)] };
  } catch {
    // A failed preference read can fall back to the verified preset.
  }
  return { key, ids: null };
}
