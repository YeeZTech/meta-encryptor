import {Buffer} from 'buffer';
const BlockNumLimit = 1024 * 1024;
const ItemsPerBlockLimit = 256;
// Historical public batching threshold.  Older producers interpreted this as
// plaintext/package payload, so their encrypted item can be slightly larger.
const MaxItemSize = 64 * 1024;
// Consumer hard cap for encrypted items.  The v2 format historically allowed
// Sealer callers to pass a whole Transform chunk as one item, so valid files
// in the wild can be substantially larger than the 64 KiB batching target.
// Keep a bounded legacy window instead of treating the batching target as a
// format limit; hostile length fields still cannot make consumers buffer an
// unbounded item.
const MaxSealedItemSize = 64 * 1024 * 1024;
const CryptoEnvelopeSize = 64 + 16 + 12;
const NtPackageHeaderSize = 4 + 8;
const NtPackageItemHeaderSize = 8;
const NtInputHeaderSize = 4 + 8;
const MaxPlaintextChunkSize = MaxItemSize
  - CryptoEnvelopeSize
  - NtPackageHeaderSize
  - NtPackageItemHeaderSize
  - NtInputHeaderSize;
const MaxItemNumber = BlockNumLimit * ItemsPerBlockLimit;
const HeaderSize = 64;
const BlockInfoSize = 32;
const CurrentBlockFileVersion = 2;
const MagicNum = Buffer.from("1fe2ef7f3ed18847", "hex");

export {
  BlockNumLimit,
  ItemsPerBlockLimit,
  BlockInfoSize,
  MaxItemSize,
  MaxSealedItemSize,
  CryptoEnvelopeSize,
  NtPackageHeaderSize,
  NtPackageItemHeaderSize,
  NtInputHeaderSize,
  MaxPlaintextChunkSize,
  MaxItemNumber,
  HeaderSize,
  MagicNum,
  CurrentBlockFileVersion,
}
