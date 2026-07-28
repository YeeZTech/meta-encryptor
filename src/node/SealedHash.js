/**
 * 密封文件滚动哈希（与订单侧 encryptFileHash 口径一致）：
 *
 *   hash_0 = keccak256("Fidelius")
 *   hash_i = keccak256(hash_{i-1} ‖ item_i)
 *
 * calculateSealedHash 为同步实现，整段扫盘期间独占当前线程（1.7GB 实测约 2 分钟，
 * 期间事件循环完全停摆），只适合小文件或 CLI / worker 场景。
 * UI 进程请用 calculateSealedHashAsync：按字节配额让出事件循环，并提供进度、
 * AbortSignal 取消与可持久化断点，中断后不必重扫整个文件。
 *
 * keccak 原语见 ./keccak256.js：默认原生（约 350MB/s），装不上时回退纯 JS
 * （约 20~40MB/s，GB 级文件耗时以分钟计）；也可用 hashProvider 自带实现。
 */

import fs from 'fs';
import { createRollingHasher, resolveKeccak256 } from './keccak256.js';
import { readUint64LE } from '../common/header_util.js';
import { MetaEncryptorError } from '../common/errors.js';
import { HeaderSize, MaxItemSize } from '../common/limits.js';
import log from 'loglevel';

const logger = log.getLogger('meta-encryptor/SealedHash');

/** 每个 item 前的长度前缀（uint64 LE） */
const ITEM_HEADER_SIZE = 8;
/** 断点结构版本；结构变更后旧断点会被忽略并从头重算 */
const CHECKPOINT_VERSION = 1;
const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;
/** 每扫过这么多字节让出一次事件循环：越小越流畅，代价是 setImmediate 次数变多 */
const DEFAULT_YIELD_BYTES = 1024 * 1024;
const INITIAL_ITEM_BUFFER_SIZE = MaxItemSize + 4096;

function tailInfo(headerBuffer, fileSize) {
  return {
    fileSize,
    dataSize: fileSize - HeaderSize,
    itemCount: readUint64LE(headerBuffer, 24).toNumber(),
  };
}

function readSealedTailSync(filePath) {
  const fileSize = fs.statSync(filePath).size;
  if (fileSize < HeaderSize) {
    throw new MetaEncryptorError('ERR_FILE_TOO_SMALL', {
      detail: { size: fileSize, required: HeaderSize },
    });
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(HeaderSize);
    const bytesRead = fs.readSync(fd, buffer, 0, HeaderSize, fileSize - HeaderSize);
    if (bytesRead !== HeaderSize) {
      throw new MetaEncryptorError('ERR_HEADER_INCOMPLETE', {
        detail: { expected: HeaderSize, actual: bytesRead },
      });
    }
    return tailInfo(buffer, fileSize);
  } finally {
    fs.closeSync(fd);
  }
}

async function readSealedTailAsync(fileHandle) {
  const fileSize = (await fileHandle.stat()).size;
  if (fileSize < HeaderSize) {
    throw new MetaEncryptorError('ERR_FILE_TOO_SMALL', {
      detail: { size: fileSize, required: HeaderSize },
    });
  }
  const buffer = Buffer.alloc(HeaderSize);
  const { bytesRead } = await fileHandle.read(
    buffer,
    0,
    HeaderSize,
    fileSize - HeaderSize
  );
  if (bytesRead !== HeaderSize) {
    throw new MetaEncryptorError('ERR_HEADER_INCOMPLETE', {
      detail: { expected: HeaderSize, actual: bytesRead },
    });
  }
  return tailInfo(buffer, fileSize);
}

function requireBytes(offset, length, dataSize) {
  if (length < 0 || offset + length > dataSize) {
    throw new MetaEncryptorError('ERR_UNEXPECTED_EOF', {
      detail: { offset, length, limit: dataSize },
    });
  }
}

