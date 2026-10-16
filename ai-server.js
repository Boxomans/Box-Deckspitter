// The AI assistant (opt-in): Claude, ChatGPT, Gemini, OpenRouter or Perplexity with the user's own API key. Keys live
// in data/secrets.json and never go back to the page. Claude goes through Anthropic's SDK; the others all speak the
// OpenAI chat-completions format, streamed with plain fetch.

'use strict';

const PROVIDERS = {
  anthropic: { name: 'Claude', company: 'Anthropic', secret: 'anthropicKey', env: 'ANTHROPIC_API_KEY', keyRe: /^sk-ant-[\w-]{20,}$/, keyHint: 'Anthropic keys start with sk-ant-' },
  openai: {
    name: 'ChatGPT', company: 'OpenAI', secret: 'openaiKey', env: 'OPENAI_API_KEY', keyRe: /^sk-[\w-]{20,}$/, keyHint: 'OpenAI keys start with sk-',
    chat: 'https://api.openai.com/v1/chat/completions', models: 'https://api.openai.com/v1/models', usage: true,
    keep: (id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !/audio|realtime|tts|transcribe|image|embedding|instruct|search|codex/.test(id),
  },
  gemini: {
    name: 'Gemini', company: 'Google', secret: 'geminiKey', env: 'GEMINI_API_KEY', keyRe: /^[\w-]{30,}$/, keyHint: 'Gemini keys come from aistudio.google.com',
    chat: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', models: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
    keep: (id) => /^gemini-/.test(id) && !/embedding|image|tts|live|audio/.test(id),
  },
  openrouter: {
    name: 'OpenRouter', company: 'OpenRouter', secret: 'openrouterKey', env: 'OPENROUTER_API_KEY', keyRe: /^sk-or-[\w-]{20,}$/, keyHint: 'OpenRouter keys start with sk-or-',
    chat: 'https://openrouter.ai/api/v1/chat/completions', models: 'https://openrouter.ai/api/v1/models', usage: true,
    headers: { 'X-Title': 'Box-DocSpitter' },
  },
  perplexity: {
    name: 'Perplexity', company: 'Perplexity', secret: 'perplexityKey', env: 'PERPLEXITY_API_KEY', keyRe: /^pplx-[\w-]{20,}$/, keyHint: 'Perplexity keys start with pplx-',
    chat: 'https://api.perplexity.ai/chat/completions',
    fixedModels: ['sonar', 'sonar-pro', 'sonar-reasoning-pro', 'sonar-deep-research'],
  },
};
const ANTHROPIC_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const AI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_RE = /^[\w.:/@+-]{1,160}$/;

module.exports = function createAi({ ok, readJSONBody, saveSecrets, secrets }) {
  const keyOf = (p) => secrets()[PROVIDERS[p].secret] || process.env[PROVIDERS[p].env] || '';
  const providerOf = (v) => (Object.hasOwn(PROVIDERS, v) ? v : 'anthropic');
  const httpError = (message, status = 400) => Object.assign(new Error(message), { status });

  let anthropicClient = null;
  let anthropicKeyUsed = null;
  function forgetAiClient() { anthropicClient = null; modelCache.clear(); }
  function anthropic() {
    const key = keyOf('anthropic');
    if (!key) throw httpError('Add your Anthropic API key in Settings → AI assistant first.');
    if (!anthropicClient || anthropicKeyUsed !== key) {
      const mod = require('@anthropic-ai/sdk');
      const Anthropic = mod.default || mod;
      anthropicClient = new Anthropic({ apiKey: key });
      anthropicKeyUsed = key;
    }
    return anthropicClient;
  }

  function cleanMessages(body) {
    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content)
      .map((m) => ({ role: m.role, content: m.content }));
    if (!messages.length || messages[0].role !== 'user') throw httpError('Nothing to send');
    return messages;
  }

  async function aiChat(req, res) {
    const body = await readJSONBody(req);
    const provider = providerOf(body.provider);
    const messages = cleanMessages(body);
    const system = String(body.system || '').slice(0, 20000);
    if (provider === 'anthropic') return claudeChat(req, res, body, messages, system);
    const P = PROVIDERS[provider];
    const key = keyOf(provider);
    if (!key) throw httpError(`Add your ${P.company} API key in Settings → AI assistant first.`);
    const model = typeof body.model === 'string' && MODEL_RE.test(body.model) ? body.model : '';
    if (!model) throw httpError(`Pick a ${P.name} model first.`);

    const ctl = new AbortController();
    req.on('close', () => ctl.abort());
    let r;
    try {
      r = await fetch(P.chat, {
        method: 'POST', signal: ctl.signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...P.headers },
        body: JSON.stringify({
          model, stream: true,
          ...(P.usage ? { stream_options: { include_usage: true } } : {}),
          messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
        }),
      });
    } catch (e) {
      if (e.name === 'AbortError') return;
      throw httpError(`Couldn’t reach ${P.company}: check your internet connection.`, 502);
    }
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      const msg = (Array.isArray(d) ? d[0] : d)?.error?.message || r.statusText;
      if (r.status === 401 || r.status === 403 || (r.status === 400 && /api.?key/i.test(msg))) throw httpError(`${P.company} rejected the API key (${msg}). Check it in Settings.`, 400);
      if (r.status === 404) throw httpError(`${P.company} doesn’t know the model “${model}”. Pick another one in the panel. (${msg})`, 400);
      if (r.status === 429) throw httpError(`Rate limited or out of credit at ${P.company}: ${msg}`, 429);
      throw httpError(`${P.company} error ${r.status}: ${msg}`, 502);
    }

    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    const send = (o) => { try { res.write(JSON.stringify(o) + '\n'); } catch { /* client gone */ } };
    let usage = null, finish = null, usedModel = model, citations = null;
    try {
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue; // blank lines and ": keep-alive" comments
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let ev;
          try { ev = JSON.parse(data); } catch { continue; }
          if (ev.error) { send({ type: 'error', message: `${P.company}: ${ev.error.message || ev.error}` }); continue; }
          if (ev.model) usedModel = ev.model;
          if (ev.usage) usage = ev.usage;
          if (Array.isArray(ev.citations)) citations = ev.citations;
          else if (Array.isArray(ev.search_results)) citations = ev.search_results.map((s) => s.url).filter(Boolean);
          const c = ev.choices?.[0];
          if (c?.delta?.content) send({ type: 'text', text: c.delta.content });
          if (c?.finish_reason) finish = c.finish_reason;
        }
      }
      // Perplexity answers from the web: its sources go at the end, numbered like the [1] marks in the text
      if (citations?.length) send({ type: 'text', text: '\n\n**Sources**\n' + citations.map((u, i) => `${i + 1}. ${u}`).join('\n') });
      send({ type: 'done', stop_reason: finish === 'length' ? 'max_tokens' : finish, model: usedModel, usage: { input: usage?.prompt_tokens, output: usage?.completion_tokens } });
    } catch (e) {
      if (e.name !== 'AbortError') send({ type: 'error', message: `${P.company} stream broke off: ${e.message}` });
    }
    res.end();
  }

  async function claudeChat(req, res, body, messages, system) {
    const model = ANTHROPIC_MODELS.includes(body.model) ? body.model : ANTHROPIC_MODELS[0];
    const effort = AI_EFFORTS.includes(body.effort) ? body.effort : 'medium';
    const client = anthropic();
    const Anthropic = client.constructor;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    const send = (o) => { try { res.write(JSON.stringify(o) + '\n'); } catch { /* client gone */ } };
    const params = {
      model,
      max_tokens: 64000,
      output_config: { effort },
      system: system || undefined,
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

  // each provider's chat models, asked for once in a while (Perplexity has no list to ask for)
  const modelCache = new Map();
  async function listModels(provider) {
    const P = PROVIDERS[provider];
    if (provider === 'anthropic') return ANTHROPIC_MODELS;
    if (P.fixedModels) return P.fixedModels;
    const hit = modelCache.get(provider);
    if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.list;
    const key = keyOf(provider);
    if (!key) return [];
    const r = await fetch(P.models, { headers: { Authorization: `Bearer ${key}`, ...P.headers }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw httpError(`${P.company} wouldn’t list its models (${r.status}).`, 502);
    const d = await r.json();
    const list = (d.data || d.models || []).map((m) => String(m.id || m.name || '').replace(/^models\//, ''))
      .filter((id) => id && MODEL_RE.test(id) && (!P.keep || P.keep(id))).sort();
    modelCache.set(provider, { at: Date.now(), list });
    return list;
  }

  const routes = {
    'GET /api/ai/status': async () => {
      const providers = {};
      for (const [id, P] of Object.entries(PROVIDERS)) {
        const key = keyOf(id);
        providers[id] = { name: P.name, company: P.company, configured: !!key, keyHint: key ? '…' + key.slice(-4) : null, fromEnv: !secrets()[P.secret] && !!process.env[P.env] ? P.env : null };
      }
      // older pages only look at these: the Claude key
      return { providers, configured: providers.anthropic.configured, keyHint: providers.anthropic.keyHint, fromEnv: !!providers.anthropic.fromEnv, models: ANTHROPIC_MODELS };
    },
    'GET /api/ai/models': async (req) => {
      const provider = providerOf(new URL(req.url, 'http://x').searchParams.get('provider'));
      return { models: await listModels(provider) };
    },
    'POST /api/ai/key': async (req) => {
      const body = await readJSONBody(req);
      const provider = providerOf(body.provider);
      const P = PROVIDERS[provider];
      const k = String(body.key || '').trim();
      if (k && !P.keyRe.test(k)) throw httpError(`That doesn’t look like an API key from ${P.company} (${P.keyHint}).`);
      await saveSecrets({ ...secrets(), [P.secret]: k || undefined });
      if (provider === 'anthropic') anthropicClient = null;
      modelCache.delete(provider);
      return { ok: true, configured: !!keyOf(provider) };
    },
  };

  return { routes, forgetAiClient, aiChat };
};
