const outputStates = new Set(['starting', 'ready', 'closing', 'detached', 'closed']);
const encodedBytes = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function readBytes(data) {
  if (typeof data !== 'string' || !data.length || data.length > 5464 || !encodedBytes.test(data)) {
    throw new Error('Invalid terminal output');
  }
  const decoded = atob(data);
  if (decoded.length > 4096) throw new Error('Oversized terminal output');
  return Uint8Array.from(decoded, (byte) => byte.charCodeAt(0));
}

export function readOutputPage(value, sessionId, after) {
  if (!value || value.sessionId !== sessionId || value.gap !== false || !outputStates.has(value.state) ||
      !Array.isArray(value.events) || value.events.length > 64 ||
      !Number.isSafeInteger(value.lastSequence) || value.lastSequence < after ||
      value.events.length === 0 && value.lastSequence !== after) {
    throw new Error('Invalid terminal output page');
  }
  const steps = [];
  let sequence = after;
  let parts = [];
  let byteLength = 0;

  function flush() {
    if (!parts.length) return;
    const data = parts.length === 1 ? parts[0] : new Uint8Array(byteLength);
    if (parts.length > 1) {
      let offset = 0;
      for (const part of parts) {
        data.set(part, offset);
        offset += part.length;
      }
    }
    steps.push({ type: 'output', sequence, data });
    parts = [];
    byteLength = 0;
  }

  for (const event of value.events) {
    if (!Number.isSafeInteger(event?.sequence) || event.sequence !== sequence + 1 || event.sequence > value.lastSequence) {
      throw new Error('Out of order terminal output');
    }
    if (event.type === 'output') {
      const data = readBytes(event.data);
      parts.push(data);
      byteLength += data.length;
    } else if (event.type === 'disconnect' || event.type === 'exit') {
      flush();
      steps.push({ type: event.type, sequence: event.sequence });
    } else throw new Error('Unknown terminal event');
    sequence = event.sequence;
  }
  flush();
  return { state: value.state, lastSequence: value.lastSequence, steps };
}

export class UnconfirmedTerminalWrite extends Error {}

export function writeTerminalBytes(term, data) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new UnconfirmedTerminalWrite()), 5000);
    try {
      term.write(data, () => {
        clearTimeout(timer);
        resolve();
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}
