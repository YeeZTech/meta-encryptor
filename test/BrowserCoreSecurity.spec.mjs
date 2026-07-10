import { BrowserCrypto } from '../src/browser/ypccrypto.browser.js';
import { Unsealer } from '../src/browser/Unsealer.js';

const privateKey = Uint8Array.from(
  Buffer.from('60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8', 'hex')
);
const publicKey = Uint8Array.from(
  Buffer.from('731234931a081e9beae856318a9bf32ac3698ea8215bf74f517f8377cc6ba8740e28ed87c97d0ee8775bc83505867b0bc34a66adc91f0ea9b44c80533f1a3dca', 'hex')
);

describe('BrowserCrypto binary view boundaries', () => {
  test.each([
    ['Uint8Array', () => new Uint8Array(Uint8Array.from([9, 1, 2, 3, 9]).buffer, 1, 3)],
    ['DataView', () => new DataView(Uint8Array.from([9, 4, 5, 6, 9]).buffer, 1, 3)],
    ['ArrayBuffer', () => Uint8Array.from([7, 8, 9]).buffer],
    ['legacy wrapper', () => ({ buffer: new Uint8Array([10, 11, 12]) })],
  ])('encrypts only the selected %s bytes', async (_, makeInput) => {
    const input = makeInput();
    const expected = input?.buffer && !ArrayBuffer.isView(input) && !(input instanceof ArrayBuffer)
      ? new Uint8Array(input.buffer.buffer, input.buffer.byteOffset, input.buffer.byteLength)
      : new Uint8Array(
        input instanceof ArrayBuffer ? input : input.buffer,
        input.byteOffset || 0,
        input.byteLength
      );
    const encrypted = await BrowserCrypto.generateEncryptedInput(publicKey, input);
    const plain = await BrowserCrypto.decryptMessage(privateKey, encrypted);
    expect(Array.from(plain)).toEqual(Array.from(expected));
  });

  test('strictly rejects malformed hex keys', async () => {
    await expect(BrowserCrypto.decryptMessage('0x1', new Uint8Array(92))).rejects.toMatchObject({
      code: 'ERR_INVALID_HEX',
    });
  });

  test('passes the historical-item cap override to the shared unsealer core', () => {
    expect(() => new Unsealer({
      privateKeyHex: Buffer.from(privateKey).toString('hex'),
      maxSealedItemSize: 0,
    })).toThrow(expect.objectContaining({ code: 'ERR_INVALID_FORMAT' }));
  });
});
