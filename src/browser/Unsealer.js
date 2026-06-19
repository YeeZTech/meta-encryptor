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
      }
    });

    this.#core = core;
  }

  get finished() { return this.#core.finished; }
  get totalItems() { return this.#core.totalItems; }
  get readItemCount() { return this.#core.readItemCount; }
}

export default Unsealer;
