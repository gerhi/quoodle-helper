// js/app.js — Main app controller
// Wires the UI to extractors, providers, generation, and export.

import { initI18n, setLang, getLang, t, tp } from './i18n.js';
import { detectType, extractText, SUPPORTED_EXTENSIONS, MAX_FILE_SIZE } from './extractors.js';
import { PROVIDERS } from './providers.js';
import { generateQuestions, DEFAULT_SYSTEM_PROMPT_TEMPLATE } from './generate.js';
import { exportXlsx, exportCsv } from './export.js';

// ---------- State ----------

const state = {
  step: 'upload', // upload | configure | generate | review
  files: [], // { id, file, type, status, text, warnings, charCount, error }
  config: {
    provider: 'openai_compatible',
    base_url: '',
    model: '',
    api_key: '',
    save_key: false,
    custom_prompt: '',
    question_count: 10,
    difficulty: 'medium',
    output_language: 'de',
    question_style: 'mixed',
  },
  generation: {
    running: false,
    abortCtrl: null,
    questions: [],
    usage: null,
  },
};

let fileIdSeq = 0;

// ---------- Boot ----------

async function boot() {
  migrateLegacyStorageKeys();
  await initI18n();
  initTheme();
  checkVendorLibraries();
  bindGlobal();
  bindUpload();
  bindConfigure();
  bindGenerate();
  bindReview();
  bindModals();
  loadPreferences();
  // Re-apply dynamic texts when language changes
  document.addEventListener('i18n:changed', () => {
    renderFileList();
    if (state.step === 'generate') renderGenerateSummary();
    if (state.step === 'review') renderReview();
    updateModelHint();
  });
}

/**
 * One-time migration: rename localStorage keys from the old prefix
 * (quoodle-generator.*) to the new prefix (quoodle-helper.*). Runs at every
 * boot but is a no-op once no legacy keys remain. Safe to keep long-term.
 */
function migrateLegacyStorageKeys() {
  const OLD = 'quoodle-generator.';
  const NEW = 'quoodle-helper.';
  const toMigrate = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(OLD)) toMigrate.push(key);
  }
  for (const oldKey of toMigrate) {
    const newKey = NEW + oldKey.slice(OLD.length);
    // Only copy if the new key is not already set (new wins if both exist)
    if (localStorage.getItem(newKey) === null) {
      localStorage.setItem(newKey, localStorage.getItem(oldKey));
    }
    localStorage.removeItem(oldKey);
  }
}

/**
 * Detects if the vendor libraries (mammoth, JSZip, SheetJS) failed to load.
 * Libraries ship in the repository under ./vendor/ — if they're missing,
 * something was deleted or not served correctly. pdf.js is lazy-loaded
 * and checked separately at extraction time.
 */
function checkVendorLibraries() {
  const missing = [];
  if (typeof window.mammoth === 'undefined') missing.push('mammoth.js');
  if (typeof window.JSZip === 'undefined') missing.push('JSZip');
  if (typeof window.XLSX === 'undefined') missing.push('SheetJS (xlsx)');
  if (missing.length === 0) return;

  const banner = document.createElement('div');
  banner.setAttribute('role', 'alert');
  banner.style.cssText =
    'background:var(--warning-soft,#fffbeb);color:var(--warning,#92400e);' +
    'border-bottom:1px solid var(--warning,#d97706);padding:0.85rem 1.25rem;' +
    'font-size:0.875rem;line-height:1.5;';
  banner.innerHTML =
    '<strong>⚠ Vendor libraries not found:</strong> ' +
    missing.join(', ') +
    '. The files should be in the <code style="background:rgba(0,0,0,0.08);padding:0.1rem 0.35rem;border-radius:4px">vendor/</code> folder next to <code style="background:rgba(0,0,0,0.08);padding:0.1rem 0.35rem;border-radius:4px">index.html</code>. ' +
    'If you deleted them, run <code style="background:rgba(0,0,0,0.08);padding:0.1rem 0.35rem;border-radius:4px">bash download-vendor.sh</code> to restore them. ' +
    'Without these, file extraction and Excel export will not work.';
  document.body.insertBefore(banner, document.body.firstChild);
}

