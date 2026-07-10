import { Readable } from 'stream';
import fs from 'fs';
import { keccak_256 as keccak256 } from '@noble/hashes/sha3';

import {
  HeaderSize,
  BlockInfoSize,
  BlockNumLimit,
  MagicNum,
  CurrentBlockFileVersion
} from '../common/limits.js';
import { buffer2header_t } from '../common/header_util.js';
import { MetaEncryptorError } from '../common/errors.js';

const ITEMS_PER_BLOCK = 256;

function assertSafeNonNegative(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MetaEncryptorError('ERR_INVALID_FORMAT', { detail: { field, value } });
  }
}

async function readExactly(handle, buffer, offset, length, position, errorCode = 'ERR_UNEXPECTED_EOF') {
  let total = 0;
  while (total < length) {
    const { bytesRead } = await handle.read(buffer, offset + total, length - total, position + total);
    if (bytesRead === 0) {
      throw new MetaEncryptorError(errorCode, {
        detail: { expected: length, actual: total, position }
      });
    }
    total += bytesRead;
  }
}

function sameSource(expected, actual) {
  return expected &&
    expected.fileSize === actual.fileSize &&
    expected.headerFingerprint === actual.headerFingerprint &&
    expected.contentSize === actual.contentSize &&
    expected.itemNumber === actual.itemNumber &&
    expected.blockNumber === actual.blockNumber;
}

export class SealedFileStream extends Readable {
  constructor(filePath, options = {}) {
    const {
      start,
      end,
      expectedSource,
      resumeOffset,
      onMetadata,
      ...streamOptions
    } = options || {};
    super(streamOptions);
    this.filePath = filePath;
    this.start = start ?? 0;
    this.end = end;
    this.expectedSource = expectedSource;
    this.resumeOffset = resumeOffset ?? this.start;
    this.onMetadata = onMetadata;
    this.headerOffset = 0;
    this.readPosition = 0;
    this.isHeaderSent = false;
    this.initialized = false;
    this.readInFlight = false;
    this.contentSize = 0;
    this.streamSize = 0;
  }

