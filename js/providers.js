// js/providers.js — LLM provider adapters
// Unified interface: callLLM({provider, baseUrl, model, apiKey, systemPrompt, userPrompt, signal})
// Returns: { text, usage?: {input_tokens, output_tokens} }

export const PROVIDERS = {
  openai_compatible: {
    defaultBaseUrl: 'https://llm.hpc.itc.rwth-aachen.de/v1/',
    defaultModel: 'openai/gpt-oss-120b',
    requiresKey: true,
    chunkCharThreshold: 60_000,
  },
  anthropic: {
    defaultBaseUrl: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-opus-4-5',
    requiresKey: true,
    chunkCharThreshold: 120_000,
  },
  openai: {
    defaultBaseUrl: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o',
    requiresKey: true,
    chunkCharThreshold: 80_000,
  },
  ollama: {
    defaultBaseUrl: 'http://localhost:11434/v1/chat/completions',
    defaultModel: 'llama3.1:8b',
    requiresKey: false,
    chunkCharThreshold: 30_000,
  },
};

/**
 * Normalize an OpenAI-compatible base URL:
 * - strip trailing slashes
 * - if it ends in /v1 (or /v2, /v3 …) append /chat/completions
 *   so that users can enter either "https://host/v1/" or the full path.
 */
function normalizeOpenAIUrl(url) {
  if (!url) return url;
  let u = url.trim().replace(/\/+$/, '');
  if (/\/v\d+$/.test(u)) {
    u += '/chat/completions';
  }
  return u;
}

const TIMEOUT_MS = 120_000;

export async function callLLM({ provider, baseUrl, model, apiKey, systemPrompt, userPrompt, signal }) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw apiError('unknown_provider', `Unknown provider: ${provider}`);
  let url = (baseUrl || cfg.defaultBaseUrl).trim();
  if (!url) throw apiError('no_url', 'Base URL is not set.');
  if (cfg.requiresKey && !apiKey) throw apiError('no_key', 'API key is required.');

  // For OpenAI-compatible endpoints, normalize the URL so users can enter
  // either the full path or just the /v1 base.
  if (provider !== 'anthropic') {
    url = normalizeOpenAIUrl(url);
  }

  // Merge caller signal with timeout signal
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(), TIMEOUT_MS);
  const mergedSignal = combineSignals(signal, timeoutCtrl.signal);

  try {
    if (provider === 'anthropic') {
      return await callAnthropic({ url, model, apiKey, systemPrompt, userPrompt, signal: mergedSignal });
    }
    return await callOpenAICompatible({ url, model, apiKey: apiKey || null, systemPrompt, userPrompt, signal: mergedSignal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Anthropic ----------

async function callAnthropic({ url, model, apiKey, systemPrompt, userPrompt, signal }) {
  const body = {
    model,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  };
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
    signal,
  });
  const data = await res.json();
  const text = (data.content || [])
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('');
  const usage = data.usage
    ? { input_tokens: data.usage.input_tokens, output_tokens: data.usage.output_tokens }
    : undefined;
  return { text, usage };
}

// ---------- OpenAI / OpenAI-compatible / Ollama ----------

async function callOpenAICompatible({ url, model, apiKey, systemPrompt, userPrompt, signal }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    // Ask for JSON — providers that don't support this still return JSON per our prompt
    response_format: { type: 'json_object' },
  };
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  let res;
  try {
    res = await fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (err) {
    // Some OpenAI-compatible providers reject unknown `response_format`.
    // Retry without it.
    if (err.code === 'api_bad_request' || err.status === 400) {
      delete body.response_format;
      res = await fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } else {
      throw err;
    }
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  const usage = data.usage
    ? { input_tokens: data.usage.prompt_tokens, output_tokens: data.usage.completion_tokens }
    : undefined;
  return { text, usage };
}

// ---------- Fetch with retry ----------

async function fetchWithRetry(url, opts, attempt = 1) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    if (err.name === 'AbortError') throw apiError('timeout', 'Request timed out or was cancelled.');
    throw apiError('network', `Could not reach ${url}. Check your network and CORS settings.`);
  }

  if (res.ok) return res;

  // Read body once for diagnostics; strip any API key residue
  let bodyText = '';
  try { bodyText = await res.text(); } catch {}
  const bodySnippet = bodyText.slice(0, 400);

  if (res.status === 401 || res.status === 403) {
    throw apiError('auth', `API key rejected (${res.status}).`, { status: res.status, body: bodySnippet });
  }
  if (res.status === 404) {
    throw apiError('not_found', `Endpoint or model not found (404).`, { status: res.status, body: bodySnippet });
  }
  if (res.status === 400) {
    throw apiError('api_bad_request', `Provider returned 400: ${bodySnippet}`, { status: res.status, body: bodySnippet });
  }
  if (res.status === 429 || res.status >= 500) {
    if (attempt < 3) {
      const delay = [1000, 3000, 9000][attempt - 1];
      await sleep(delay);
      return fetchWithRetry(url, opts, attempt + 1);
    }
    if (res.status === 429) {
      throw apiError('rate', `Rate-limited by provider (429).`, { status: res.status, body: bodySnippet });
    }
    throw apiError('server', `Provider error ${res.status}.`, { status: res.status, body: bodySnippet });
  }
  throw apiError('http', `HTTP ${res.status}: ${bodySnippet}`, { status: res.status, body: bodySnippet });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function combineSignals(a, b) {
  // If AbortSignal.any is available, use it; else polyfill.
  if (AbortSignal.any) return AbortSignal.any([a, b].filter(Boolean));
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  if (a) a.addEventListener('abort', abort);
  if (b) b.addEventListener('abort', abort);
  return ctrl.signal;
}

function apiError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}
