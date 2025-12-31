import fs from 'fs/promises';
import path from 'path';

// Use Node implementation of YPCCrypto
import YPCCryptoFun from '../src/ypccrypto.js';

function toHex(u){
  return Buffer.from(u instanceof Uint8Array ? u : new Uint8Array(u)).toString('hex');
}

function hexToBytes(hex){
  if (hex.startsWith('0x')) hex = hex.slice(2);
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

async function main(){
  const outDir = path.resolve('./test/fixtures');
  await fs.mkdir(outDir, { recursive: true });

  const nodeCrypto = YPCCryptoFun();

  // generate multiple fixtures
  const fixtures = [];
  for (let i=0;i<5;i++){
    const sKey = nodeCrypto.generatePrivateKey();
    const pKey = nodeCrypto.generatePublicKeyFromPrivateKey(sKey);
    const msg = `fixture-message-${i}-${Date.now()}`;

    const encrypted = await nodeCrypto._encryptMessage(pKey, sKey, Buffer.from(msg, 'utf8'), 0x2);
    const signature = nodeCrypto.signMessage(sKey, Buffer.from(msg, 'utf8'));

    fixtures.push({
      sKey: toHex(sKey),
      pKey: toHex(pKey),
      message: msg,
      encrypted: toHex(encrypted),
      signature: toHex(signature)
    });
  }

  const outPath = path.join(outDir, 'ypc-browser-fixtures.json');
  await fs.writeFile(outPath, JSON.stringify(fixtures, null, 2), 'utf8');
  console.log('Wrote', fixtures.length, 'fixtures to', outPath);
}

main().catch(err=>{ console.error(err); process.exit(1); });
