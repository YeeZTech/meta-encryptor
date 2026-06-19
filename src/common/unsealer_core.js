/**
 * Shared unsealer logic for both Node (Buffer) and browser (Uint8Array).
 * Works with any Uint8Array-like (Buffer is a Uint8Array subclass).
 */

import { HeaderSize, MagicNum, CurrentBlockFileVersion } from './limits.js';
import { ntpackage2batch, fromNtInput } from './header_util.js';

// ---------------------------------------------------------------------------
// Header validation — pure function, works on Uint8Array | Buffer
// ---------------------------------------------------------------------------

/**
 * Validate header bytes and extract metadata.
 * @param {Uint8Array} headerBytes - first HeaderSize bytes of the sealed stream
 * @returns {{ itemNumber: number }}
 * @throws {Error} if magic or version is invalid
 */
export function validateHeader(headerBytes) {
  const dv = new DataView(
    headerBytes.buffer,
    headerBytes.byteOffset,
    headerBytes.byteLength
  );

  // read magic number (first 8 bytes, little-endian uint64)
  const magic = headerBytes.slice(0, 8);
  const magicNum = _getMagicNumBytes();
  if (magic.length !== magicNum.length) {
    throw new Error('Invalid magic number: length mismatch');
  }
  for (let i = 0; i < magic.length; i++) {
    if (magic[i] !== magicNum[i]) {
      throw new Error('Invalid magic number');
    }
  }

  // version_number at offset 8 (uint64 LE)
  const loVer = dv.getUint32(8, true);
  const hiVer = dv.getUint32(12, true);
  const version = hiVer * 0x100000000 + loVer;
  if (version !== CurrentBlockFileVersion) {
    throw new Error('Unsupported version: ' + version);
  }

  // item_number at offset 24 (uint64 LE)
  const loItem = dv.getUint32(24, true);
  const hiItem = dv.getUint32(28, true);
  const itemNumber = hiItem * 0x100000000 + loItem;

  return { itemNumber };
}

// ---------------------------------------------------------------------------
// Item reading — reads one item from the accumulated buffer (after header)
// ---------------------------------------------------------------------------

/**
 * Try to read ONE item from accumulated bytes.
 * Returns the cipher slice and the remaining unconsumed bytes,
 * or null if not enough data.
 *
 * @param {Uint8Array} accumulated - bytes after header
 * @returns {{ cipher: Uint8Array, remaining: Uint8Array, consumedBytes: number } | null}
 */
export function tryReadItem(accumulated) {
  if (accumulated.length < 8) return null;

  const dv = new DataView(
    accumulated.buffer,
    accumulated.byteOffset,
    accumulated.byteLength
  );
  const lo = dv.getUint32(0, true);
  const hi = dv.getUint32(4, true);
  const itemSize = hi * 0x100000000 + lo;

  const totalItemBytes = 8 + itemSize; // prefix + data
  if (accumulated.length < totalItemBytes) return null;

  const cipher = accumulated.slice(8, totalItemBytes);
  const remaining = accumulated.slice(totalItemBytes);

  return { cipher, remaining, consumedBytes: totalItemBytes };
}

// ---------------------------------------------------------------------------
// Batch unpacking — decrypt → ntpackage2batch → fromNtInput
// ---------------------------------------------------------------------------

/**
 * Unpack a decrypted message into plaintext chunks.
 * @param {Uint8Array} decrypted - raw decrypted message bytes
 * @returns {Uint8Array[]} array of plaintext segments
 */
export function unpackDecrypted(decrypted) {
  const batch = ntpackage2batch(decrypted);
  /** @type {Uint8Array[]} */
  const outputs = [];
  for (let i = 0; i < batch.length; i++) {
    let it = batch[i];
    // normalise Uint8Array
    if (it instanceof ArrayBuffer) {
      it = new Uint8Array(it);
    } else if (ArrayBuffer.isView(it)) {
      it = new Uint8Array(it.buffer, it.byteOffset, it.byteLength);
    }
    outputs.push(fromNtInput(it));
  }
  return outputs;
}

// ---------------------------------------------------------------------------
// High-level state machine — drives the full unseal loop for one chunk
// ---------------------------------------------------------------------------

/**
 * Concatenate two Uint8Arrays.
 */
