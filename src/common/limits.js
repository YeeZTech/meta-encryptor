import {Buffer} from 'buffer';
const BlockNumLimit = 1024 * 1024;
const MaxItemSize = 64 * 1024;
const HeaderSize = 64;
const BlockInfoSize = 32;
const CurrentBlockFileVersion = 2;
const MagicNum = Buffer.from("1fe2ef7f3ed18847", "hex");

export {
  BlockNumLimit,
  BlockInfoSize,
  MaxItemSize,
  HeaderSize,
  MagicNum,
  CurrentBlockFileVersion,
}
