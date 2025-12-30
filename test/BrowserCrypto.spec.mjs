// BrowserCrypto comprehensive test - compare with Node YPCCrypto for consistency
import { webcrypto} from 'crypto';
globalThis.crypto = webcrypto;


import { BrowserCrypto } from '../src/browser/ypccrypto.browser.js';

describe('BrowserCrypto compatibility with Node YPCCrypto', () => {
  let browserCrypto;

  beforeEach(() => {
    browserCrypto = BrowserCrypto;
  });

  describe('Key Generation', () => {
    test('generatePrivateKey should generate valid 32-byte private key', () => {
      const browserKey = browserCrypto.generatePrivateKey();

      expect(browserKey instanceof Uint8Array).toBe(true);
      expect(browserKey.length).toBe(32);
    });

    test('generatePublicKeyFromPrivateKey should produce consistent results', () => {
      // Use fixed test private key for deterministic results
      const testPrivateKey = Buffer.from('60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8', 'hex');
      
      const browserPublicKey = browserCrypto.generatePublicKeyFromPrivateKey(testPrivateKey);

      expect(browserPublicKey instanceof Uint8Array).toBe(true);
      expect(browserPublicKey.length).toBe(64);
    });

    test('generatePublicKeyFromPrivateKey with random keys should match', () => {
      const key1 = browserCrypto.generatePrivateKey();
      const key2 = browserCrypto.generatePrivateKey();

      const pub1 = browserCrypto.generatePublicKeyFromPrivateKey(key1);
      const pub1Again = browserCrypto.generatePublicKeyFromPrivateKey(key1);
      expect(Buffer.from(pub1).toString('hex')).toBe(Buffer.from(pub1Again).toString('hex'));

      const pub2 = browserCrypto.generatePublicKeyFromPrivateKey(key2);
      expect(Buffer.from(pub2).toString('hex')).not.toBe(Buffer.from(pub1).toString('hex'));
    });
  });

  describe('AES Key Generation', () => {
    test('generateAESKeyFrom should produce same AES key for same inputs', async () => {
      const testPrivateKey = Buffer.from('60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8', 'hex');
      const testPublicKey = Buffer.from('731234931a081e9beae856318a9bf32ac3698ea8215bf74f517f8377cc6ba8740e28ed87c97d0ee8775bc83505867b0bc34a66adc91f0ea9b44c80533f1a3dca', 'hex');
      
      const browserAESKey = await browserCrypto.generateAESKeyFrom(testPublicKey, testPrivateKey);

      expect(browserAESKey instanceof Uint8Array).toBe(true);
      expect(browserAESKey.length).toBe(16);

      const browserAESKey2 = await browserCrypto.generateAESKeyFrom(testPublicKey, testPrivateKey);
      expect(Buffer.from(browserAESKey).toString('hex')).toBe(Buffer.from(browserAESKey2).toString('hex'));
    });

    test('generateAESKeyFrom should work with random key pairs', async () => {
      const key = browserCrypto.generatePrivateKey();
      const pkey = browserCrypto.generatePublicKeyFromPrivateKey(key);

      const aes1 = await browserCrypto.generateAESKeyFrom(pkey, key);
      const aes2 = await browserCrypto.generateAESKeyFrom(pkey, key);
      expect(Buffer.from(aes1).toString('hex')).toBe(Buffer.from(aes2).toString('hex'));
    });
  });

  describe('Encryption and Decryption', () => {
    test('_encryptMessage should produce decryptable ciphertext', async () => {
      const testPrivateKey = Buffer.from('60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8', 'hex');
      const testPublicKey = Buffer.from('731234931a081e9beae856318a9bf32ac3698ea8215bf74f517f8377cc6ba8740e28ed87c97d0ee8775bc83505867b0bc34a66adc91f0ea9b44c80533f1a3dca', 'hex');
      const testMessage = Buffer.from('hello world', 'utf8');
      const prefix = 0x2;

      // Generate one-time secret for encryption
      const ots = browserCrypto.generatePrivateKey();
      const encrypted = await browserCrypto._encryptMessage(testPublicKey, ots, testMessage, prefix);

      expect(encrypted instanceof Uint8Array).toBe(true);

      const decrypted = await browserCrypto.decryptMessage(testPrivateKey, encrypted);
      expect(Buffer.from(decrypted).toString('utf8')).toBe(testMessage.toString('utf8'));
    });

    test('decryptMessage should decrypt messages encrypted by Node version', async () => {
      const testPrivateKey = Buffer.from('60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8', 'hex');
      const testPublicKey = Buffer.from('731234931a081e9beae856318a9bf32ac3698ea8215bf74f517f8377cc6ba8740e28ed87c97d0ee8775bc83505867b0bc34a66adc91f0ea9b44c80533f1a3dca', 'hex');
      const testMessage = Buffer.from('test message for decryption', 'utf8');

      // Encrypt with Node version
      const ots = browserCrypto.generatePrivateKey();
      const encrypted = await browserCrypto._encryptMessage(testPublicKey, ots, testMessage, 0x2);
      const browserDecrypted = await browserCrypto.decryptMessage(testPrivateKey, encrypted);
      expect(Buffer.from(browserDecrypted).toString('utf8')).toBe(testMessage.toString('utf8'));
    });

    test('decryptMessage should decrypt messages encrypted by Browser version', async () => {
      const testPrivateKey = Buffer.from('60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8', 'hex');
      const testPublicKey = Buffer.from('731234931a081e9beae856318a9bf32ac3698ea8215bf74f517f8377cc6ba8740e28ed87c97d0ee8775bc83505867b0bc34a66adc91f0ea9b44c80533f1a3dca', 'hex');
      const testMessage = Buffer.from('test message for browser encryption', 'utf8');

      // Encrypt with Browser version
      const browserOTS = browserCrypto.generatePrivateKey();
      const browserEncrypted = await browserCrypto._encryptMessage(testPublicKey, browserOTS, testMessage, 0x2);
      const nodeDecrypted = await browserCrypto.decryptMessage(testPrivateKey, browserEncrypted);
      expect(Buffer.from(nodeDecrypted).toString('utf8')).toBe(testMessage.toString('utf8'));
    });

    test('_decryptMessageWithPrefix should work with different prefixes', async () => {
      const testPrivateKey = Buffer.from('60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8', 'hex');
      const testPublicKey = Buffer.from('731234931a081e9beae856318a9bf32ac3698ea8215bf74f517f8377cc6ba8740e28ed87c97d0ee8775bc83505867b0bc34a66adc91f0ea9b44c80533f1a3dca', 'hex');
      const testMessage = Buffer.from('test with prefix 0x1', 'utf8');

      // Test prefix 0x1 (forward message)
      const ots = browserCrypto.generatePrivateKey();
      const enc1 = await browserCrypto._encryptMessage(testPublicKey, ots, testMessage, 0x1);
      const browserDecrypted = await browserCrypto._decryptMessageWithPrefix(testPrivateKey, enc1, 0x1);
      expect(Buffer.from(browserDecrypted).toString('utf8')).toBe(testMessage.toString('utf8'));

      const enc2 = await browserCrypto._encryptMessage(testPublicKey, ots, testMessage, 0x2);
      const browserDecrypted2 = await browserCrypto._decryptMessageWithPrefix(testPrivateKey, enc2, 0x2);
      expect(Buffer.from(browserDecrypted2).toString('utf8')).toBe(testMessage.toString('utf8'));
    });

    test('decryptForwardMessage should decrypt forward messages', async () => {
      const testPrivateKey = Buffer.from('60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8', 'hex');
      const testPublicKey = Buffer.from('731234931a081e9beae856318a9bf32ac3698ea8215bf74f517f8377cc6ba8740e28ed87c97d0ee8775bc83505867b0bc34a66adc91f0ea9b44c80533f1a3dca', 'hex');
      const testMessage = Buffer.from('forward message', 'utf8');

      // Encrypt forward message with Node
      const ots = browserCrypto.generatePrivateKey();
      const enc = await browserCrypto._encryptMessage(testPublicKey, ots, testMessage, 0x1);
      const browserDecrypted = await browserCrypto.decryptForwardMessage(testPrivateKey, enc);
      expect(Buffer.from(browserDecrypted).toString('utf8')).toBe(testMessage.toString('utf8'));
    });
  });

  describe('Forward Secret Key Generation', () => {
    test('generateForwardSecretKey should produce decryptable result', async () => {
      const remotePKey = Buffer.from('731234931a081e9beae856318a9bf32ac3698ea8215bf74f517f8377cc6ba8740e28ed87c97d0ee8775bc83505867b0bc34a66adc91f0ea9b44c80533f1a3dca', 'hex');
      const localSKey = Buffer.from('60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8', 'hex');

      const browserForwardKey = await browserCrypto.generateForwardSecretKey(remotePKey, localSKey);
      expect(browserForwardKey instanceof Uint8Array).toBe(true);
      expect(browserForwardKey.length).toBeGreaterThan(64 + 16 + 12);
    });
  });

  describe('Encrypted Input Generation', () => {
    test('generateEncryptedInput should produce valid encrypted input', async () => {
      const localPKey = Buffer.from('731234931a081e9beae856318a9bf32ac3698ea8215bf74f517f8377cc6ba8740e28ed87c97d0ee8775bc83505867b0bc34a66adc91f0ea9b44c80533f1a3dca', 'hex');
      const testInput = { buffer: Buffer.from('test input data', 'utf8') };

      const browserEncrypted = await browserCrypto.generateEncryptedInput(localPKey, testInput);
      expect(browserEncrypted instanceof Uint8Array).toBe(true);
      expect(browserEncrypted.length).toBeGreaterThan(64 + 16 + 12);
    });
  });

  describe('File Name and Content Generation', () => {
    test('generateFileNameFromPKey should produce consistent results', () => {
      const testPKey = Buffer.from('731234931a081e9beae856318a9bf32ac3698ea8215bf74f517f8377cc6ba8740e28ed87c97d0ee8775bc83505867b0bc34a66adc91f0ea9b44c80533f1a3dca', 'hex');
      
      const browserFileName = browserCrypto.generateFileNameFromPKey(testPKey);
      expect(typeof browserFileName).toBe('string');
      expect(browserFileName).toMatch(/^[0-9a-f]{8}\.json$/);
    });

    test('generateFileContentFromSKey should produce consistent results', () => {
      const testSKey = Buffer.from('60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8', 'hex');
      
      const browserFileContent = browserCrypto.generateFileContentFromSKey(testSKey);
      expect(typeof browserFileContent).toBe('string');
      const browserObj = JSON.parse(browserFileContent);
      expect(browserObj.private_key).toBe(testSKey.toString('hex'));
    });
  });

  describe('Round-trip Encryption/Decryption', () => {
    test('Browser encrypt -> Browser decrypt should work', async () => {
      const testPrivateKey = browserCrypto.generatePrivateKey();
      const testPublicKey = browserCrypto.generatePublicKeyFromPrivateKey(testPrivateKey);
      const testMessage = new TextEncoder().encode('round trip test message');

      const browserOTS = browserCrypto.generatePrivateKey();
      const encrypted = await browserCrypto._encryptMessage(testPublicKey, browserOTS, testMessage, 0x2);
      const decrypted = await browserCrypto.decryptMessage(testPrivateKey, encrypted);

      expect(new TextDecoder().decode(decrypted)).toBe(new TextDecoder().decode(testMessage));
    });

    test('Browser encrypt -> Browser decrypt (buffer input) should work', async () => {
      const testPrivateKey = browserCrypto.generatePrivateKey();
      const testPublicKey = browserCrypto.generatePublicKeyFromPrivateKey(testPrivateKey);
      const testMessage = Buffer.from('browser to browser test', 'utf8');

      const browserOTS = browserCrypto.generatePrivateKey();
      const encrypted = await browserCrypto._encryptMessage(testPublicKey, browserOTS, testMessage, 0x2);
      const decrypted = await browserCrypto.decryptMessage(testPrivateKey, encrypted);

      expect(Buffer.from(decrypted).toString('utf8')).toBe(testMessage.toString('utf8'));
    });

    test('Browser encrypt -> Browser decrypt (Uint8Array message) should work', async () => {
      const testPrivateKey = browserCrypto.generatePrivateKey();
      const testPublicKey = browserCrypto.generatePublicKeyFromPrivateKey(testPrivateKey);
      const testMessage = new TextEncoder().encode('node to browser test');

      const nodeOTS = browserCrypto.generatePrivateKey();
      const encrypted = await browserCrypto._encryptMessage(testPublicKey, nodeOTS, testMessage, 0x2);
      const decrypted = await browserCrypto.decryptMessage(testPrivateKey, encrypted);
      expect(new TextDecoder().decode(decrypted)).toBe(new TextDecoder().decode(testMessage));
    });
    test('signMessage should produce consistent signatures for same input', () => {
      const testPrivateKey = Buffer.from('60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8', 'hex');
      const testMessage = Buffer.from('test message for signing', 'utf8');

      const browserSignature = browserCrypto.signMessage(testPrivateKey, testMessage);
      expect(browserSignature instanceof Uint8Array).toBe(true);
      expect(browserSignature.length).toBe(65);
    });

    test('signMessage should produce consistent signatures with different message types', () => {
      const testPrivateKey = Buffer.from('60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8', 'hex');
      const testMessages = [
        Buffer.from('simple text', 'utf8'),
        Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd]),
        Buffer.alloc(32, 0x42), // 32 bytes of 0x42
      ];

      for (const testMessage of testMessages) {
        const browserSignature = browserCrypto.signMessage(testPrivateKey, testMessage);
        expect(Buffer.from(browserSignature).toString('hex')).toBe(Buffer.from(browserSignature).toString('hex'));
      }
    });

    test('generateSignature should produce consistent signatures', () => {
      const testPrivateKey = Buffer.from('60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8', 'hex');
      const testEPKey = Buffer.from('731234931a081e9beae856318a9bf32ac3698ea8215bf74f517f8377cc6ba874', 'hex');
      const testEHash = Buffer.alloc(32, 0xaa); // 32 bytes of 0xaa

      const browserSignature = browserCrypto.generateSignature(testPrivateKey, testEPKey, testEHash);
      expect(browserSignature instanceof Uint8Array).toBe(true);
      expect(browserSignature.length).toBe(65);
    });

    test('signMessage with random keys should produce consistent signatures', () => {
      const keyA = browserCrypto.generatePrivateKey();
      const keyB = browserCrypto.generatePrivateKey();
      const testMessage = Buffer.from('random key test', 'utf8');

      const sig1 = browserCrypto.signMessage(keyA, testMessage);
      const sig1b = browserCrypto.signMessage(keyA, testMessage);
      expect(Buffer.from(sig1).toString('hex')).toBe(Buffer.from(sig1b).toString('hex'));

      const sig2 = browserCrypto.signMessage(keyB, testMessage);
      expect(Buffer.from(sig2).toString('hex')).not.toBe(Buffer.from(sig1).toString('hex'));
    });
  });
});