boot().catch(err => {
  console.error('Boot failed:', err);
  document.body.innerHTML = `<pre style="padding:2rem;color:#c00;font-family:monospace">Failed to start: ${err.message}</pre>`;
});

// ---------- Theme ----------

function initTheme() {
  const saved = localStorage.getItem('quoodle-helper.theme') || 'system';
  document.documentElement.dataset.theme = saved;
  document.getElementById('theme-toggle').addEventListener('click', () => {
    const current = document.documentElement.dataset.theme;
    const next = current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('quoodle-helper.theme', next);
  });
}

// ---------- Global / Header ----------

function bindGlobal() {
  // Language switch: cycle through supported languages
  document.getElementById('lang-switch').addEventListener('click', async () => {
    const order = ['de', 'en', 'fr'];
    const current = getLang();
    const idx = order.indexOf(current);
    const next = order[(idx + 1 + order.length) % order.length];
    await setLang(next);
  });

  // Stepper navigation (only to completed steps)
  document.querySelectorAll('.stepper li').forEach(li => {
    li.addEventListener('click', () => {
      if (li.classList.contains('completed')) {
        navigateTo(li.dataset.step);
      }
    });
  });

  // "Back" buttons within steps
  document.querySelectorAll('[data-nav]').forEach(btn => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.nav));
  });

  // Footer
  document.getElementById('clear-settings').addEventListener('click', () => {
    if (confirm(getLang() === 'de' ? 'Alle gespeicherten Einstellungen löschen?' : 'Clear all saved settings?')) {
      Object.keys(localStorage).forEach(k => {
        if (k.startsWith('quoodle-helper.')) localStorage.removeItem(k);
      });
      alert(getLang() === 'de' ? 'Einstellungen gelöscht. Seite wird neu geladen.' : 'Settings cleared. Reloading.');
      location.reload();
    }
  });
}

function navigateTo(step) {
  if (!['upload', 'configure', 'generate', 'review'].includes(step)) return;

  // Guards
  if (step === 'configure' && !state.files.some(f => f.status === 'ready' || f.status === 'warning')) return;
  if (step === 'generate' && !isConfigValid()) return;
  if (step === 'review' && state.generation.questions.length === 0) return;

  state.step = step;

  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  document.getElementById(`step-${step}`).classList.add('active');

  const order = ['upload', 'configure', 'generate', 'review'];
  const idx = order.indexOf(step);
  document.querySelectorAll('.stepper li').forEach(li => {
    const i = order.indexOf(li.dataset.step);
    li.classList.toggle('active', i === idx);
    li.classList.toggle('completed', i < idx);
  });

  // Step-specific rendering
  if (step === 'generate') renderGenerateSummary();
  if (step === 'review') renderReview();
  if (step === 'configure') updateModelHint();
}

// ---------- Step 1: Upload ----------

function bindUpload() {
  const dz = document.getElementById('dropzone');
  const input = document.getElementById('file-input');
  const toConfigureBtn = document.getElementById('to-configure');

  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('drag-over');
    addFiles([...e.dataTransfer.files]);
  });
  input.addEventListener('change', e => {
    addFiles([...e.target.files]);
    e.target.value = ''; // allow re-uploading same file
  });

  toConfigureBtn.addEventListener('click', () => navigateTo('configure'));
}

async function addFiles(fileList) {
  for (const file of fileList) {
    const type = detectType(file);
    const id = ++fileIdSeq;
    const entry = {
      id,
      file,
      type,
      status: type ? (file.size > MAX_FILE_SIZE ? 'error' : 'pending') : 'error',
      text: '',
      warnings: [],
      charCount: 0,
      errorKey: !type ? 'file.unsupported' : (file.size > MAX_FILE_SIZE ? 'file.toolarge' : null),
    };
    state.files.push(entry);
    renderFileList();
    if (entry.status === 'pending') {
      runExtraction(entry);
    }
  }
  updateUploadSummary();
}

