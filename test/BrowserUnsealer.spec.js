import { webcrypto as nodeWebcrypto } from 'crypto';
globalThis.crypto = nodeWebcrypto;

import streams from 'memory-streams';
import Provider from '../src/DataProvider.js';
import { BlockInfoSize, HeaderSize } from '../src/limits.js';
import YPCCryptoFun from '../src/ypccrypto.js';
import { UnsealerBrowser } from '../src/browser/UnsealerBrowser.js';

const { DataProvider, headerAndBlockBufferFromBuffer } = Provider;

describe('Browser Unsealer compatibility', () => {
  it('should decrypt to original content (single chunk input)', async () => {
    const YPCCrypto = YPCCryptoFun();
    const sk = YPCCrypto.generatePrivateKey();
    const pk = YPCCrypto.generatePublicKeyFromPrivateKey(sk);
    const keyPair = { private_key: sk.toString('hex'), public_key: pk.toString('hex') };

    const dp = new DataProvider(keyPair);
    const ws = new streams.WritableStream();
    dp.sealData('hello world', ws, false);
    dp.sealData(null, ws, true);
    const diskBuf = ws.toBuffer();

    const hb = headerAndBlockBufferFromBuffer(diskBuf);
    expect(hb).toBeTruthy();
    const header = hb.header;
    const blockCount = (hb.block.length / BlockInfoSize) | 0;
    const contentSize = diskBuf.length - HeaderSize - BlockInfoSize * blockCount;
    const content = diskBuf.slice(0, contentSize);
    const streamBuf = Buffer.concat([header, content]);

    const un = new UnsealerBrowser({ privateKeyHex: keyPair.private_key });
    const chunks = [];
    // feed header and content in two parts to simulate streaming
    chunks.push(...(await un.pushChunk(streamBuf.slice(0, HeaderSize))));
    chunks.push(...(await un.pushChunk(streamBuf.slice(HeaderSize))));
    const merged = Buffer.concat(chunks.map(b=>Buffer.from(b)));
    expect(merged.toString('utf8')).toBe('hello world');
  }, 20000);

  it('should decrypt multiple inputs batched', async () => {
    const YPCCrypto = YPCCryptoFun();
    const sk = YPCCrypto.generatePrivateKey();
    const pk = YPCCrypto.generatePublicKeyFromPrivateKey(sk);
    const keyPair = { private_key: sk.toString('hex'), public_key: pk.toString('hex') };

    const dp = new DataProvider(keyPair);
    const ws = new streams.WritableStream();
    const inputs = ['alpha','beta','gamma'];
    for(const s of inputs){ dp.sealData(s, ws, false); }
    dp.sealData(null, ws, true);
    const diskBuf = ws.toBuffer();

    const hb = headerAndBlockBufferFromBuffer(diskBuf);
    const header = hb.header; const blockCount = (hb.block.length / BlockInfoSize)|0;
    const contentSize = diskBuf.length - HeaderSize - BlockInfoSize * blockCount;
    const content = diskBuf.slice(0, contentSize);
    const streamBuf = Buffer.concat([header, content]);

    const un = new UnsealerBrowser({ privateKeyHex: keyPair.private_key });
    const outputs = [];
    // feed random chunk sizes
    let offset = 0; const sizes = [13, 7, 1024, 5, 256];
    let idx=0; while(offset < streamBuf.length){
      const n = Math.min(streamBuf.length - offset, sizes[idx % sizes.length]);
      const part = streamBuf.slice(offset, offset+n);
      const outs = await un.pushChunk(part);
      outputs.push(...outs);
      offset+=n; idx++;
    }
    const merged = Buffer.concat(outputs.map(b=>Buffer.from(b)));
    expect(merged.toString('utf8')).toBe(inputs.join(''));
  }, 20000);
});
