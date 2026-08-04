import en from '../locales/en.json' with { type: 'json' };
import zhCN from '../locales/zh-CN.json' with { type: 'json' };

const _bundled = { en, 'zh-CN': zhCN };
let _messages = null;

export function detectLocale() {
  if (typeof navigator !== 'undefined' && navigator.language) {
    return navigator.language;
  }
  if (typeof process !== 'undefined' && process.env) {
    return process.env.LANG || process.env.LC_ALL || process.env.LC_CTYPE || 'en';
  }
  return 'en';
}

function _autoConfig() {
  _messages = _resolve(detectLocale());
}

export function configureLocale({ messages } = {}) {
  _messages = messages || null;
}

export function getLocaleMessages() {
  return _messages;
}

function _resolve(locale) {
  if (_bundled[locale]) return _bundled[locale];
  const prefix = locale.split('-')[0];
  for (const key of Object.keys(_bundled)) {
    if (key.startsWith(prefix)) return _bundled[key];
  }
  return en;
}

_autoConfig();