async function runExtraction(entry) {
  entry.status = 'extracting';
  renderFileList();
  try {
    const { text, warnings } = await extractText(entry.file, () => {
      // progress callback — ignored for now (could show per-file %)
    });
    entry.text = text;
    entry.charCount = text.length;
    entry.warnings = warnings;
    entry.status = warnings.length > 0 ? 'warning' : 'ready';
  } catch (err) {
    entry.status = 'error';
    entry.errorKey = err.message === 'noText' ? 'file.noText'
      : err.message === 'unsupported' ? 'file.unsupported'
      : err.message === 'toolarge' ? 'file.toolarge'
      : 'file.parseError';
    entry.errorDetail = err.message;
  }
  renderFileList();
  updateUploadSummary();
}

function renderFileList() {
  const ul = document.getElementById('file-list');
  ul.innerHTML = '';
  for (const f of state.files) {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.dataset.fileId = f.id;

    const icon = document.createElement('div');
    icon.className = 'file-icon';
    icon.textContent = (f.type || '?').toUpperCase();

    const main = document.createElement('div');
    main.className = 'file-main';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = f.file.name;
    const meta = document.createElement('span');
    meta.className = 'file-meta';
    meta.textContent = formatBytes(f.file.size) + (f.charCount ? ` · ${f.charCount.toLocaleString()} ${t('upload.summary.chars').replace('{n} ', '')}` : '');
    main.appendChild(name);
    main.appendChild(meta);

    const status = document.createElement('span');
    status.className = `file-status ${f.status}`;
    if (f.status === 'error') {
      status.textContent = t(f.errorKey || 'file.error');
    } else {
      status.textContent = t(`file.${f.status}`);
    }

    const actions = document.createElement('div');
    actions.className = 'file-actions';
    if (f.status === 'ready' || f.status === 'warning') {
      const prev = document.createElement('button');
      prev.className = 'icon-btn';
      prev.title = t('common.preview');
      prev.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
      prev.addEventListener('click', () => openPreview(f));
      actions.appendChild(prev);
    }
    const rm = document.createElement('button');
    rm.className = 'icon-btn';
    rm.title = t('common.remove');
    rm.innerHTML = '✕';
    rm.addEventListener('click', () => {
      state.files = state.files.filter(x => x.id !== f.id);
      renderFileList();
      updateUploadSummary();
    });
    actions.appendChild(rm);

    li.appendChild(icon);
    li.appendChild(main);
    li.appendChild(status);
    li.appendChild(actions);
    ul.appendChild(li);
  }
}

function updateUploadSummary() {
  const ready = state.files.filter(f => f.status === 'ready' || f.status === 'warning');
  const btn = document.getElementById('to-configure');
  btn.disabled = ready.length === 0;

  const summary = document.getElementById('upload-summary');
  if (ready.length === 0) {
    summary.classList.add('hidden');
    return;
  }
  const totalChars = ready.reduce((a, f) => a + f.charCount, 0);
  const fileText = tp('upload.summary.files', ready.length);
  const charText = t('upload.summary.chars', { n: totalChars.toLocaleString() });
  summary.textContent = `✓ ${fileText} · ${charText}`;
  summary.classList.remove('hidden');
}

function openPreview(entry) {
  const modal = document.getElementById('preview-modal');
  document.getElementById('preview-meta').textContent =
    `${entry.file.name} · ${entry.charCount.toLocaleString()} ${getLang() === 'de' ? 'Zeichen' : 'characters'}`
    + (entry.warnings.length > 0 ? ` · ⚠ ${entry.warnings.join('; ')}` : '');
  document.getElementById('preview-text').textContent = entry.text.slice(0, 5000)
    + (entry.text.length > 5000 ? '\n\n… [' + (getLang() === 'de' ? 'gekürzt' : 'truncated') + '] …' : '');
  modal.classList.remove('hidden');

  const copyBtn = document.getElementById('copy-preview');
  copyBtn.textContent = t('preview.copy');
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(entry.text);
      copyBtn.textContent = t('preview.copied');
      setTimeout(() => copyBtn.textContent = t('preview.copy'), 1500);
    } catch (e) {
      alert('Clipboard error: ' + e.message);
    }
  };
}

// ---------- Step 2: Configure ----------

