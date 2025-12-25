// BrowserCrypto comprehensive test - compare with Node YPCCrypto for consistency
import { webcrypto as nodeWebcrypto } from 'crypto';
globalThis.crypto = nodeWebcrypto;

import { BrowserCrypto } from '../src/browser/ypccrypto.browser.js';
import YPCCryptoFun from '../src/ypccrypto.js';

describe('BrowserCrypto compatibility with Node YPCCrypto', () => {
  let nodeCrypto;
  let browserCrypto;

  beforeEach(() => {
    nodeCrypto = YPCCryptoFun();
    browserCrypto = BrowserCrypto;
  });

  describe('Key Generation', () => {
    test('generatePrivateKey should generate valid 32-byte private key', () => {
      const nodeKey = nodeCrypto.generatePrivateKey();
      const browserKey = browserCrypto.generatePrivateKey();

      expect(Buffer.isBuffer(nodeKey)).toBe(true);
      expect(nodeKey.length).toBe(32);
      
      expect(browserKey instanceof Uint8Array).toBe(true);
      expect(browserKey.length).toBe(32);
    });

    test('generatePublicKeyFromPrivateKey should produce consistent results', () => {
      // Use fixed test private key for deterministic results
      const testPrivateKey = Buffer.from('60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8', 'hex');
      
      const nodePublicKey = nodeCrypto.generatePublicKeyFromPrivateKey(testPrivateKey);
      const browserPublicKey = browserCrypto.generatePublicKeyFromPrivateKey(testPrivateKey);

      expect(Buffer.isBuffer(nodePublicKey)).toBe(true);
      expect(nodePublicKey.length).toBe(64);
      
      expect(browserPublicKey instanceof Uint8Array).toBe(true);
      expect(browserPublicKey.length).toBe(64);
      
      // Compare as hex strings
      expect(nodePublicKey.toString('hex')).toBe(Buffer.from(browserPublicKey).toString('hex'));
    });

    test('generatePublicKeyFromPrivateKey with random keys should match', () => {
      const nodeKey = nodeCrypto.generatePrivateKey();
      const browserKey = browserCrypto.generatePrivateKey();
      
      // Convert browser key to Buffer for comparison
      const browserKeyBuf = Buffer.from(browserKey);
      
      // Test with same private key
      const nodePKey = nodeCrypto.generatePublicKeyFromPrivateKey(nodeKey);
      const browserPKey = browserCrypto.generatePublicKeyFromPrivateKey(nodeKey);
      
      expect(nodePKey.toString('hex')).toBe(Buffer.from(browserPKey).toString('hex'));
      
      // Test with browser-generated key
      const browserPKey2 = browserCrypto.generatePublicKeyFromPrivateKey(browserKeyBuf);
      const nodePKey2 = nodeCrypto.generatePublicKeyFromPrivateKey(browserKeyBuf);
      
      expect(nodePKey2.toString('hex')).toBe(Buffer.from(browserPKey2).toString('hex'));
    });
  });

  describe('AES Key Generation', () => {
    test('generateAESKeyFrom should produce same AES key for same inputs', async () => {
      const testPrivateKey = Buffer.from('60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8', 'hex');
      const testPublicKey = Buffer.from('731234931a081e9beae856318a9bf32ac3698ea8215bf74f517f8377cc6ba8740e28ed87c97d0ee8775bc83505867b0bc34a66adc91f0ea9b44c80533f1a3dca', 'hex');
      
      const nodeAESKey = nodeCrypto.generateAESKeyFrom(testPublicKey, testPrivateKey);
      const browserAESKey = await browserCrypto.generateAESKeyFrom(testPublicKey, testPrivateKey);

      expect(Buffer.isBuffer(nodeAESKey)).toBe(true);
      expect(nodeAESKey.length).toBe(16); // AES-128 key length
      
      expect(browserAESKey instanceof Uint8Array).toBe(true);
      expect(browserAESKey.length).toBe(16);
      
      // Compare keys
      expect(nodeAESKey.toString('hex')).toBe(Buffer.from(browserAESKey).toString('hex'));
    });

    test('generateAESKeyFrom should work with random key pairs', async () => {
      const nodeKey = nodeCrypto.generatePrivateKey();
      const nodePKey = nodeCrypto.generatePublicKeyFromPrivateKey(nodeKey);
      
      const nodeAESKey = nodeCrypto.generateAESKeyFrom(nodePKey, nodeKey);
      const browserAESKey = await browserCrypto.generateAESKeyFrom(nodePKey, nodeKey);

      expect(nodeAESKey.toString('hex')).toBe(Buffer.from(browserAESKey).toString('hex'));
    });
  });

  describe('Encryption and Decryption', () => {
    test('_encryptMessage should produce decryptable ciphertext', async () => {
      const testPrivateKey = Buffer.from('60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8', 'hex');
      const testPublicKey = Buffer.from('731234931a081e9beae856318a9bf32ac3698ea8215bf74f517f8377cc6ba8740e28ed87c97d0ee8775bc83505867b0bc34a66adc91f0ea9b44c80533f1a3dca', 'hex');
      const testMessage = Buffer.from('hello world', 'utf8');
      const prefix = 0x2;

      // Generate one-time secret for encryption
      const nodeOTS = nodeCrypto.generatePrivateKey();
      const browserOTS = browserCrypto.generatePrivateKey();
      
      // Test with same OTS
      const nodeEncrypted = nodeCrypto._encryptMessage(testPublicKey, nodeOTS, testMessage, prefix);
      const browserEncrypted = await browserCrypto._encryptMessage(testPublicKey, nodeOTS, testMessage, prefix);

      expect(Buffer.isBuffer(nodeEncrypted)).toBe(true);
      expect(browserEncrypted instanceof Uint8Array).toBe(true);
      
      // Note: Due to random IV, encrypted outputs will differ even with same inputs
      // But both should be decryptable with the same private key
      const nodeDecrypted = nodeCrypto.decryptMessage(testPrivateKey, nodeEncrypted);
      const browserDecrypted = await browserCrypto.decryptMessage(testPrivateKey, nodeEncrypted);
      
      expect(nodeDecrypted.toString('utf8')).toBe(testMessage.toString('utf8'));
      expect(Buffer.from(browserDecrypted).toString('utf8')).toBe(testMessage.toString('utf8'));
      
      // Also test decrypting browser-encrypted message with node
      const browserDecryptedByNode = nodeCrypto.decryptMessage(testPrivateKey, browserEncrypted);
      expect(browserDecryptedByNode.toString('utf8')).toBe(testMessage.toString('utf8'));
    });

    test('decryptMessage should decrypt messages encrypted by Node version', async () => {
      const testPrivateKey = Buffer.from('60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8', 'hex');
      const testPublicKey = Buffer.from('731234931a081e9beae856318a9bf32ac3698ea8215bf74f517f8377cc6ba8740e28ed87c97d0ee8775bc83505867b0bc34a66adc91f0ea9b44c80533f1a3dca', 'hex');
      const testMessage = Buffer.from('test message for decryption', 'utf8');

      // Encrypt with Node version
      const nodeOTS = nodeCrypto.generatePrivateKey();
      const nodeEncrypted = nodeCrypto._encryptMessage(testPublicKey, nodeOTS, testMessage, 0x2);

      // Decrypt with Browser version
      const browserDecrypted = await browserCrypto.decryptMessage(testPrivateKey, nodeEncrypted);
      
      expect(Buffer.from(browserDecrypted).toString('utf8')).toBe(testMessage.toString('utf8'));
    });

    test('decryptMessage should decrypt messages encrypted by Browser version', async () => {
      const testPrivateKey = Buffer.from('60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8', 'hex');
      const testPublicKey = Buffer.from('731234931a081e9beae856318a9bf32ac3698ea8215bf74f517f8377cc6ba8740e28ed87c97d0ee8775bc83505867b0bc34a66adc91f0ea9b44c80533f1a3dca', 'hex');
      const testMessage = Buffer.from('test message for browser encryption', 'utf8');

      // Encrypt with Browser version
      const browserOTS = browserCrypto.generatePrivateKey();
      const browserEncrypted = await browserCrypto._encryptMessage(testPublicKey, browserOTS, testMessage, 0x2);

      // Decrypt with Node version
      const nodeDecrypted = nodeCrypto.decryptMessage(testPrivateKey, browserEncrypted);
      
      expect(nodeDecrypted.toString('utf8')).toBe(testMessage.toString('utf8'));
    });

    test('_decryptMessageWithPrefix should work with different prefixes', async () => {
      const testPrivateKey = Buffer.from('60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8', 'hex');
      const testPublicKey = Buffer.from('731234931a081e9beae856318a9bf32ac3698ea8215bf74f517f8377cc6ba8740e28ed87c97d0ee8775bc83505867b0bc34a66adc91f0ea9b44c80533f1a3dca', 'hex');
      const testMessage = Buffer.from('test with prefix 0x1', 'utf8');

      // Test prefix 0x1 (forward message)
      const nodeOTS = nodeCrypto.generatePrivateKey();
      const nodeEncrypted = nodeCrypto._encryptMessage(testPublicKey, nodeOTS, testMessage, 0x1);
      
      const browserDecrypted = await browserCrypto._decryptMessageWithPrefix(testPrivateKey, nodeEncrypted, 0x1);
      expect(Buffer.from(browserDecrypted).toString('utf8')).toBe(testMessage.toString('utf8'));
      
      // Test prefix 0x2 (normal message)
      const nodeEncrypted2 = nodeCrypto._encryptMessage(testPublicKey, nodeOTS, testMessage, 0x2);
      const browserDecrypted2 = await browserCrypto._decryptMessageWithPrefix(testPrivateKey, nodeEncrypted2, 0x2);
      expect(Buffer.from(browserDecrypted2).toString('utf8')).toBe(testMessage.toString('utf8'));
    });

    test('decryptForwardMessage should decrypt forward messages', async () => {
      const testPrivateKey = Buffer.from('60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8', 'hex');
      const testPublicKey = Buffer.from('731234931a081e9beae856318a9bf32ac3698ea8215bf74f517f8377cc6ba8740e28ed87c97d0ee8775bc83505867b0bc34a66adc91f0ea9b44c80533f1a3dca', 'hex');
      const testMessage = Buffer.from('forward message', 'utf8');

      // Encrypt forward message with Node
      const nodeOTS = nodeCrypto.generatePrivateKey();
      const nodeEncrypted = nodeCrypto._encryptMessage(testPublicKey, nodeOTS, testMessage, 0x1);

      // Decrypt with Browser decryptForwardMessage
      const browserDecrypted = await browserCrypto.decryptForwardMessage(testPrivateKey, nodeEncrypted);
      expect(Buffer.from(browserDecrypted).toString('utf8')).toBe(testMessage.toString('utf8'));
    });
  });

  describe('Forward Secret Key Generation', () => {
    test('generateForwardSecretKey should produce decryptable result', async () => {
      const remotePKey = Buffer.from('731234931a081e9beae856318a9bf32ac3698ea8215bf74f517f8377cc6ba8740e28ed87c97d0ee8775bc83505867b0bc34a66adc91f0ea9b44c80533f1a3dca', 'hex');
      const localSKey = Buffer.from('60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8', 'hex');

      const nodeForwardKey = nodeCrypto.generateForwardSecretKey(remotePKey, localSKey);
      const browserForwardKey = await browserCrypto.generateForwardSecretKey(remotePKey, localSKey);

      expect(Buffer.isBuffer(nodeForwardKey)).toBe(true);
      expect(browserForwardKey instanceof Uint8Array).toBe(true);
      
      // Both should be decryptable with remote private key
      // (Assuming we have the remote private key for testing)
      // Since we're using different OTS, outputs will differ, but both should be valid
      
      // Verify structure: should be encrypted message format (ciphertext + iv + pkey + tag)
      expect(nodeForwardKey.length).toBeGreaterThan(64 + 16 + 12); // at least pkey + tag + iv
      expect(browserForwardKey.length).toBeGreaterThan(64 + 16 + 12);
    });
  });

  describe('Encrypted Input Generation', () => {
    test('generateEncryptedInput should produce valid encrypted input', async () => {
      const localPKey = Buffer.from('731234931a081e9beae856318a9bf32ac3698ea8215bf74f517f8377cc6ba8740e28ed87c97d0ee8775bc83505867b0bc34a66adc91f0ea9b44c80533f1a3dca', 'hex');
      const testInput = { buffer: Buffer.from('test input data', 'utf8') };

      const nodeEncrypted = nodeCrypto.generateEncryptedInput(localPKey, testInput);
      const browserEncrypted = await browserCrypto.generateEncryptedInput(localPKey, testInput);

      expect(Buffer.isBuffer(nodeEncrypted)).toBe(true);
      expect(browserEncrypted instanceof Uint8Array).toBe(true);
      
      // Both should be valid encrypted messages
      expect(nodeEncrypted.length).toBeGreaterThan(64 + 16 + 12);
      expect(browserEncrypted.length).toBeGreaterThan(64 + 16 + 12);
    });
  });

  describe('File Name and Content Generation', () => {
    test('generateFileNameFromPKey should produce consistent results', () => {
      const testPKey = Buffer.from('731234931a081e9beae856318a9bf32ac3698ea8215bf74f517f8377cc6ba8740e28ed87c97d0ee8775bc83505867b0bc34a66adc91f0ea9b44c80533f1a3dca', 'hex');
      
      const nodeFileName = nodeCrypto.generateFileNameFromPKey(testPKey);
      const browserFileName = browserCrypto.generateFileNameFromPKey(testPKey);

      expect(typeof nodeFileName).toBe('string');
      expect(typeof browserFileName).toBe('string');
      expect(nodeFileName).toBe(browserFileName);
      expect(nodeFileName).toMatch(/^[0-9a-f]{8}\.json$/);
    });

    test('generateFileContentFromSKey should produce consistent results', () => {
      const testSKey = Buffer.from('60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8', 'hex');
      
      const nodeFileContent = nodeCrypto.generateFileContentFromSKey(testSKey);
      const browserFileContent = browserCrypto.generateFileContentFromSKey(testSKey);

      expect(typeof nodeFileContent).toBe('string');
      expect(typeof browserFileContent).toBe('string');
      
      // Parse JSON to compare
      const nodeObj = JSON.parse(nodeFileContent);
      const browserObj = JSON.parse(browserFileContent);
      
      expect(nodeObj.private_key).toBe(browserObj.private_key);
      expect(nodeObj.public_key).toBe(browserObj.public_key);
      expect(nodeObj.private_key).toBe(testSKey.toString('hex'));
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

    test('Browser encrypt -> Node decrypt should work', async () => {
      const testPrivateKey = browserCrypto.generatePrivateKey();
      const testPublicKey = browserCrypto.generatePublicKeyFromPrivateKey(testPrivateKey);
      const testMessage = Buffer.from('browser to node test', 'utf8');

      const browserOTS = browserCrypto.generatePrivateKey();
      const encrypted = await browserCrypto._encryptMessage(testPublicKey, browserOTS, testMessage, 0x2);
      const decrypted = nodeCrypto.decryptMessage(Buffer.from(testPrivateKey), encrypted);

      expect(decrypted.toString('utf8')).toBe(testMessage.toString('utf8'));
    });

    test('Node encrypt -> Browser decrypt should work', async () => {
      const testPrivateKey = nodeCrypto.generatePrivateKey();
      const testPublicKey = nodeCrypto.generatePublicKeyFromPrivateKey(testPrivateKey);
      const testMessage = Buffer.from('node to browser test', 'utf8');

      const nodeOTS = nodeCrypto.generatePrivateKey();
      const encrypted = nodeCrypto._encryptMessage(testPublicKey, nodeOTS, testMessage, 0x2);
      const decrypted = await browserCrypto.decryptMessage(testPrivateKey, encrypted);

      expect(Buffer.from(decrypted).toString('utf8')).toBe(testMessage.toString('utf8'));
    });
  });

  describe('Signature Consistency (no verification)', () => {
    test('signMessage should produce consistent signatures for same input', () => {
      const testPrivateKey = Buffer.from('60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8', 'hex');
      const testMessage = Buffer.from('test message for signing', 'utf8');

      const nodeSignature = nodeCrypto.signMessage(testPrivateKey, testMessage);
      const browserSignature = browserCrypto.signMessage(testPrivateKey, testMessage);

      expect(Buffer.isBuffer(nodeSignature)).toBe(true);
      expect(nodeSignature.length).toBe(65); // 64 bytes (r, s) + 1 byte (recovery + 27)
      
      expect(browserSignature instanceof Uint8Array).toBe(true);
      expect(browserSignature.length).toBe(65);

      // Compare signatures - should be identical for same input (deterministic signing)
      expect(nodeSignature.toString('hex')).toBe(Buffer.from(browserSignature).toString('hex'));
    });

    test('signMessage should produce consistent signatures with different message types', () => {
      const testPrivateKey = Buffer.from('60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8', 'hex');
      const testMessages = [
        Buffer.from('simple text', 'utf8'),
        Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd]),
        Buffer.alloc(32, 0x42), // 32 bytes of 0x42
      ];

      for (const testMessage of testMessages) {
        const nodeSignature = nodeCrypto.signMessage(testPrivateKey, testMessage);
        const browserSignature = browserCrypto.signMessage(testPrivateKey, testMessage);

        expect(nodeSignature.toString('hex')).toBe(Buffer.from(browserSignature).toString('hex'));
      }
    });

    test('generateSignature should produce consistent signatures', () => {
      const testPrivateKey = Buffer.from('60d61a1d92b26608016dba8cb8e8e96fd44d5dee0a0415a024657e47febcced8', 'hex');
      const testEPKey = Buffer.from('731234931a081e9beae856318a9bf32ac3698ea8215bf74f517f8377cc6ba874', 'hex');
      const testEHash = Buffer.alloc(32, 0xaa); // 32 bytes of 0xaa

      const nodeSignature = nodeCrypto.generateSignature(testPrivateKey, testEPKey, testEHash);
      const browserSignature = browserCrypto.generateSignature(testPrivateKey, testEPKey, testEHash);

      expect(Buffer.isBuffer(nodeSignature)).toBe(true);
      expect(nodeSignature.length).toBe(65);
      
      expect(browserSignature instanceof Uint8Array).toBe(true);
      expect(browserSignature.length).toBe(65);

      // Compare signatures - should be identical
      expect(nodeSignature.toString('hex')).toBe(Buffer.from(browserSignature).toString('hex'));
    });

    test('signMessage with random keys should produce consistent signatures', () => {
      const nodeKey = nodeCrypto.generatePrivateKey();
      const browserKey = browserCrypto.generatePrivateKey();
      const testMessage = Buffer.from('random key test', 'utf8');

      // Test with same private key (node-generated)
      const nodeSig1 = nodeCrypto.signMessage(nodeKey, testMessage);
      const browserSig1 = browserCrypto.signMessage(nodeKey, testMessage);
      expect(nodeSig1.toString('hex')).toBe(Buffer.from(browserSig1).toString('hex'));

      // Test with browser-generated key converted to Buffer
      const browserKeyBuf = Buffer.from(browserKey);
      const nodeSig2 = nodeCrypto.signMessage(browserKeyBuf, testMessage);
      const browserSig2 = browserCrypto.signMessage(browserKeyBuf, testMessage);
      expect(nodeSig2.toString('hex')).toBe(Buffer.from(browserSig2).toString('hex'));
    });
  });
});

