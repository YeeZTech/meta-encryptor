import fs from "fs";
import crypto from "crypto";
import { Readable } from "stream";
import { Sealer } from "../src/node/Sealer";
import { Unsealer } from "../src/node/Unsealer";
import { SealedFileStream } from "../src/node/SealedFileStream";
import { buffer2header_t } from "../src/common/header_util.js";
import { HeaderSize, MaxItemSize } from "../src/common/limits.js";
import YPCCryptoFun from "../src/node/ypccrypto.js";
import { key_pair, testPath } from "./helper";

const YPCCrypto = YPCCryptoFun();
const privateKey = Buffer.from(key_pair.private_key, "hex");

// item 布局：encrypted ‖ iv(12) ‖ pubkey(64) ‖ tag(16)
const ivOf = (item) => item.subarray(item.length - 92, item.length - 80);
const pubkeyOf = (item) => item.subarray(item.length - 80, item.length - 16);

function makeChunks(count) {
  const chunks = [];
  for (let i = 0; i < count; i++) chunks.push(crypto.randomBytes(MaxItemSize));
  chunks.push(crypto.randomBytes(1234));
  return chunks;
}

async function sealChunks(chunks) {
  const out = [];
  await new Promise((resolve, reject) => {
    Readable.from(chunks)
      .pipe(new Sealer({ keyPair: key_pair }))
      .on("data", (c) => out.push(c))
      .on("end", resolve)
      .on("error", reject);
  });
  return Buffer.concat(out);
}

function parseItems(sealed) {
  const header = buffer2header_t(sealed.subarray(sealed.length - HeaderSize));
  const items = [];
  let offset = 0;
  for (let i = 0; i < header.item_number; i++) {
    const len = Number(sealed.readBigUInt64LE(offset));
    items.push(sealed.subarray(offset + 8, offset + 8 + len));
    offset += 8 + len;
  }
  return items;
}

test("all items of one file share one ephemeral key and use sequential IVs", async () => {
  const items = parseItems(await sealChunks(makeChunks(5)));
  expect(items.length).toBeGreaterThanOrEqual(5);

  const pubkey = pubkeyOf(items[0]);
  const ivPrefix = ivOf(items[0]).subarray(0, 4);
  items.forEach((item, i) => {
    expect(pubkeyOf(item).equals(pubkey)).toBe(true);
    const iv = ivOf(item);
    expect(iv.subarray(0, 4).equals(ivPrefix)).toBe(true);
    expect(iv.readBigUInt64BE(4)).toBe(BigInt(i));
    // 解密端不变：每个 item 仍可用原有的逐 item 接口独立解密
    expect(() => YPCCrypto.decryptMessage(privateKey, item)).not.toThrow();
  });
});

test("different files get independent keys and IV prefixes", async () => {
  const chunks = makeChunks(2);
  const a = parseItems(await sealChunks(chunks));
  const b = parseItems(await sealChunks(chunks));

  expect(pubkeyOf(a[0]).equals(pubkeyOf(b[0]))).toBe(false);
  expect(ivOf(a[0]).subarray(0, 4).equals(ivOf(b[0]).subarray(0, 4))).toBe(false);
  expect(a[0].equals(b[0])).toBe(false);
});

test("sealed file round-trips through the existing Unsealer", async () => {
  const chunks = makeChunks(4);
  const dst = testPath("session-key.sealed");
  fs.writeFileSync(dst, await sealChunks(chunks));

  const out = [];
  await new Promise((resolve, reject) => {
    new SealedFileStream(dst)
      .pipe(new Unsealer({ keyPair: key_pair }))
      .on("data", (c) => out.push(c))
      .on("end", resolve)
      .on("error", reject);
  });
  expect(Buffer.concat(out).equals(Buffer.concat(chunks))).toBe(true);
  fs.unlinkSync(dst);
});
