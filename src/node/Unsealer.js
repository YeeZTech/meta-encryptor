import { createRollingHasher, resolveKeccak256 } from './keccak256.js';
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
    // ctx.readStart 指向"消费前沿"（含已存入 ctx.data 的待回放密文），
    // unsealer 真正的已消费字节数需要减去待回放部分。
    const ctxDataLen = ctx.data ? ctx.data.length : 0;

    // Node-specific rolling keccak256 hash（原生优先，每个 item 都要过一遍，是解密的主要成本）
    const hasher = createRollingHasher(resolveKeccak256(options.hashProvider));

    this.#core = new UnsealerCore({
      decrypt: (cipher) =>
        YPCCrypto.decryptMessage(Buffer.from(keyPair["private_key"], 'hex'), cipher),
      onPlain: (b) => this.push(b),
      onProgress: progressHandler,
      onBatchItem: (rawBatch) => {
        this._dataHash = hasher.update(rawBatch);
      },
      onItemDone: ({ consumedBytes, plainSize, rawItem }) => {
        // update recoverable-stream context；'context' 表示正在回放上次
        // checkpoint 存下的待处理密文，同样需要纳入 pending 跟踪
        const status = context && context.context ? context.context["status"] : undefined;
        if (context && context.context && (status === "file" || status === "context")) {
          if (!context.runtime) {
            context.runtime = {
              rawCommitted: (context.context.readStart || 0) - ctxDataLen,
              plainCommitted: context.context.writeStart || 0,
              pendingBlocks: []
            };
          } else {
            if (context.runtime.rawCommitted === undefined)
              context.runtime.rawCommitted = (context.context.readStart || 0) - ctxDataLen;
            if (context.runtime.plainCommitted === undefined)
              context.runtime.plainCommitted = context.context.writeStart || 0;
            if (!Array.isArray(context.runtime.pendingBlocks))
              context.runtime.pendingBlocks = [];
          }
          context.runtime.pendingBlocks.push({
            rawSize: consumedBytes,
            plainSize,
            remainingPlain: plainSize,
            // 保留原始密文：inplace 解密时该区域可能被明文覆盖，
            // checkpoint 需将其存入 context.data 供 resume 回放
            raw: rawItem
              ? Buffer.from(rawItem.buffer, rawItem.byteOffset, rawItem.byteLength)
              : null
          });
        }
      },
      initialState: {
        readItemCount: options?.processedItemCount ?? ctx.readItemCount ?? 0,
        processedBytes: options?.processedBytes ??
          (ctx.readStart !== undefined ? Math.max(0, ctx.readStart - ctxDataLen) : 0),
        writeBytes: options?.writeBytes ?? ctx.writeStart ?? 0,
      }
    });

    // keep references for external consumers (tests may read them)
    this._keyPair = keyPair;
    this._progressHandler = progressHandler;
    this._context = context;
    /** 滚动哈希当前值；随每个 item 更新（此前只停留在种子值） */
    this._dataHash = hasher.value;
    this._state = this.#core; // backwards-compat shorthand

    logger.debug("Unsealer : ", this);
  }

  async _transform(chunk, encoding, callback) {
    try {
      await this.#core.processChunk(chunk);

      if (this.#core.finished) {
        // 通知 RecoverableWriteStream 解密已完成：只有此时 _final 才允许
        // truncate（inplace 场景下提前截断会毁掉未消费的密文与尾部 header）
        if (this._context && this._context.context) {
          this._context.context["decryptCompleted"] = true;
        }
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
