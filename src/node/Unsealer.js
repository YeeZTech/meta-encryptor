import { keccak_256 as keccak256} from '@noble/hashes/sha3';
import { Transform } from "stream";
import log from "loglevel";

import { UnsealerCore } from '../common/unsealer_core.js';
import { MetaEncryptorError } from '../common/errors.js';
const logger = log.getLogger("meta-encryptor/Unsealer");

import YPCCryptoFun from "./ypccrypto.js";
const YPCCrypto = YPCCryptoFun();

export class Unsealer extends Transform {
  /** @type {UnsealerCore} */
  #core;

  /** @type {boolean} skip strict truncation check for legacy resumed contexts */
  #lenientEof = false;

  constructor(options) {
    super(options);

    const keyPair = options.keyPair;
    const progressHandler = options.progressHandler;
    const context = options ? options.context : undefined;

    // Node-specific rolling keccak256 hash
    let dataHash = Buffer.from(keccak256(Buffer.from("Fidelius", "utf-8")));

    this.#core = new UnsealerCore({
      decrypt: (cipher) =>
        YPCCrypto.decryptMessage(Buffer.from(keyPair["private_key"], 'hex'), cipher),
      onPlain: (b) => this.push(b),
      onProgress: progressHandler,
      onBatchItem: (rawBatch) => {
        const k = Buffer.from(
          dataHash.toString("hex") + Buffer.from(rawBatch).toString("hex"),
          "hex"
        );
        dataHash = Buffer.from(keccak256(k));
      },
      onItemDone: ({ consumedBytes, plainSize }) => {
        // update recoverable-stream context
        if (context && context.context && context.context["status"] === "file") {
          if (!context.runtime) {
            context.runtime = {
              rawCommitted: context.context.readStart || 0,
              plainCommitted: context.context.writeStart || 0,
              pendingBlocks: []
            };
          } else {
            if (context.runtime.rawCommitted === undefined)
              context.runtime.rawCommitted = context.context.readStart || 0;
            if (context.runtime.plainCommitted === undefined)
              context.runtime.plainCommitted = context.context.writeStart || 0;
            if (!Array.isArray(context.runtime.pendingBlocks))
              context.runtime.pendingBlocks = [];
          }
          context.runtime.pendingBlocks.push({ rawSize: consumedBytes, plainSize, remainingPlain: plainSize });
        }
      },
      initialState: {
        readItemCount: options ? (options.processedItemCount || 0) : 0,
        processedBytes: options ? (options.processedBytes || 0) : 0,
        writeBytes: options ? (options.writeBytes || 0) : 0,
      }
    });

    // On resumed sessions the item count may be absent or incomplete (contexts
    // persisted by older versions), making `finished` unreachable — the strict
    // truncation check in _flush only applies to fresh (non-resumed) streams.
    this.#lenientEof =
      !!options &&
      ((options.processedBytes || 0) > 0 || (options.processedItemCount || 0) > 0);

    // keep references for external consumers (tests may read them)
    this._keyPair = keyPair;
    this._progressHandler = progressHandler;
    this._context = context;
    this._dataHash = dataHash;
    this._state = this.#core; // backwards-compat shorthand

    logger.debug("Unsealer : ", this);
  }

  async _transform(chunk, encoding, callback) {
    try {
      await this.#core.processChunk(chunk);

      // persist trailing unconsumed bytes for recoverable stream context
      if (this._context && this._context.context && this._context.context["status"] === "file") {
        this._context.context["data"] = this.#core.remaining;
      }

      callback();
    } catch (err) {
      logger.error("err " + err);
      callback(err);
    }
  }

  // End the readable side only when the input ends (never push(null) inside
  // _transform — trailing bytes arriving after an early EOF would trigger
  // ERR_STREAM_PUSH_AFTER_EOF). If the input ended before every declared item
  // was decrypted, the sealed input was truncated: fail instead of silently
  // emitting a shorter plaintext.
  _flush(callback) {
    // headerReady with totalItems === 0 is a legitimately empty sealed stream.
    if (!this.#core.headerReady ||
        (!this.#lenientEof && this.#core.totalItems > 0 && !this.#core.finished)) {
      callback(new MetaEncryptorError('ERR_TRUNCATED_INPUT', {
        detail: {
          headerReady: this.#core.headerReady,
          readItemCount: this.#core.readItemCount,
          totalItems: this.#core.totalItems,
        }
      }));
      return;
    }
    callback();
  }
}
