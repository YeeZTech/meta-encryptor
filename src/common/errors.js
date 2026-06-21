import { getLocaleMessages } from './locale.js';

function _format(tpl, detail) {
  return tpl.replace(/\{(\w+)\}/g, (_, key) => detail?.[key] ?? `{${key}}`);
}

export class MetaEncryptorError extends Error {
  /**
   * @param {string} code - stable error code for programmatic handling and i18n
   * @param {Object} [options]
   * @param {*}       [options.detail] - arbitrary serializable context
   * @param {Error}   [options.cause]  - underlying error
   */
  constructor(code, { detail, cause } = {}) {
    // message defaults to English; localizedMessage reflects configured locale
    const msgs = getLocaleMessages();
    const tpl = (msgs && msgs[code]) || code;
    super(_format(tpl, detail), cause !== undefined ? { cause } : undefined);
    this.name = 'MetaEncryptorError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, MetaEncryptorError);
    }
  }

  get localizedMessage() {
    const msgs = getLocaleMessages();
    if (!msgs) return this.message;
    const tpl = msgs[this.code];
    if (!tpl) return this.message;
    return _format(tpl, this.detail);
  }

  toJSON() {
    const out = { name: this.name, code: this.code, message: this.message };
    if (this.detail !== undefined) out.detail = this.detail;
    if (this.cause) out.causeMessage = this.cause.message;
    return out;
  }
}
