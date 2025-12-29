const BlockNumLimit = 1024 * 1024;
const MaxItemSize = 64 * 1024;
const HeaderSize = 64;
const BlockInfoSize = 32;
const CurrentBlockFileVersion = 2;
function hexToBytes(hex) {
  const clean = hex.replace(/^0x/i, "");
  if (clean.length % 2 !== 0) throw new Error("invalid hex length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
const MagicNum = hexToBytes("1fe2ef7f3ed18847");

export {
  BlockNumLimit,
  BlockInfoSize,
  MaxItemSize,
  HeaderSize,
  MagicNum,
  CurrentBlockFileVersion,
}
