import path from 'path';
import fs from 'fs';
import { uuidv7 } from 'uuidv7';
import { UnsealerWithLocal } from '../src/UnsealerWithLocal';
import { Sealer } from '../src/Sealer';
import { calculateMD5, key_pair, generateFileWithSize } from './helper';
import log from 'loglevel';

const logger = require('loglevel').getLogger(
  'meta-encryptor/UnsealerWithLocal'
);
logger.setLevel('debug');

describe('UnsealerWithLocal Basic Test', () => {
  const TEST_DIR = path.join(__dirname, '../test-files');

  beforeAll(async () => {
    if (!fs.existsSync(TEST_DIR)) {
      await fs.promises.mkdir(TEST_DIR, { recursive: true });
    }
  });

  test('should decrypt file in place', async () => {
    // 1. 生成原始文件
    const originalFile = path.join(TEST_DIR, `original-${uuidv7()}`);
    await generateFileWithSize(originalFile, 1024 * 1024); // 1MB
    const originalMD5 = await calculateMD5(originalFile);

    // 2. 加密文件
    const encryptedFile = path.join(TEST_DIR, `encrypted-${uuidv7()}`);
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(originalFile);
      const ws = fs.createWriteStream(encryptedFile);
      rs.pipe(new Sealer({ keyPair: key_pair }))
        .pipe(ws)
        .on('finish', resolve)
        .on('error', reject);
    });

    // 3. 解密文件
    const decryptTmpPath = path.join(TEST_DIR, `decrypt-tmp-${uuidv7()}`);
    const progressFile = path.join(TEST_DIR, `progress-${uuidv7()}`);

    const unsealer = new UnsealerWithLocal({
      privateKey: key_pair.private_key,
      publicKey: key_pair.public_key,
      filePath: encryptedFile,
      decryptPath: decryptTmpPath,
      progressFilePath: progressFile,
    });

    await new Promise((resolve, reject) => {
      unsealer.on('progress', (progress) => {
        logger.debug('Decryption progress:', {
          processedBytes: progress.processedBytes,
          writeBytes: progress.writeBytes,
        });
      });

      unsealer.on('error', (error) => {
        logger.error('Decryption error:', error);
        reject(error);
      });

      unsealer.on('close', (result) => {
        if (result.hasError) {
          reject(new Error('Decryption failed'));
        } else {
          // 解密完成后截断文件
          fs.truncateSync(encryptedFile, result.writeBytes);
          resolve(result);
        }
      });

      unsealer.start().catch(reject);
    });

    // 4. 验证解密结果
    const decryptedMD5 = await calculateMD5(encryptedFile);
    expect(decryptedMD5).toBe(originalMD5);

    // 5. 清理文件
    await Promise.all([
      fs.promises.unlink(originalFile),
      fs.promises.unlink(encryptedFile),
      fs.promises.unlink(decryptTmpPath).catch(() => {}),
      fs.promises.unlink(progressFile).catch(() => {}),
    ]);
  });
  test('should support pause and resume decryption', async () => {
    // 1. 生成原始文件
    const originalFile = path.join(TEST_DIR, `original-${uuidv7()}`);
    await generateFileWithSize(originalFile, 1024 * 1024 * 10); // 10MB
    const originalMD5 = await calculateMD5(originalFile);

    // 2. 加密文件
    const encryptedFile = path.join(TEST_DIR, `encrypted-${uuidv7()}`);
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(originalFile);
      const ws = fs.createWriteStream(encryptedFile);
      rs.pipe(new Sealer({ keyPair: key_pair }))
        .pipe(ws)
        .on('finish', resolve)
        .on('error', reject);
    });

    // 3. 解密文件
    const decryptTmpPath = path.join(TEST_DIR, `decrypt-tmp-${uuidv7()}`);
    const progressFile = path.join(TEST_DIR, `progress-${uuidv7()}`);

    let isCompleted = false;
    let attempts = 0;
    const maxAttempts = 3;
    let lastWriteBytes = 0;

    while (!isCompleted && attempts < maxAttempts) {
      logger.debug(`Starting attempt ${attempts + 1}`);

      const unsealer = new UnsealerWithLocal({
        privateKey: key_pair.private_key,
        publicKey: key_pair.public_key,
        filePath: encryptedFile,
        decryptPath: decryptTmpPath,
        progressFilePath: progressFile,
      });

      await new Promise((resolve) => {
        let shouldAbort = false;

        unsealer.on('progress', (progress) => {
          logger.debug('Progress:', {
            attempt: attempts + 1,
            percentage: progress.percentage?.toFixed(2) + '%',
            processedBytes: progress.processedBytes,
            writeBytes: progress.writeBytes,
          });

          // 当写入超过2MB时暂停
          if (
            !shouldAbort &&
            progress.writeBytes > lastWriteBytes + 2 * 1024 * 1024
          ) {
            shouldAbort = true;
            lastWriteBytes = progress.writeBytes;
            logger.debug(`Aborting at ${progress.writeBytes} bytes`);
            unsealer.abort().then(() => resolve());
          }
        });

        unsealer.on('close', async (result) => {
          logger.debug('Close event:', result);
          if (result.isCompleted) {
            isCompleted = true;
            // 确保文件操作完成
            fs.truncateSync(encryptedFile, result.writeBytes);
          }
          resolve();
        });

        unsealer.on('error', (error) => {
          logger.error('Error during decryption:', error);
          resolve();
        });

        // 启动解密
        unsealer.start().catch((error) => {
          logger.error('Start failed:', error);
          resolve();
        });
      });

      // 等待文件系统操作完成
      await new Promise((resolve) => setTimeout(resolve, 1000));

      attempts++;
      logger.debug(
        `Attempt ${attempts} completed, isCompleted: ${isCompleted}`
      );
    }

    // 最后一次完整解密
    if (!isCompleted) {
      logger.debug('Starting final complete decryption');
      const finalUnsealer = new UnsealerWithLocal({
        privateKey: key_pair.private_key,
        publicKey: key_pair.public_key,
        filePath: encryptedFile,
        decryptPath: decryptTmpPath,
        progressFilePath: progressFile,
      });

      await new Promise((resolve, reject) => {
        finalUnsealer.on('close', (result) => {
          if (result.isCompleted) {
            fs.truncateSync(encryptedFile, result.writeBytes);
            resolve();
          } else {
            reject(new Error('Final decryption failed'));
          }
        });

        finalUnsealer.on('error', reject);
        finalUnsealer.start().catch(reject);
      });
    }

    // 等待文件系统同步
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 验证解密结果
    const decryptedMD5 = await calculateMD5(encryptedFile);
    expect(decryptedMD5).toBe(originalMD5);

    // 清理文件
    await Promise.all([
      fs.promises.unlink(originalFile),
      fs.promises.unlink(encryptedFile),
      fs.promises.unlink(progressFile).catch(() => {}),
    ]);
  });
  afterAll(async () => {
    if (fs.existsSync(TEST_DIR)) {
      const files = await fs.promises.readdir(TEST_DIR);
      await Promise.all(
        files.map((file) =>
          fs.promises.unlink(path.join(TEST_DIR, file)).catch(() => {})
        )
      );
      await fs.promises.rmdir(TEST_DIR).catch(() => {});
    }
  });
});