function readExactlySync(fd, buffer, length, position) {
  let filled = 0;
  while (filled < length) {
    const bytesRead = fs.readSync(fd, buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  if (filled !== length) {
    throw new MetaEncryptorError('ERR_UNEXPECTED_EOF', {
      detail: { position, expected: length, actual: filled },
    });
  }
}

/**
 * 顺序扫盘用的滑动窗口：一次读入若干 MB 再在内存里切 item，
 * 把「每 item 两次 read」降到「每窗口一次 read」。
 */
class ChunkReader {
  constructor(fileHandle, limit, chunkSize) {
    this.fileHandle = fileHandle;
    this.limit = limit;
    this.buffer = Buffer.allocUnsafe(Math.max(chunkSize, INITIAL_ITEM_BUFFER_SIZE));
    this.start = 0;
    this.length = 0;
  }

  /** 返回的视图在下一次 read() 之前有效 */
  async read(position, length) {
    if (length === 0) return this.buffer.subarray(0, 0);

    const cached = position - this.start;
    if (cached >= 0 && cached + length <= this.length) {
      return this.buffer.subarray(cached, cached + length);
    }

    if (length > this.buffer.length) {
      // 单个 item 大于窗口：单独读一块，不污染窗口缓存
      const standalone = Buffer.allocUnsafe(length);
      await this._fill(standalone, position, length, length);
      this.length = 0;
      return standalone;
    }

    const want = Math.min(this.buffer.length, this.limit - position);
    if (want < length) {
      throw new MetaEncryptorError('ERR_UNEXPECTED_EOF', {
        detail: { position, expected: length, available: Math.max(want, 0) },
      });
    }
    this.length = await this._fill(this.buffer, position, want, length);
    this.start = position;
    return this.buffer.subarray(0, length);
  }

  async _fill(buffer, position, want, minimum) {
    let filled = 0;
    while (filled < want) {
      const { bytesRead } = await this.fileHandle.read(
        buffer,
        filled,
        want - filled,
        position + filled
      );
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled < minimum) {
      throw new MetaEncryptorError('ERR_UNEXPECTED_EOF', {
        detail: { position, expected: minimum, actual: filled },
      });
    }
    return filled;
  }
}

function makeCheckpoint(fileSize, itemCount, itemIndex, offset, hash) {
  return {
    version: CHECKPOINT_VERSION,
    fileSize,
    itemCount,
    itemIndex,
    offset,
    hash: hash.toString('hex'),
  };
}

/**
 * 断点只对同一份文件内容有效，用 fileSize + itemCount 做绑定校验；
 * 对不上就当没有断点从头重算 —— 宁可多扫一遍，不能给出错的哈希。
 */
function resolveCheckpoint(checkpoint, fileSize, itemCount, dataSize) {
  const fresh = { itemIndex: 0, offset: 0, hash: null };
  if (!checkpoint) return fresh;

  const usable =
    checkpoint.version === CHECKPOINT_VERSION &&
    checkpoint.fileSize === fileSize &&
    checkpoint.itemCount === itemCount &&
    Number.isInteger(checkpoint.itemIndex) &&
    checkpoint.itemIndex >= 0 &&
    checkpoint.itemIndex <= itemCount &&
    Number.isInteger(checkpoint.offset) &&
    checkpoint.offset >= 0 &&
    checkpoint.offset <= dataSize &&
    typeof checkpoint.hash === 'string' &&
    /^[0-9a-f]{64}$/i.test(checkpoint.hash);

  if (!usable) {
    logger.warn('calculateSealedHashAsync: checkpoint unusable, restart from 0', {
      checkpoint,
      fileSize,
      itemCount,
    });
    return fresh;
  }
  return {
    itemIndex: checkpoint.itemIndex,
    offset: checkpoint.offset,
    hash: Buffer.from(checkpoint.hash, 'hex'),
  };
}

function abortedError(signal, checkpoint) {
  const reason = signal && signal.reason;
  return new MetaEncryptorError('ERR_SEALED_HASH_ABORTED', {
    detail: { checkpoint },
    cause: reason instanceof Error ? reason : undefined,
  });
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function runCallback(fn, payload, name) {
  if (typeof fn !== 'function') return;
  try {
    fn(payload);
  } catch (e) {
    // 回调是调用方的事（写库、推 UI），不该让整段扫描前功尽弃
    logger.warn(`calculateSealedHashAsync: ${name} callback threw`, e);
  }
}

/**
 * 同步计算密封文件哈希。扫盘期间独占线程，UI 进程慎用。
 *
 * @param {string} filePath
 * @param {Object} [options]
 * @param {{ keccak256: (data: Uint8Array) => Uint8Array }} [options.hashProvider]
 *   自带 keccak 实现；省略则用默认选择（原生优先，见 ./keccak256.js）。
 * @returns {string} 十六进制哈希
 */
export function calculateSealedHash(filePath, options = {}) {
  const { fileSize, dataSize, itemCount } = readSealedTailSync(filePath);
  logger.debug('calculateSealedHash: start', { filePath, fileSize, itemCount });

  const fd = fs.openSync(filePath, 'r');
  try {
    const hasher = createRollingHasher(resolveKeccak256(options.hashProvider));
    let offset = 0;
    const lengthBuffer = Buffer.allocUnsafe(ITEM_HEADER_SIZE);
    let itemBuffer = Buffer.allocUnsafe(INITIAL_ITEM_BUFFER_SIZE);

    for (let i = 0; i < itemCount; i++) {
      requireBytes(offset, ITEM_HEADER_SIZE, dataSize);
      readExactlySync(fd, lengthBuffer, ITEM_HEADER_SIZE, offset);
      const itemLength = readUint64LE(lengthBuffer, 0).toNumber();
      offset += ITEM_HEADER_SIZE;

      requireBytes(offset, itemLength, dataSize);
      if (itemBuffer.length < itemLength) {
        itemBuffer = Buffer.allocUnsafe(itemLength);
      }
      readExactlySync(fd, itemBuffer, itemLength, offset);
      hasher.update(itemBuffer.subarray(0, itemLength));
      offset += itemLength;
    }

    const result = hasher.value.toString('hex');
    logger.debug('calculateSealedHash: done', { filePath, itemCount, hash: result });
    return result;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 异步计算密封文件哈希：按字节配额让出事件循环，可上报进度、可取消、可续算。
 *
 * @param {string} filePath
 * @param {Object} [options]
 * @param {(p: { bytesRead: number, totalBytes: number, itemIndex: number, itemCount: number, progress: number }) => void} [options.onProgress]
 *   每让出一次事件循环上报一次，含开始与结束两次。totalBytes 取数据区大小，是上界 ——
 *   尾部有少量不属于任何 item 的字节，故 progress 终值可能略小于 1，判定完成请用 itemIndex === itemCount。
 * @param {(checkpoint: Object) => void} [options.onCheckpoint]
 *   与 onProgress 同频给出可 JSON 持久化的断点；进程被强杀后可用最后一次断点续算。
 * @param {AbortSignal} [options.signal]
 *   取消时抛 MetaEncryptorError('ERR_SEALED_HASH_ABORTED')，detail.checkpoint 为中断处断点。
 * @param {Object} [options.checkpoint] 续算入口；与当前文件不匹配时忽略并从头重算。
 * @param {{ keccak256: (data: Uint8Array) => Uint8Array }} [options.hashProvider]
 *   自带 keccak 实现；省略则用默认选择（原生优先，见 ./keccak256.js）。
 * @param {number} [options.chunkSize=4194304] 单次读盘窗口。
 * @param {number} [options.yieldEveryBytes=1048576] 每扫过多少字节让出一次事件循环。
 * @returns {Promise<string>} 十六进制哈希
 */
export async function calculateSealedHashAsync(filePath, options = {}) {
  const {
    onProgress,
    onCheckpoint,
    signal,
    checkpoint,
    hashProvider,
    chunkSize = DEFAULT_CHUNK_SIZE,
    yieldEveryBytes = DEFAULT_YIELD_BYTES,
  } = options;

  if (signal && signal.aborted) throw abortedError(signal, checkpoint || null);

  const fileHandle = await fs.promises.open(filePath, 'r');
  try {
    const { fileSize, dataSize, itemCount } = await readSealedTailAsync(fileHandle);
    const start = resolveCheckpoint(checkpoint, fileSize, itemCount, dataSize);
    const hasher = createRollingHasher(resolveKeccak256(hashProvider), start.hash);
    let { itemIndex, offset } = start;

    logger.debug('calculateSealedHashAsync: start', {
      filePath,
      fileSize,
      itemCount,
      resumeFromItem: itemIndex,
    });

    const report = () => {
      const snapshot = makeCheckpoint(fileSize, itemCount, itemIndex, offset, hasher.value);
      runCallback(
        onProgress,
        {
          bytesRead: offset,
          totalBytes: dataSize,
          itemIndex,
          itemCount,
          progress: dataSize > 0 ? Math.min(1, offset / dataSize) : 0,
        },
        'onProgress'
      );
      runCallback(onCheckpoint, snapshot, 'onCheckpoint');
      return snapshot;
    };

    let snapshot = report();
    const reader = new ChunkReader(fileHandle, dataSize, chunkSize);
    const yieldThreshold = Math.max(1, yieldEveryBytes);
    let sinceYield = 0;

    while (itemIndex < itemCount) {
      if (signal && signal.aborted) throw abortedError(signal, snapshot);

      requireBytes(offset, ITEM_HEADER_SIZE, dataSize);
      const lengthView = await reader.read(offset, ITEM_HEADER_SIZE);
      const itemLength = readUint64LE(lengthView, 0).toNumber();
      const itemOffset = offset + ITEM_HEADER_SIZE;

      requireBytes(itemOffset, itemLength, dataSize);
      const itemView = await reader.read(itemOffset, itemLength);
      hasher.update(itemView);
      offset = itemOffset + itemLength;
      itemIndex += 1;
      sinceYield += ITEM_HEADER_SIZE + itemLength;

      if (sinceYield >= yieldThreshold || itemIndex === itemCount) {
        sinceYield = 0;
        snapshot = report();
        await yieldToEventLoop();
      }
    }

    if (signal && signal.aborted) throw abortedError(signal, snapshot);

    const result = hasher.value.toString('hex');
    logger.debug('calculateSealedHashAsync: done', { filePath, itemCount, hash: result });
    return result;
  } finally {
    await fileHandle.close();
  }
}
