/**
 * Shared unsealer logic for both Node (Buffer) and browser (Uint8Array).
 * Works with any Uint8Array-like (Buffer is a Uint8Array subclass).
 */

import { MetaEncryptorError } from './errors.js';
import { keccak_256 as keccak256 } from '@noble/hashes/sha3';

import {
  HeaderSize,
  BlockInfoSize,
  MagicNum,
  CurrentBlockFileVersion,
  BlockNumLimit,
  ItemsPerBlockLimit,
  MaxItemNumber,
  MaxSealedItemSize,
  CryptoEnvelopeSize,
  NtPackageHeaderSize,
} from './limits.js';
import { ntpackage2batch, fromNtInput, readUint64LE, buffer2block_info_t } from './header_util.js';

const INITIAL_DATA_HASH = new TextEncoder().encode('Fidelius');

function normalizeMaxSealedItemSize(value) {
  const maximum = value ?? MaxSealedItemSize;
  const minimum = CryptoEnvelopeSize + NtPackageHeaderSize;
  if (!Number.isSafeInteger(maximum) || maximum < minimum) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: { field: 'maxSealedItemSize', value: maximum, minimum }
    });
  }
  return maximum;
}

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
  if (!(headerBytes instanceof Uint8Array) || headerBytes.byteLength !== HeaderSize) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: { field: 'headerLength', expected: HeaderSize, actual: headerBytes?.byteLength }
    });
  }
  // read magic number (first 8 bytes, little-endian uint64)
  const magic = headerBytes.slice(0, 8);
  const magicNum = _getMagicNumBytes();
  if (magic.length !== magicNum.length) {
    throw new MetaEncryptorError('ERR_INVALID_MAGIC_LENGTH');
  }
  for (let i = 0; i < magic.length; i++) {
    if (magic[i] !== magicNum[i]) {
      throw new MetaEncryptorError('ERR_INVALID_MAGIC');
    }
  }

  // version_number at offset 8 (uint64 LE)
  const version = readUint64LE(headerBytes, 8).toNumber();
  if (version !== CurrentBlockFileVersion) {
    throw new MetaEncryptorError('ERR_UNSUPPORTED_VERSION', { detail: { version } });
  }

  // block_number at offset 16 (uint64 LE)
  const blockNumber = readUint64LE(headerBytes, 16).toNumber();

  // item_number at offset 24 (uint64 LE)
  const itemNumber = readUint64LE(headerBytes, 24).toNumber();

  if (blockNumber > BlockNumLimit || itemNumber > MaxItemNumber) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: { field: 'headerCounts', blockNumber, itemNumber }
    });
  }
  const expectedBlockNumber = itemNumber === 0
    ? 0
    : Math.ceil(itemNumber / ItemsPerBlockLimit);
  if (blockNumber !== expectedBlockNumber) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: { field: 'blockItemCount', blockNumber, itemNumber, expectedBlockNumber }
    });
  }

  return {
    itemNumber,
    blockNumber,
    dataHash: headerBytes.slice(32, 64),
  };
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
export function tryReadItem(accumulated, maxSealedItemSize = MaxSealedItemSize) {
  if (accumulated.length < 8) return null;
  const maximum = normalizeMaxSealedItemSize(maxSealedItemSize);
  const itemSize = readUint64LE(accumulated, 0).toNumber();
  if (itemSize < CryptoEnvelopeSize + NtPackageHeaderSize || itemSize > maximum) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: { field: 'itemSize', itemSize, maximum }
    });
  }

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
  const initialHash = initial.runningDataHash || initial.dataHash;
  if (initialHash !== undefined && (!(initialHash instanceof Uint8Array) || initialHash.byteLength !== 32)) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: { field: 'runningDataHash', length: initialHash?.byteLength }
    });
  }
  return {
    accumulated: initial.accumulated || new Uint8Array(0),
    isHeaderReady: initial.isHeaderReady || false,
    totalItems: initial.totalItems || 0,
    readItemCount: initial.readItemCount || 0,
    processedBytes: initial.processedBytes || 0,
    writeBytes: initial.writeBytes || 0,
    expectedDataHash: initial.expectedDataHash || null,
    runningDataHash: initialHash
      ? new Uint8Array(initialHash)
      : new Uint8Array(keccak256(INITIAL_DATA_HASH)),
  };
}

