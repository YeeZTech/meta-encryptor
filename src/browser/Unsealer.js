/**
 * Browser Unsealer — extends Web Streams TransformStream to decrypt a sealed
 * stream and output plaintext chunks, analogous to Node's stream.Transform.
 *
 * Usage:
 *   fetch(url).body
 *     .pipeThrough(new Unsealer({ privateKeyHex: '…' }))
 *     .pipeTo(new WritableStream({ write(chunk) { … } }));
 */

import { UnsealerCore } from '../common/unsealer_core.js';
import { BrowserCrypto } from './ypccrypto.browser.js';
import { MetaEncryptorError } from '../common/errors.js';

export class Unsealer extends TransformStream {
  /** @type {UnsealerCore} */
  #core;

  constructor({ privateKeyHex, progressHandler } = {}) {
    const core = new UnsealerCore({
      decrypt: (cipher) => BrowserCrypto.decryptMessage(privateKeyHex, cipher),
      onProgress: progressHandler,
    });

    super({
      transform: async (chunk, controller) => {
        core.onPlain = (plain) => controller.enqueue(plain);
        await core.processChunk(chunk);
      },
      flush: async () => {
        // Upstream closed: if not every declared item was decrypted the sealed
        // input was truncated — fail instead of finishing with shorter output.
        // headerReady with totalItems === 0 is a legitimately empty stream.
        if (!core.headerReady || (core.totalItems > 0 && !core.finished)) {
          throw new MetaEncryptorError('ERR_TRUNCATED_INPUT', {
            detail: {
              headerReady: core.headerReady,
              readItemCount: core.readItemCount,
              totalItems: core.totalItems,
            }
          });
        }
      }
    });

    this.#core = core;
  }

  get finished() { return this.#core.finished; }
  get totalItems() { return this.#core.totalItems; }
  get readItemCount() { return this.#core.readItemCount; }
}

export default Unsealer;
