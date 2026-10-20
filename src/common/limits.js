import {Buffer} from 'buffer';
const BlockNumLimit = 1024 * 1024;
const MaxItemSize = 64 * 1024;
const HeaderSize = 64;
const BlockInfoSize = 32;
const CurrentBlockFileVersion = 2;
const MagicNum = Buffer.from("1fe2ef7f3ed18847", "hex");
/**
 * Node 流（Sealer / Unsealer / SealedFileStream / Recoverable*）的默认 highWaterMark。
 * 一个 item 的明文约 MaxItemSize（64KiB）。Node<=20（含 Electron 28）流默认 16KiB，
 * 会让每个 item 至少 4~5 次线程池往返、每次 push 都触发背压；对齐到 item 大小后
 * 往返降到 1~2 次。调用方仍可通过 options.highWaterMark 覆盖。
 */
const DefaultStreamHighWaterMark = MaxItemSize;

export {
  BlockNumLimit,
  BlockInfoSize,
  MaxItemSize,
  HeaderSize,
  MagicNum,
  CurrentBlockFileVersion,
  DefaultStreamHighWaterMark,
}