  async _scanItems(header) {
    const lengthBuffer = Buffer.allocUnsafe(8);
    let offset = 0;
    let resumeOnBoundary = this.resumeOffset === 0;

    for (let index = 0; index < header.item_number; index += 1) {
      if (offset + 8 > this.contentSize) {
        throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
          detail: { field: 'itemLength', itemIndex: index, offset }
        });
      }
      await readExactly(this.fileHandle, lengthBuffer, 0, 8, offset);
      const itemLengthBig = lengthBuffer.readBigUInt64LE(0);
      if (itemLengthBig > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
          detail: { field: 'itemLength', itemIndex: index }
        });
      }
      const itemLength = Number(itemLengthBig);
      const nextOffset = offset + 8 + itemLength;
      if (!Number.isSafeInteger(nextOffset) || itemLength === 0 || nextOffset > this.contentSize) {
        throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
          detail: { field: 'itemLength', itemIndex: index, itemLength, remaining: this.contentSize - offset - 8 }
        });
      }
      offset = nextOffset;
      if (offset === this.resumeOffset) resumeOnBoundary = true;
    }

    if (offset !== this.contentSize) {
      throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
        detail: { field: 'contentSize', expected: offset, actual: this.contentSize }
      });
    }
    if (!resumeOnBoundary) {
      throw new MetaEncryptorError('ERR_CHECKPOINT_INVALID', {
        detail: { field: 'readStart', value: this.resumeOffset }
      });
    }
  }

  async _construct(callback) {
    try {
      this.fileHandle = await fs.promises.open(this.filePath, 'r');
      const fileStats = await this.fileHandle.stat();
      if (fileStats.size < HeaderSize) {
        throw new MetaEncryptorError('ERR_FILE_TOO_SMALL_HEADER');
      }

      this.header = Buffer.allocUnsafe(HeaderSize);
      await readExactly(
        this.fileHandle,
        this.header,
        0,
        HeaderSize,
        fileStats.size - HeaderSize,
        'ERR_FILE_TOO_SMALL_HEADER'
      );
      const header = buffer2header_t(this.header);
      assertSafeNonNegative(header.version_number, 'versionNumber');
      assertSafeNonNegative(header.block_number, 'blockNumber');
      assertSafeNonNegative(header.item_number, 'itemNumber');

      if (header.version_number !== CurrentBlockFileVersion) {
        throw new MetaEncryptorError('ERR_VERSION_MISMATCH', {
          detail: { expected: CurrentBlockFileVersion, actual: header.version_number }
        });
      }
      if (!header.magic_number.equals(MagicNum)) {
        throw new MetaEncryptorError('ERR_INVALID_MAGIC');
      }
      if (header.block_number > BlockNumLimit) {
        throw new MetaEncryptorError('ERR_INVALID_FORMAT', { detail: { field: 'blockNumber' } });
      }

      const expectedBlockNumber = header.item_number === 0
        ? 0
        : Math.ceil(header.item_number / ITEMS_PER_BLOCK);
      if (header.block_number !== expectedBlockNumber) {
        throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
          detail: { field: 'blockNumber', expected: expectedBlockNumber, actual: header.block_number }
        });
      }

      const metadataSize = HeaderSize + BlockInfoSize * header.block_number;
      if (!Number.isSafeInteger(metadataSize) || metadataSize > fileStats.size) {
        throw new MetaEncryptorError('ERR_INVALID_FILE_SIZE');
      }
      this.contentSize = fileStats.size - metadataSize;
      if (header.item_number === 0 && this.contentSize !== 0) {
        throw new MetaEncryptorError('ERR_INVALID_FORMAT', { detail: { field: 'emptyContent' } });
      }
      if (header.item_number > 0 && this.contentSize === 0) {
        throw new MetaEncryptorError('ERR_INVALID_FORMAT', { detail: { field: 'contentSize' } });
      }

      assertSafeNonNegative(this.start, 'start');
      if (this.end === undefined) this.end = this.contentSize;
      assertSafeNonNegative(this.end, 'end');
      if (this.start > this.end || this.end > this.contentSize) {
        throw new MetaEncryptorError('ERR_INVALID_FORMAT', {
          detail: { field: 'range', start: this.start, end: this.end, contentSize: this.contentSize }
        });
      }
      assertSafeNonNegative(this.resumeOffset, 'resumeOffset');
      if (this.resumeOffset > this.contentSize) {
        throw new MetaEncryptorError('ERR_CHECKPOINT_INVALID', {
          detail: { field: 'readStart', value: this.resumeOffset }
        });
      }

      await this._scanItems(header);

      const metadata = {
        fileSize: fileStats.size,
        contentSize: this.contentSize,
        itemNumber: header.item_number,
        blockNumber: header.block_number,
        headerFingerprint: Buffer.from(keccak256(this.header)).toString('hex')
      };
      if (this.expectedSource && !sameSource(this.expectedSource, metadata)) {
        throw new MetaEncryptorError('ERR_SOURCE_CHANGED', {
          detail: { expected: this.expectedSource, actual: metadata }
        });
      }
      if (this.onMetadata) await this.onMetadata(metadata, header);

      this.readPosition = this.start;
      this.streamSize = HeaderSize + this.end - this.start;
      this.initialized = true;
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _read(size) {
    if (!this.initialized || this.readInFlight) return;

    if (!this.isHeaderSent) {
      const remainingHeader = HeaderSize - this.headerOffset;
      const take = Math.min(Math.max(size, 1), remainingHeader);
      const chunk = this.header.subarray(this.headerOffset, this.headerOffset + take);
      this.headerOffset += take;
      if (this.headerOffset === HeaderSize) this.isHeaderSent = true;
      this.push(chunk);
      if (this.isHeaderSent && this.readPosition === this.end) this.push(null);
      return;
    }

    if (this.readPosition >= this.end) {
      this.push(null);
      return;
    }

    const toRead = Math.min(Math.max(size, 1), this.end - this.readPosition);
    const buffer = Buffer.allocUnsafe(toRead);
    this.readInFlight = true;
    this.fileHandle.read(buffer, 0, toRead, this.readPosition)
      .then(({ bytesRead }) => {
        this.readInFlight = false;
        if (bytesRead === 0) {
          this.destroy(new MetaEncryptorError('ERR_UNEXPECTED_EOF'));
          return;
        }
        this.readPosition += bytesRead;
        this.push(buffer.subarray(0, bytesRead));
        if (this.readPosition === this.end) this.push(null);
      })
      .catch((error) => {
        this.readInFlight = false;
        this.destroy(error);
      });
  }

  _destroy(error, callback) {
    if (!this.fileHandle) {
      callback(error);
      return;
    }
    const handle = this.fileHandle;
    this.fileHandle = null;
    handle.close().then(
      () => callback(error),
      (closeError) => callback(error || closeError)
    );
  }
}
