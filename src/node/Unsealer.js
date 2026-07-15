import { keccak_256 as keccak256} from '@noble/hashes/sha3';
import { Transform } from "stream";
import log from "loglevel";

import { UnsealerCore } from '../common/unsealer_core.js';
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
        readItemCount: options?.processedItemCount ?? ctx.readItemCount ?? 0,
        processedBytes: options?.processedBytes ?? ctx.readStart ?? 0,
        writeBytes: options?.writeBytes ?? ctx.writeStart ?? 0,
      }
    });

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

      if (this.#core.finished) {
        this.push(null);
      }

      // Sync unconsumed cipher tail for recoverable Read replay (see Recoverable.spec.js)
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

  _flush(callback) { callback(); }
}