function bindConfigure() {
  // Existing UI bindings …

  // Test connection button – checks that the base URL (and API key if required) is reachable.
  const testBtn = document.getElementById('test-connection');
  const testStatus = document.getElementById('test-status');
  if (testBtn) {
    testBtn.addEventListener('click', async () => {
      // Show a temporary spinner / message
      testStatus.textContent = t('common.retry'); // "Retry" used as a neutral placeholder
      testStatus.style.color = '';

      const provider = state.config.provider;
      const cfg = PROVIDERS[provider];
      const base = (state.config.base_url || cfg.defaultBaseUrl).trim();
      if (!base) {
        testStatus.textContent = t('error.network');
        testStatus.style.color = 'var(--error,#c00)';
        return;
      }

      // Build a lightweight test URL. For OpenAI‑compatible endpoints and Ollama we try /v1/models.
      let testUrl = base;
      if (provider !== 'anthropic') {
        // Normalise the URL (strip trailing slash) and point to a generic endpoint.
        testUrl = testUrl.replace(/\/+$/, '');
        // If the URL already ends with /chat/completions replace that part.
        testUrl = testUrl.replace(/\/chat\/completions$/, '/v1/models');
        // If it looks like it already ends with /vX, just append /models.
        if (!/\/v\d+/.test(testUrl)) {
          testUrl += '/v1/models';
        }
      } else {
        // Anthropic has no simple models endpoint – fallback to a dummy completion request.
        // We'll reuse the normal callLLM with a minimal prompt.
        // (Handled later in the catch block.)
      }

      const headers = { 'Content-Type': 'application/json' };
      if (cfg.requiresKey && state.config.api_key) {
        headers['Authorization'] = `Bearer ${state.config.api_key}`;
      }

      try {
        if (provider === 'anthropic') {
          // Small anthropic request – model from config, empty prompt.
          const body = {
            model: state.config.model,
            max_tokens: 1,
            system: '',
            messages: [{ role: 'user', content: '' }],
          };
          const res = await fetch(base, { method: 'POST', headers, body: JSON.stringify(body) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } else {
          const res = await fetch(testUrl, { method: 'GET', headers });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        }
        testStatus.textContent = '✔';
        testStatus.style.color = 'var(--success,green)';
      } catch (err) {
        testStatus.textContent = err.message;
        testStatus.style.color = 'var(--error,#c00)';
      }
    });
  }

  // Provider radio
  document.querySelectorAll('input[name="provider"]').forEach(r => {
    r.addEventListener('change', () => {
      state.config.provider = r.value;
      applyProviderDefaults();
      updateModelHint();
      updateApiKeyVisibility();
    });
  });

  document.getElementById('model').addEventListener('input', e => { state.config.model = e.target.value; });
  document.getElementById('base-url').addEventListener('input', e => { state.config.base_url = e.target.value; });

  // Custom system prompt (advanced)
  const promptEl = document.getElementById('custom-prompt');
  promptEl.addEventListener('input', e => {
    state.config.custom_prompt = e.target.value;
    // Persist on every edit. Empty value removes the key (so default is used).
    if (e.target.value.trim() === '' || e.target.value === DEFAULT_SYSTEM_PROMPT_TEMPLATE) {
      localStorage.removeItem('quoodle-helper.custom_prompt');
    } else {
      localStorage.setItem('quoodle-helper.custom_prompt', e.target.value);
    }
  });
  document.getElementById('restore-prompt').addEventListener('click', () => {
    promptEl.value = DEFAULT_SYSTEM_PROMPT_TEMPLATE;
    state.config.custom_prompt = '';
    localStorage.removeItem('quoodle-helper.custom_prompt');
  });
  document.getElementById('api-key').addEventListener('input', e => {
    state.config.api_key = e.target.value;
    if (state.config.save_key && state.config.api_key) {
      localStorage.setItem(`quoodle-helper.key.${state.config.provider}`, state.config.api_key);
    }
  });

  document.getElementById('save-key').addEventListener('change', e => {
    state.config.save_key = e.target.checked;
    if (e.target.checked && state.config.api_key) {
      localStorage.setItem(`quoodle-helper.key.${state.config.provider}`, state.config.api_key);
    } else if (!e.target.checked) {
      // Remove from storage but keep in memory
      localStorage.removeItem(`quoodle-helper.key.${state.config.provider}`);
    }
  });

  document.getElementById('toggle-key-visibility').addEventListener('click', () => {
    const input = document.getElementById('api-key');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  document.getElementById('question-count').addEventListener('input', e => {
    state.config.question_count = Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 10));
  });
  document.getElementById('output-language').addEventListener('change', e => {
    state.config.output_language = e.target.value;
  });
  document.querySelectorAll('input[name="difficulty"]').forEach(r => {
    r.addEventListener('change', () => { state.config.difficulty = r.value; });
  });
  document.querySelectorAll('input[name="style"]').forEach(r => {
    r.addEventListener('change', () => { state.config.question_style = r.value; });
  });

  document.getElementById('to-generate').addEventListener('click', () => {
    if (!isConfigValid()) {
      const err = !state.config.model ? 'Modell fehlt.' : t('error.nokey');
      alert(err);
      return;
    }
    // Save non-secret prefs
    savePreferences();
    navigateTo('generate');
  });
}

function applyProviderDefaults() {
  const cfg = PROVIDERS[state.config.provider];
  const savedBaseUrl = localStorage.getItem(`quoodle-helper.base_url.${state.config.provider}`);
  const savedModel = localStorage.getItem(`quoodle-helper.model.${state.config.provider}`);
  const savedKey = localStorage.getItem(`quoodle-helper.key.${state.config.provider}`);

  const baseUrl = savedBaseUrl || cfg.defaultBaseUrl;
  const model = savedModel || cfg.defaultModel;

  document.getElementById('base-url').value = baseUrl;
  document.getElementById('model').value = model;
  state.config.base_url = baseUrl;
  state.config.model = model;

  if (savedKey) {
    document.getElementById('api-key').value = savedKey;
    state.config.api_key = savedKey;
    document.getElementById('save-key').checked = true;
    state.config.save_key = true;
  } else {
    document.getElementById('api-key').value = '';
    state.config.api_key = '';
    document.getElementById('save-key').checked = false;
    state.config.save_key = false;
  }
}

function updateModelHint() {
  const hint = document.getElementById('model-hint');
  const key = `provider.model.hint.${state.config.provider === 'openai_compatible' ? 'compat' : state.config.provider}`;
  hint.textContent = t(key);
}

function updateApiKeyVisibility() {
  const row = document.getElementById('api-key-row');
  row.style.display = state.config.provider === 'ollama' ? 'none' : '';
}

function isConfigValid() {
  if (!state.config.model || !state.config.model.trim()) return false;
  if (!state.config.base_url || !state.config.base_url.trim()) return false;
  if (PROVIDERS[state.config.provider].requiresKey && !state.config.api_key) return false;
  return true;
}

function savePreferences() {
  localStorage.setItem('quoodle-helper.provider', state.config.provider);
  localStorage.setItem(`quoodle-helper.base_url.${state.config.provider}`, state.config.base_url);
  localStorage.setItem(`quoodle-helper.model.${state.config.provider}`, state.config.model);
  localStorage.setItem('quoodle-helper.defaults', JSON.stringify({
    question_count: state.config.question_count,
    difficulty: state.config.difficulty,
    output_language: state.config.output_language,
    question_style: state.config.question_style,
  }));
}

function loadPreferences() {
  const provider = localStorage.getItem('quoodle-helper.provider');
  if (provider && PROVIDERS[provider]) {
    state.config.provider = provider;
    document.querySelector(`input[name="provider"][value="${provider}"]`).checked = true;
  }
  applyProviderDefaults();
  updateModelHint();
  updateApiKeyVisibility();

  // Custom system prompt: if saved, use it; otherwise prefill textarea with default
  const savedPrompt = localStorage.getItem('quoodle-helper.custom_prompt');
  const promptEl = document.getElementById('custom-prompt');
  if (savedPrompt) {
    promptEl.value = savedPrompt;
    state.config.custom_prompt = savedPrompt;
  } else {
    promptEl.value = DEFAULT_SYSTEM_PROMPT_TEMPLATE;
    state.config.custom_prompt = '';
  }

  try {
    const defaults = JSON.parse(localStorage.getItem('quoodle-helper.defaults') || '{}');
    if (defaults.question_count) {
      state.config.question_count = defaults.question_count;
      document.getElementById('question-count').value = defaults.question_count;
    }
    if (defaults.difficulty) {
      state.config.difficulty = defaults.difficulty;
      const el = document.querySelector(`input[name="difficulty"][value="${defaults.difficulty}"]`);
      if (el) el.checked = true;
    }
    if (defaults.output_language) {
      state.config.output_language = defaults.output_language;
      document.getElementById('output-language').value = defaults.output_language;
    }
    if (defaults.question_style) {
      state.config.question_style = defaults.question_style;
      const el = document.querySelector(`input[name="style"][value="${defaults.question_style}"]`);
      if (el) el.checked = true;
    }
  } catch {}
}

// ---------- Step 3: Generate ----------

function bindGenerate() {
  document.getElementById('start-generate').addEventListener('click', runGenerate);
  document.getElementById('cancel-generate').addEventListener('click', () => {
    state.generation.abortCtrl?.abort();
  });
}

function renderGenerateSummary() {
  const el = document.getElementById('generate-summary');
  const ready = state.files.filter(f => f.status === 'ready' || f.status === 'warning');
  const totalChars = ready.reduce((a, f) => a + f.charCount, 0);
  el.innerHTML = '';
  const dl = document.createElement('dl');
  const rows = [
    [t('generate.summary.files'), ready.map(f => f.file.name).join(', ')],
    [t('generate.summary.chars'), totalChars.toLocaleString()],
    [t('generate.summary.provider'), state.config.provider],
    [t('generate.summary.model'), state.config.model],
    [t('generate.summary.count'), state.config.question_count],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.appendChild(dt); dl.appendChild(dd);
  }
  el.appendChild(dl);
}

async function runGenerate() {
  const ready = state.files.filter(f => f.status === 'ready' || f.status === 'warning');
  const combined = ready.map(f => `### Source: ${f.file.name}\n\n${f.text}`).join('\n\n');

  const progressBlock = document.getElementById('generate-progress');
  const phaseEl = document.getElementById('progress-phase');
  const detailEl = document.getElementById('progress-detail');
  const fillEl = document.getElementById('progress-fill');
  const errorEl = document.getElementById('generate-error');
  const startBtn = document.getElementById('start-generate');
  const cancelBtn = document.getElementById('cancel-generate');

  errorEl.classList.add('hidden');
  errorEl.innerHTML = '';
  progressBlock.classList.remove('hidden');
  startBtn.classList.add('hidden');
  cancelBtn.classList.remove('hidden');

  state.generation.running = true;
  state.generation.abortCtrl = new AbortController();
  state.generation.questions = [];
  state.generation.usage = null;

  const phaseLabels = {
    prepare: t('generate.phase.prepare'),
    chunking: t('generate.phase.chunking'),
    calling: t('generate.phase.calling'),
    parsing: t('generate.phase.parsing'),
    validating: t('generate.phase.validating'),
    done: t('generate.phase.done'),
  };

  let totalChunks = 1;

  try {
    const { questions, usage } = await generateQuestions({
      combinedText: combined,
      config: state.config,
      signal: state.generation.abortCtrl.signal,
      onPhase: ({ phase, current, total, produced, totalChunks: tc }) => {
        if (tc) totalChunks = tc;
        if (phase === 'calling') {
          phaseEl.textContent = t('generate.phase.calling', { current, total });
          fillEl.style.width = `${((current - 1) / total) * 100}%`;
        } else if (phase === 'parsing' || phase === 'validating') {
          phaseEl.textContent = phaseLabels[phase];
          fillEl.style.width = `${(current || totalChunks) / totalChunks * 100}%`;
        } else if (phase === 'done') {
          phaseEl.textContent = phaseLabels.done;
          fillEl.style.width = '100%';
          detailEl.textContent = (getLang() === 'de' ? `${produced} Fragen` : `${produced} questions`);
        } else {
          phaseEl.textContent = phaseLabels[phase] || phase;
        }
      },
    });
    state.generation.questions = questions;
    state.generation.usage = usage;
    state.generation.running = false;
    // Short pause so the user sees "done"
    await new Promise(r => setTimeout(r, 300));
    navigateTo('review');
  } catch (err) {
    state.generation.running = false;
    progressBlock.classList.add('hidden');
    startBtn.classList.remove('hidden');
    cancelBtn.classList.add('hidden');
    if (err.name === 'AbortError') {
      return;
    }
    errorEl.classList.remove('hidden');
    const title = document.createElement('h3');
    title.textContent = getLang() === 'de' ? 'Fehler beim Generieren' : 'Generation failed';
    errorEl.appendChild(title);
    const msg = document.createElement('p');
    msg.textContent = mapErrorMessage(err);
    errorEl.appendChild(msg);
    if (err.raw) {
      const pre = document.createElement('pre');
      pre.textContent = err.raw;
      errorEl.appendChild(pre);
    }
  } finally {
    startBtn.classList.remove('hidden');
    cancelBtn.classList.add('hidden');
  }
}

function mapErrorMessage(err) {
  const code = err.code || '';
  if (code === 'auth') return t('error.api.key');
  if (code === 'rate') return t('error.api.rate');
  if (code === 'not_found') return t('error.api.model', { model: state.config.model });
  if (code === 'timeout') return t('error.llm.timeout');
  if (code === 'network') return t('error.network');
  if (code === 'llm_json') return t('error.llm.json') + (err.message ? `\n${err.message}` : '');
  if (code === 'llm_schema') return t('error.llm.schema') + (err.message ? `\n${err.message}` : '');
  return err.message || t('error.generic');
}

// ---------- Step 4: Review ----------

function bindReview() {
  document.getElementById('export-xlsx').addEventListener('click', () => {
    try {
      exportXlsx(state.generation.questions, state.files);
    } catch (err) {
      console.error('XLSX export failed:', err);
      alert((getLang() === 'de' ? 'Excel-Export fehlgeschlagen: ' : 'Excel export failed: ') + err.message);
    }
  });
  document.getElementById('export-csv').addEventListener('click', () => {
    try {
      exportCsv(state.generation.questions, state.files);
    } catch (err) {
      console.error('CSV export failed:', err);
      alert((getLang() === 'de' ? 'CSV-Export fehlgeschlagen: ' : 'CSV export failed: ') + err.message);
    }
  });
  document.getElementById('regenerate').addEventListener('click', () => {
    navigateTo('generate');
  });
  document.getElementById('start-over').addEventListener('click', () => {
    if (confirm(getLang() === 'de' ? 'Alle Daten in diesem Tab zurücksetzen?' : 'Reset everything in this tab?')) {
      state.files = [];
      state.generation.questions = [];
      state.generation.usage = null;
      renderFileList();
      updateUploadSummary();
      navigateTo('upload');
    }
  });
}

function renderReview() {
  const n = state.generation.questions.length;
  const m = state.files.filter(f => f.status === 'ready' || f.status === 'warning').length;
  const summaryEl = document.getElementById('review-summary');
  // Custom plural render since we have two placeholders
  const template = (getLang() === 'de')
    ? `✓ ${n} ${n === 1 ? 'Frage' : 'Fragen'} aus ${m} ${m === 1 ? 'Datei' : 'Dateien'} generiert.`
    : `✓ ${n} ${n === 1 ? 'question' : 'questions'} generated from ${m} ${m === 1 ? 'file' : 'files'}.`;
  let extra = '';
  if (state.generation.usage) {
    const u = state.generation.usage;
    extra = ` · ${u.input_tokens.toLocaleString()} + ${u.output_tokens.toLocaleString()} tokens`;
  }
  summaryEl.textContent = template + extra;

  const tbody = document.getElementById('questions-tbody');
  tbody.innerHTML = '';
  state.generation.questions.forEach((q, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${escapeHtml(q.question)}</td>
      <td class="q-correct">${escapeHtml(q.correct_answer)}</td>
      <td><ul class="q-wrong">${q.wrong_answers.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul></td>
      <td class="q-explanation">${escapeHtml(q.explanation)}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ---------- Modals ----------

function bindModals() {
  document.querySelectorAll('[data-close-modal]').forEach(el => {
    el.addEventListener('click', () => {
      el.closest('.modal').classList.add('hidden');
    });
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal:not(.hidden)').forEach(m => m.classList.add('hidden'));
    }
  });
}

// ---------- Utils ----------

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