export function concatUint8Array(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Create a fresh unseal state object.
 */
export function createUnsealState(initial = {}) {
  return {
    accumulated: initial.accumulated || new Uint8Array(0),
    isHeaderReady: initial.isHeaderReady || false,
    totalItems: initial.totalItems || 0,
    readItemCount: initial.readItemCount || 0,
    processedBytes: initial.processedBytes || 0,
    writeBytes: initial.writeBytes || 0,
  };
}

/**
 * Feed one chunk through the unseal state machine.
 */
export async function processSealedChunk(state, newChunk, { decrypt, onPlain, onProgress, onItemDone, onBatchItem }) {
  const data = newChunk instanceof Uint8Array ? newChunk : new Uint8Array(newChunk);
  state.accumulated = concatUint8Array(state.accumulated, data);

  if (!state.isHeaderReady) {
    if (state.accumulated.length < HeaderSize) return;
    const headerBytes = state.accumulated.slice(0, HeaderSize);
    const { itemNumber } = validateHeader(headerBytes);
    state.totalItems = itemNumber;
    state.accumulated = state.accumulated.slice(HeaderSize);
    state.isHeaderReady = true;
  }

  while (true) {
    const item = tryReadItem(state.accumulated);
    if (!item) break;

    state.accumulated = item.remaining;
    state.processedBytes += item.consumedBytes;

    const decrypted = await decrypt(item.cipher);
    if (!decrypted || decrypted.length < 12) continue;

    let plainSize = 0;
    const batch = ntpackage2batch(decrypted);
    for (let i = 0; i < batch.length; i++) {
      let it = batch[i];
      if (it instanceof ArrayBuffer) it = new Uint8Array(it);
      else if (ArrayBuffer.isView(it)) it = new Uint8Array(it.buffer, it.byteOffset, it.byteLength);
      if (onBatchItem) onBatchItem(it);
      const plain = fromNtInput(it);
      plainSize += plain.length;
      state.writeBytes += plain.length;
      onPlain(plain);
    }

    state.readItemCount += 1;
    if (onItemDone) onItemDone({ consumedBytes: item.consumedBytes, plainSize });
    if (onProgress) {
      onProgress(state.totalItems, state.readItemCount, state.processedBytes, state.writeBytes);
    }
    if (state.readItemCount >= state.totalItems) break;
  }
}

// ---------------------------------------------------------------------------
// UnsealerCore — base class that encapsulates the shared state machine
// ---------------------------------------------------------------------------

/**
 * Base class for stream-based unsealers.
 *
 * Subclasses (Node stream.Transform, browser TransformStream) only need to:
 *   - provide a `decrypt(cipher) => Promise<Uint8Array>`
 *   - route `onPlain(plain)` to their output mechanism
 *   - call `this.core.processChunk(chunk)` for each incoming chunk
 *
 * @example
 *   // Browser TransformStream
 *   class Unsealer extends TransformStream {
 *     #core;
 *     constructor({ privateKeyHex, progressHandler }) {
 *       const core = new UnsealerCore({
 *         decrypt: (c) => BrowserCrypto.decryptMessage(privateKeyHex, c),
 *         onPlain: null, // set later in transform
 *         progressHandler,
 *       });
 *       super({ async transform(chunk, ctrl) { core.onPlain = (b) => ctrl.enqueue(b); await core.processChunk(chunk); } });
 *       this.#core = core;
 *     }
 *   }
 *
 * @example
 *   // Node Transform
 *   class Unsealer extends Transform {
 *     #core;
 *     constructor(opts) {
 *       super(opts);
 *       this.#core = new UnsealerCore({
 *         decrypt: (c) => YPCCrypto.decryptMessage(key, c),
 *         onPlain: (b) => this.push(b),
 *         onBatchItem: (it) => { this.dataHash = keccak256(…); },
 *         progressHandler: opts.progressHandler,
 *       });
 *     }
 *     _transform(chunk, enc, cb) { this.#core.processChunk(chunk).then(() => cb()).catch(cb); }
 *   }
 */
export class UnsealerCore {
  /** @type {ReturnType<typeof createUnsealState>} */
  #state;

  /** @type {(cipher: Uint8Array) => Promise<Uint8Array>} */
  #decrypt;

  /** @type {(plain: Uint8Array) => void} */
  onPlain;

  /** @type {(total:number, read:number, procBytes:number, writeBytes:number) => void} */
  #onProgress;

  /** @type {(info: {consumedBytes:number, plainSize:number}) => void} */
  #onItemDone;

  /** @type {(rawBatchItem: Uint8Array) => void} */
  #onBatchItem;

  /**
   * @param {{
   *   decrypt: (cipher: Uint8Array) => Promise<Uint8Array>,
   *   onPlain?: (plain: Uint8Array) => void,
   *   onProgress?: (total:number, read:number, procBytes:number, writeBytes:number) => void,
   *   onItemDone?: (info: {consumedBytes:number, plainSize:number}) => void,
   *   onBatchItem?: (rawBatchItem: Uint8Array) => void,
   *   initialState?: { accumulated?: Uint8Array, isHeaderReady?: boolean, totalItems?: number, readItemCount?: number, processedBytes?: number, writeBytes?: number }
   * }} opts
   */
  constructor({ decrypt, onPlain, onProgress, onItemDone, onBatchItem, initialState }) {
    this.#state = createUnsealState(initialState || {});
    this.#decrypt = decrypt;
    this.onPlain = onPlain || (() => {});
    this.#onProgress = onProgress || null;
    this.#onItemDone = onItemDone || null;
    this.#onBatchItem = onBatchItem || null;
  }

  /** Feed one chunk. Resolves when all extractable items have been output. */
  async processChunk(chunk) {
    return processSealedChunk(this.#state, chunk, {
      decrypt: this.#decrypt,
      onPlain: (b) => this.onPlain(b),
      onProgress: this.#onProgress,
      onItemDone: this.#onItemDone,
      onBatchItem: this.#onBatchItem,
    });
  }

  get finished() { return this.#state.totalItems > 0 && this.#state.readItemCount >= this.#state.totalItems; }
  get totalItems() { return this.#state.totalItems; }
  get readItemCount() { return this.#state.readItemCount; }
  /** @type {Uint8Array} unconsumed trailing bytes (for context persistence) */
  get remaining() { return this.#state.accumulated; }
  set remaining(buf) { this.#state.accumulated = buf; }
  get processedBytes() { return this.#state.processedBytes; }
  get writeBytes() { return this.#state.writeBytes; }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** @returns {Uint8Array} */
function _getMagicNumBytes() {
  if (MagicNum instanceof Uint8Array) return MagicNum;
  if (MagicNum && typeof MagicNum === 'object' && 'buffer' in MagicNum) {
    return new Uint8Array(
      MagicNum.buffer,
      MagicNum.byteOffset || 0,
      MagicNum.byteLength || MagicNum.length
    );
  }
  // fallback hex string
  const hex = String(MagicNum).replace(/^0x/, '');
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return arr;
}
