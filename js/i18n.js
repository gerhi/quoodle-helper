// js/i18n.js — Translation module
// Loads a JSON per language, exposes t(key, params) and tp(key, n, params).
// Re-binds all [data-i18n] elements on language change.

const SUPPORTED = ['de', 'en', 'fr'];
const FALLBACK = 'de';

let current = FALLBACK;
let dict = {};

export async function initI18n() {
  const saved = localStorage.getItem('quoodle-helper.lang');
  const browser = (navigator.language || 'de').slice(0, 2).toLowerCase();
  const chosen = SUPPORTED.includes(saved) ? saved : (SUPPORTED.includes(browser) ? browser : FALLBACK);
  await setLang(chosen);
}

export async function setLang(lang) {
  if (!SUPPORTED.includes(lang)) lang = FALLBACK;
  if (current === lang && Object.keys(dict).length > 0) return;
  const res = await fetch(`lang/${lang}.json`);
  if (!res.ok) throw new Error(`Could not load language: ${lang}`);
  dict = await res.json();
  current = lang;
  localStorage.setItem('quoodle-helper.lang', lang);
  document.documentElement.lang = lang;
  applyDomTranslations();
  document.querySelectorAll('.lang-switch [data-lang]').forEach(el => {
    el.classList.toggle('active', el.dataset.lang === lang);
  });
  // Re-emit event so view controllers can update dynamic content
  document.dispatchEvent(new CustomEvent('i18n:changed', { detail: { lang } }));
}

export function getLang() {
  return current;
}

export function t(key, params = {}) {
  let str = dict[key];
  if (str === undefined) return key; // fallback: show key
  return interpolate(str, params);
}

/** Plural: dict value uses "singular|plural" with {n} placeholders. */
export function tp(key, n, params = {}) {
  const raw = dict[key];
  if (raw === undefined) return key;
  // Support multi-form like "{n} A generated from {m} B|{n} As generated from {m} Bs"
  // We choose singular if n === 1, else plural. If no pipe, same string for all.
  const forms = raw.split('|');
  const chosen = (n === 1 || forms.length < 2) ? forms[0] : forms[1];
  return interpolate(chosen, { n, ...params });
}

function interpolate(str, params) {
  return str.replace(/\{(\w+)\}/g, (m, key) => {
    return params[key] !== undefined ? String(params[key]) : m;
  });
}

function applyDomTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    const translated = dict[key];
    if (translated === undefined) return;
    // If the element has children other than text (like buttons with icons + span),
    // only replace direct text nodes. For simplicity, use textContent for
    // inline elements and innerHTML for modal bodies where we want HTML rendering.
    if (key.endsWith('.body')) {
      el.innerHTML = translated;
    } else {
      el.textContent = translated;
    }
  });
}
