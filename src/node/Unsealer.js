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

  constructor(options) {
    super(options);

    const keyPair = options.keyPair;
    const progressHandler = options.progressHandler;
    const context = options ? options.context : undefined;
    const ctx = context && context.context ? context.context : {};
    const resumeBytesValue = options?.processedBytes ?? ctx.readStart ?? 0;
    const resumeBytes = Number.isFinite(resumeBytesValue) && resumeBytesValue > 0
      ? resumeBytesValue
      : 0;
    const restoredItemCount = options?.processedItemCount ?? ctx.readItemCount ?? 0;
    if (!Number.isSafeInteger(restoredItemCount) || restoredItemCount < 0) {
      throw new TypeError('processedItemCount must be a non-negative safe integer');
    }

    let core;
    core = new UnsealerCore({
      decrypt: (cipher) =>
        YPCCrypto.decryptMessage(Buffer.from(keyPair["private_key"], 'hex'), cipher),
      onPlain: (b) => this.push(b),
      onProgress: progressHandler,
      maxSealedItemSize: options?.maxSealedItemSize,
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
          context.runtime.pendingBlocks.push({
            rawSize: consumedBytes,
            plainSize,
            remainingPlain: plainSize,
            dataHash: Buffer.from(core.runningDataHash)
          });
        }
      },
      initialState: {
        readItemCount: restoredItemCount,
        processedBytes: resumeBytesValue,
        writeBytes: options?.writeBytes ?? ctx.writeStart ?? 0,
        runningDataHash: ctx.dataHash,
      }
    });
    this.#core = core;

    // keep references for external consumers (tests may read them)
    this._keyPair = keyPair;
    this._progressHandler = progressHandler;
    this._context = context;
    this._skipSealedInput = Boolean(
      context?.runtime?.skipSealedInput ||
      (ctx.output?.policy === 'same-file-staging' &&
        (ctx.phase === 'replacing' || ctx.phase === 'complete'))
    );
    this._dataHash = Buffer.from(core.runningDataHash);
    this._state = this.#core; // backwards-compat shorthand

    logger.debug("Unsealer : ", this);
  }

  async _transform(chunk, encoding, callback) {
    if (this._skipSealedInput) {
      callback(new MetaEncryptorError('ERR_CHECKPOINT_INVALID', {
        detail: { reason: 'terminal same-file checkpoint received sealed input' }
      }));
      return;
    }
    try {
      await this.#core.processChunk(chunk);

      // persist trailing unconsumed bytes for recoverable stream context
      if (this._context && this._context.context && this._context.context["status"] === "file") {
        const remaining = this.#core.remaining;
        this._context.context["data"] = remaining.length > 0
          ? Buffer.from(remaining.buffer, remaining.byteOffset, remaining.byteLength)
          : Buffer.alloc(0);
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
    if (this._skipSealedInput) {
      if (this._context?.runtime) this._context.runtime.inputComplete = true;
      if (this._context?.context?.dataHash) {
        this._dataHash = Buffer.from(this._context.context.dataHash);
      }
      callback();
      return;
    }
    try {
      const finalState = this.#core.finalize();
      this._dataHash = Buffer.from(finalState.dataHash);
      if (this._context) {
        if (!this._context.runtime) this._context.runtime = {};
        this._context.runtime.inputComplete = true;
        if (this._context.context) {
          this._context.context.dataHash = Buffer.from(finalState.dataHash);
          this._context.context.phase = 'verified';
        }
      }
      callback();
    } catch (error) {
      callback(error);
    }
  }
}
