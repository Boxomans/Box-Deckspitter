// Streams a one-off AI assistant reply (whichever provider is picked) through the local server (/api/ai/chat).
// Used by tools such as BoxMail.

import { api } from './api.js';
import { aiChoice } from './ai-providers.js';

/**
 * @param {object} o
 * @param {string} o.system   system prompt
 * @param {string} o.prompt   the user turn
 * @param {(text: string, full: string) => void} [o.onText]  called with each chunk and the text so far
 * @param {AbortSignal} [o.signal]
 * @param {object} [o.settings]  app settings (provider / model / effort)
 * @returns {Promise<string>} the full reply
 */
export async function streamClaude({ system, prompt, onText, signal, settings = {} }) {
  const ai = aiChoice(settings);
  const res = await fetch('/api/ai/chat', {
    method: 'POST', signal,
    headers: { 'X-BDS-Token': api.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: ai.provider,
      model: ai.model,
      effort: ai.effort,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `${ai.name} request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const ev = JSON.parse(line);
      if (ev.type === 'text') { full += ev.text; onText?.(ev.text, full); }
      else if (ev.type === 'refusal') throw new Error(`${ai.name} declined this request` + (ev.explanation ? `: ${ev.explanation}` : '.'));
      else if (ev.type === 'error') throw new Error(ev.message);
    }
  }
  return full;
}
