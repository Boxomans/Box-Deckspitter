// Ask Claude (opt-in). The user's API key lives in data/secrets.json and never goes back to the page.

'use strict';

module.exports = function createAi({ ok, readJSONBody, saveSecrets, secrets, send }) {
  const AI_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
  const AI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

  function aiKey() { return secrets().anthropicKey || process.env.ANTHROPIC_API_KEY || ''; }

  let anthropicClient = null;
  let anthropicKeyUsed = null;
  function forgetAiClient() { anthropicClient = null; }
  function anthropic() {
    const key = aiKey();
    if (!key) throw Object.assign(new Error('Add your Anthropic API key in Settings → Ask Claude first.'), { status: 400 });
    if (!anthropicClient || anthropicKeyUsed !== key) {
      const mod = require('@anthropic-ai/sdk');
      const Anthropic = mod.default || mod;
      anthropicClient = new Anthropic({ apiKey: key });
      anthropicKeyUsed = key;
    }
    return anthropicClient;
  }

  async function aiChat(req, res) {
    const body = await readJSONBody(req);
    const model = AI_MODELS.includes(body.model) ? body.model : AI_MODELS[0];
    const effort = AI_EFFORTS.includes(body.effort) ? body.effort : 'medium';
    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content)
      .map((m) => ({ role: m.role, content: m.content }));
    if (!messages.length || messages[0].role !== 'user') throw Object.assign(new Error('Nothing to send'), { status: 400 });
    const client = anthropic();
    const Anthropic = client.constructor;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    const send = (o) => { try { res.write(JSON.stringify(o) + '\n'); } catch { /* client gone */ } };
    const params = {
      model,
      max_tokens: 64000,
      output_config: { effort },
      system: String(body.system || '').slice(0, 20000) || undefined,
      messages,
    };
    // Server-side refusal fallback (Opus / Sonnet only; Haiku has none).
    if (model !== 'claude-haiku-5-5') { params.betas = ['server-side-fallback-2026-07-01']; params.fallbacks = 'default'; }
    const stream = client.beta.messages.stream(params);
    req.on('close', () => { try { stream.abort(); } catch { /* ignore */ } });
    stream.on('text', (t) => send({ type: 'text', text: t }));
    try {
      const final = await stream.finalMessage();
      if (final.stop_reason === 'refusal') {
        send({ type: 'refusal', category: final.stop_details?.category || null, explanation: final.stop_details?.explanation || null });
      }
      send({ type: 'done', stop_reason: final.stop_reason, model: final.model, usage: { input: final.usage?.input_tokens, output: final.usage?.output_tokens } });
    } catch (e) {
      let message = e.message || 'Request failed';
      if (e instanceof Anthropic.AuthenticationError) message = 'Anthropic rejected the API key — check it in Settings.';
      else if (e instanceof Anthropic.PermissionDeniedError) message = 'This API key isn’t allowed to use that model.';
      else if (e instanceof Anthropic.RateLimitError) message = 'Rate limited by Anthropic — wait a moment and try again.';
      else if (e instanceof Anthropic.BadRequestError) message = 'Request rejected: ' + e.message;
      else if (e instanceof Anthropic.APIConnectionError) message = 'Couldn’t reach Anthropic — check your internet connection.';
      else if (e instanceof Anthropic.APIError) message = `Anthropic API error ${e.status}: ${e.message}`;
      if (e.name !== 'APIUserAbortError') send({ type: 'error', message });
    }
    res.end();
  }

  const routes = {
    'GET /api/ai/status': async () => {
      const key = aiKey();
      return { configured: !!key, keyHint: key ? '…' + key.slice(-4) : null, fromEnv: !secrets().anthropicKey && !!process.env.ANTHROPIC_API_KEY, models: AI_MODELS };
    },
    'POST /api/ai/key': async (req) => {
      const { key } = await readJSONBody(req);
      const k = String(key || '').trim();
      if (k && !/^sk-ant-[\w-]{20,}$/.test(k)) throw Object.assign(new Error('That doesn’t look like an Anthropic API key (they start with sk-ant-).'), { status: 400 });
      await saveSecrets({ ...secrets(), anthropicKey: k || undefined });
      anthropicClient = null;
      return { ok: true, configured: !!aiKey() };
    },
  };

  return { routes, forgetAiClient, aiChat };
};
