// The AI assistant's providers (see ai-server.js): which one is in use, its model, and what to call it on screen.

export const PROVIDERS = {
  anthropic: { name: 'Claude', company: 'Anthropic', keyUrl: 'console.anthropic.com → API Keys', placeholder: 'sk-ant-…', model: 'claude-opus-5-5' },
  openai: { name: 'ChatGPT', company: 'OpenAI', keyUrl: 'platform.openai.com → API keys', placeholder: 'sk-…', model: 'gpt-5' },
  gemini: { name: 'Gemini', company: 'Google', keyUrl: 'aistudio.google.com → Get API key', placeholder: 'AIza…', model: 'gemini-2.5-flash' },
  openrouter: { name: 'OpenRouter', company: 'OpenRouter', keyUrl: 'openrouter.ai → Keys', placeholder: 'sk-or-…', model: 'openrouter/auto' },
  perplexity: { name: 'Perplexity', company: 'Perplexity', keyUrl: 'perplexity.ai → Settings → API', placeholder: 'pplx-…', model: 'sonar' },
};
export const CLAUDE_MODELS = [['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5']];

/** The provider, model and effort the settings pick, plus the names to show. */
export function aiChoice(settings = {}) {
  const provider = PROVIDERS[settings.aiProvider] ? settings.aiProvider : 'anthropic';
  const P = PROVIDERS[provider];
  const model = provider === 'anthropic' ? settings.aiModel || P.model : settings.aiModels?.[provider] || P.model;
  return { provider, model, effort: settings.aiEffort || 'medium', name: P.name, company: P.company };
}