/**
 * Validate the block-info table against header counts and the sealed content
 * size.  This can be called after reading only the file tail; content bytes do
 * not need to be allocated.
 */
export function validateSealedLayout(
  headerBytes,
  blockInfoBytes,
  contentSize,
  totalFileSize,
  maxSealedItemSize = MaxSealedItemSize
) {
  const header = validateHeader(headerBytes);
  const maximumItemSize = normalizeMaxSealedItemSize(maxSealedItemSize);
  if (!Number.isSafeInteger(contentSize) || contentSize < 0) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: { field: 'contentSize', contentSize }
    });
  }
  if (!(blockInfoBytes instanceof Uint8Array) ||
      blockInfoBytes.byteLength !== header.blockNumber * BlockInfoSize) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: {
        field: 'blockInfoLength',
        expected: header.blockNumber * BlockInfoSize,
        actual: blockInfoBytes?.byteLength,
      }
    });
  }
  const expectedTotal = contentSize + blockInfoBytes.byteLength + HeaderSize;
  if (totalFileSize !== undefined &&
      (!Number.isSafeInteger(totalFileSize) || totalFileSize !== expectedTotal)) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: { field: 'fileSize', expected: expectedTotal, actual: totalFileSize }
    });
  }

  let expectedItemStart = 0;
  let expectedFileStart = 0;
  for (let i = 0; i < header.blockNumber; i++) {
    const info = buffer2block_info_t(
      blockInfoBytes.subarray(i * BlockInfoSize, (i + 1) * BlockInfoSize)
    );
    const itemCount = info.end_item_index - info.start_item_index;
    const blockByteLength = info.end_file_pos - info.start_file_pos;
    const minimumBlockBytes = itemCount * (8 + CryptoEnvelopeSize + NtPackageHeaderSize);
    const maximumBlockBytes = itemCount * (8 + maximumItemSize);
    if (info.start_item_index !== expectedItemStart ||
        itemCount <= 0 || itemCount > ItemsPerBlockLimit ||
        (i < header.blockNumber - 1 && itemCount !== ItemsPerBlockLimit) ||
        info.end_item_index > header.itemNumber ||
        info.start_file_pos !== expectedFileStart ||
        info.end_file_pos <= info.start_file_pos ||
        info.end_file_pos > contentSize ||
        blockByteLength < minimumBlockBytes ||
        blockByteLength > maximumBlockBytes) {
      throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
        detail: { field: 'blockInfo', blockIndex: i }
      });
    }
    expectedItemStart = info.end_item_index;
    expectedFileStart = info.end_file_pos;
  }
  if (expectedItemStart !== header.itemNumber || expectedFileStart !== contentSize) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: {
        field: 'blockInfoCoverage',
        coveredItems: expectedItemStart,
        itemNumber: header.itemNumber,
        coveredBytes: expectedFileStart,
        contentSize,
      }
    });
  }
  return { ...header, contentSize, totalFileSize: expectedTotal };
}

/**
 * Feed one chunk through the unseal state machine.
 */
export async function processSealedChunk(state, newChunk, {
  decrypt,
  onPlain,
  onProgress,
  onItemDone,
  onBatchItem,
  maxSealedItemSize = MaxSealedItemSize,
}) {
  const data = newChunk instanceof Uint8Array ? newChunk : new Uint8Array(newChunk);
  state.accumulated = concatUint8Array(state.accumulated, data);
  let offset = 0;

  if (!state.isHeaderReady) {
    if (state.accumulated.length < HeaderSize) return;
    const headerBytes = state.accumulated.subarray(0, HeaderSize);
    const { itemNumber, dataHash } = validateHeader(headerBytes);
    state.totalItems = itemNumber;
    state.expectedDataHash = dataHash;
    offset = HeaderSize;
    state.isHeaderReady = true;
  }

  while (true) {
    if (state.readItemCount >= state.totalItems) break;

    const item = tryReadItem(state.accumulated.subarray(offset), maxSealedItemSize);
    if (!item) break;

    offset += item.consumedBytes;
    state.processedBytes += item.consumedBytes;

    const decrypted = await decrypt(item.cipher);
    if (!decrypted || decrypted.length < 12) {
      // A failed/short decrypt means a wrong key or corrupt data. Silently
      // skipping would leave readItemCount short of totalItems forever (the
      // stream would hang instead of finishing) and truncate the output.
      throw new MetaEncryptorError('ERR_DECRYPT_FAILED', {
        detail: {
          itemIndex: state.readItemCount,
          cipherLength: item.cipher.length,
          decryptedLength: decrypted ? decrypted.length : 0,
        }
      });
    }

    let plainSize = 0;
    const batch = ntpackage2batch(decrypted);
    if (batch.length === 0) {
      throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
        detail: { field: 'emptyNtPackage', itemIndex: state.readItemCount }
      });
    }
    for (let i = 0; i < batch.length; i++) {
      let it = batch[i];
      if (it instanceof ArrayBuffer) it = new Uint8Array(it);
      else if (ArrayBuffer.isView(it)) it = new Uint8Array(it.buffer, it.byteOffset, it.byteLength);
      if (onBatchItem) onBatchItem(it);
      state.runningDataHash = new Uint8Array(keccak256(
        concatUint8Array(state.runningDataHash, it)
      ));
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
  }

  state.accumulated = state.accumulated.slice(offset);

  if (state.readItemCount >= state.totalItems && state.accumulated.length > 0) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: { field: 'trailingBytes', trailingBytes: state.accumulated.length }
    });
  }
}

function hashesEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Strictly verify that a sealed stream was consumed in full and is authentic. */
export function verifyFinalState(state) {
  if (!state.isHeaderReady || state.readItemCount !== state.totalItems) {
    throw new MetaEncryptorError('ERR_TRUNCATED_INPUT', {
      detail: {
        headerReady: state.isHeaderReady,
        readItemCount: state.readItemCount,
        totalItems: state.totalItems,
      }
    });
  }
  if (state.accumulated.length !== 0) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
      detail: { field: 'trailingBytes', trailingBytes: state.accumulated.length }
    });
  }
  if (!hashesEqual(state.runningDataHash, state.expectedDataHash)) {
    throw new MetaEncryptorError('ERR_INTEGRITY_MISMATCH', {
      detail: { readItemCount: state.readItemCount }
    });
  }
  return {
    totalItems: state.totalItems,
    processedBytes: state.processedBytes,
    writeBytes: state.writeBytes,
    dataHash: new Uint8Array(state.runningDataHash),
  };
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

  /** @type {number} */
  #maxSealedItemSize;

  /**
   * @param {{
   *   decrypt: (cipher: Uint8Array) => Promise<Uint8Array>,
   *   onPlain?: (plain: Uint8Array) => void,
   *   onProgress?: (total:number, read:number, procBytes:number, writeBytes:number) => void,
   *   onItemDone?: (info: {consumedBytes:number, plainSize:number}) => void,
   *   onBatchItem?: (rawBatchItem: Uint8Array) => void,
    *   initialState?: { accumulated?: Uint8Array, isHeaderReady?: boolean, totalItems?: number, readItemCount?: number, processedBytes?: number, writeBytes?: number },
    *   maxSealedItemSize?: number
    * }} opts
    */
  constructor({ decrypt, onPlain, onProgress, onItemDone, onBatchItem, initialState, maxSealedItemSize }) {
    this.#state = createUnsealState(initialState || {});
    this.#maxSealedItemSize = normalizeMaxSealedItemSize(maxSealedItemSize);
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
      maxSealedItemSize: this.#maxSealedItemSize,
    });
  }

  /** Verify item count, exact consumption, and the header data hash. */
  finalize() { return verifyFinalState(this.#state); }

  /** Alias for callers that prefer an explicit verification name. */
  verifyFinalState() { return this.finalize(); }

  get finished() { return this.#state.isHeaderReady && this.#state.readItemCount === this.#state.totalItems; }
  get headerReady() { return this.#state.isHeaderReady; }
  get totalItems() { return this.#state.totalItems; }
  get readItemCount() { return this.#state.readItemCount; }
  /** @type {Uint8Array} unconsumed trailing bytes (for context persistence) */
  get remaining() { return this.#state.accumulated; }
  set remaining(buf) { this.#state.accumulated = buf; }
  get processedBytes() { return this.#state.processedBytes; }
  get writeBytes() { return this.#state.writeBytes; }
  get expectedDataHash() { return this.#state.expectedDataHash && new Uint8Array(this.#state.expectedDataHash); }
  get runningDataHash() { return new Uint8Array(this.#state.runningDataHash); }
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
