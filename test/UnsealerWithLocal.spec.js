import path from 'path';
import fs from 'fs';
import { UnsealerWithLocal } from '../src/UnsealerWithLocal';
import log from 'loglevel';

const logger = require('loglevel').getLogger('meta-encryptor/UnsealerWithTus');
const loggerPro = require('loglevel').getLogger(
  'meta-encryptor/ProgressInfoStream'
);

logger.setLevel('debug');

log.setLevel('debug');

loggerPro.setLevel('debug');
const TEST_CONFIG = {
  key_pair: {
    private_key:
      '0231ef41a4471d4b387b25f02f25994f1da20fd678e7a8d3103052c76bd1867a',
    public_key:
      '625c4fc549c3aafbce519e5653212fdeb76961122cb0d4ac268efa0a4e8f0be22c1a21948d4f4e8554b8aa7c1dba7b6d86dde8e5627a8837fe2b9f5b4d4450fc',
  },
  paths: {
    encrypted: '/3ec5734d11070096.sealed',
    output: '/3ec5734d11070096.zip',
  },
  blockSize: 1024 * 1024,
  timeout: 30000, // 添加超时配置
  retryCount: 3, // 添加重试次数配置
};

class DecryptionTest {
  constructor(config) {
    this.config = config;
    this.progressFilePath = config.paths.output + '.progress';
    this.decryptPath = config.paths.output + '.decrypt';
    this.unsealer = null;
    this.flowStarted = false;
    this.lastProgress = null;
  }

  createUnsealer() {
    return new UnsealerWithLocal({
      privateKey: this.config.key_pair.private_key,
      publicKey: this.config.key_pair.public_key,
      filePath: this.config.paths.encrypted,
      progressFilePath: this.progressFilePath,
      decryptPath: this.decryptPath,
      blockSize: this.config.blockSize,
      timeout: this.config.timeout,
      retryCount: this.config.retryCount,
    });
  }

  logProgress(progressInfo) {
    console.log('Decryption progress:', {
      percentage: progressInfo.percentage.toFixed(2) + '%',
      processedBytes: progressInfo.processedBytes,
      writtenBytes: progressInfo.writeBytes,
      isCompleted: progressInfo.isCompleted,
      isAborted: progressInfo.isAborted,
      hasError: progressInfo.hasError,
      metrics: progressInfo.metrics,
    });
  }

  async handleCompletion(totalWrittenBytes) {
    // 1. 截断原加密文件
    await fs.promises.truncate(this.config.paths.encrypted, totalWrittenBytes);
    console.log('File truncated to:', totalWrittenBytes);

    // 2. 重命名原文件到目标文件
    await this.safeRename();

    // 3. 清理进度文件
    await this.cleanupProgressFiles();
    console.log('Progress files cleaned up');

    // 确保所有文件操作完成
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  async safeRename() {
    try {
      // 如果目标文件已存在，先删除
      await fs.promises
        .access(this.config.paths.output)
        .then(() => fs.promises.unlink(this.config.paths.output))
        .catch(() => {});

      await fs.promises.rename(
        this.config.paths.encrypted,
        this.config.paths.output
      );
      console.log('File renamed to final output');
    } catch (error) {
      throw new Error(`Failed to rename file: ${error.message}`);
    }
  }

  async cleanupProgressFiles() {
    const progressFiles = [
      this.progressFilePath,
      this.progressFilePath + '.tmp',
      this.decryptPath + '.tmp',
    ];

    await Promise.all(
      progressFiles.map(async (file) => {
        try {
          await fs.promises.access(file);
          await fs.promises.unlink(file);
          console.log(`Cleaned up: ${file}`);
        } catch (error) {
          if (error.code !== 'ENOENT') {
            console.warn(`Failed to clean up ${file}:`, error);
          }
        }
      })
    );
  }

  async verifyOutput() {
    try {
      const verificationResult = {
        success: false,
        fileSize: 0,
        remainingTempFiles: [],
        outputPath: this.config.paths.output,
        encryptedFileRemoved: false,
        metrics: null,
      };

      // 检查输出文件
      const stats = await fs.promises.stat(this.config.paths.output);
      verificationResult.fileSize = stats.size;
      verificationResult.success = stats.size > 0;

      // 检查临时文件
      const tempFiles = [
        this.progressFilePath,
        this.progressFilePath + '.tmp',
        this.decryptPath + '.tmp',
      ];

      verificationResult.remainingTempFiles = (
        await Promise.all(
          tempFiles.map(async (file) => {
            try {
              await fs.promises.access(file);
              return path.basename(file);
            } catch {
              return null;
            }
          })
        )
      ).filter(Boolean);

      // 检查原加密文件
      verificationResult.encryptedFileRemoved = !(await fs.promises
        .access(this.config.paths.encrypted)
        .then(() => true)
        .catch(() => false));

      // 添加性能指标
      verificationResult.metrics = this.lastProgress?.metrics;

      return verificationResult;
    } catch (error) {
      console.error('Verification failed:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async runDecryption() {
    console.log('Starting decryption process...');

    return new Promise((resolve, reject) => {
      this.unsealer = this.createUnsealer();
      let isAborting = false;

      // 监听进度
      this.unsealer.on('progress', (progressInfo) => {
        this.lastProgress = progressInfo;
        if (!this.flowStarted && !isAborting) {
          this.flowStarted = true;
          console.log('Data flow started');
        }
        this.logProgress(progressInfo);
      });

      // 监听解密进度
      this.unsealer.on('decryptProgress', (writeBytes) => {
        if (!isAborting) {
          console.log('Decrypt progress - written bytes:', writeBytes);
        }
      });

      // 监听关闭事件
      this.unsealer.on('close', async (result) => {
        // console.log("Unsealer closed with result:", result);

        if (result.isAborted) {
          reject(new Error('Decryption was aborted'));
        } else if (result.hasError) {
          reject(new Error('Decryption failed with errors'));
        } else if (result.isCompleted) {
          try {
            console.log('Decryption completed, starting post-processing...');
            await this.handleCompletion(result.writeBytes);
            resolve(result);
          } catch (error) {
            console.error('Post-processing failed:', error);
            reject(error);
          }
        }
      });

      // 错误处理
      this.unsealer.on('error', (error) => {
        if (!isAborting) {
          console.error('Decryption error:', error);
          reject(error);
        }
      });

      // 启动解密
      console.log('Starting unsealer...');
      this.unsealer.start().catch((error) => {
        if (!isAborting) {
          console.error('Failed to start unsealer:', error);
          reject(error);
        }
      });

      // 暴露中断标志设置方法
      this.setAborting = (value) => {
        isAborting = value;
      };
    });
  }

  async cleanup() {
    if (this.unsealer) {
      try {
        this.setAborting?.(true);
        const result = await this.unsealer.abort();
        console.log('Cleanup result:', result);
        await this.cleanupProgressFiles();
      } catch (error) {
        console.error('Cleanup error:', error);
      }
    }
  }
}

describe('UnsealerWithLocal Full Decryption', () => {
  jest.setTimeout(600000); // 10 minutes timeout

  let decryptionTest;

  beforeEach(() => {
    decryptionTest = new DecryptionTest(TEST_CONFIG);
  });

  afterEach(async () => {
    if (decryptionTest.unsealer) {
      await new Promise((resolve) => {
        // 监听关闭事件
        decryptionTest.unsealer._writeStream?.on('close', resolve);
        // 执行清理
        decryptionTest.cleanup().catch(console.error);
      });
    }
  });

  test('should complete full decryption successfully', async () => {
    try {
      // 执行完整解密
      console.log('Starting full decryption test...');
      const result = await decryptionTest.runDecryption();

      console.log('Decryption completed with result:', result);

      // 验证结果
      const verificationResult = await decryptionTest.verifyOutput();

      // 断言
      expect(verificationResult.success).toBe(true);
      expect(verificationResult.fileSize).toBeGreaterThan(0);
      expect(verificationResult.remainingTempFiles).toHaveLength(0);
      expect(verificationResult.encryptedFileRemoved).toBe(true);
      expect(verificationResult.metrics).toBeTruthy();
      expect(verificationResult.metrics.processingTime).toBeGreaterThan(0);

      // 检查完成状态
      expect(result.isCompleted).toBe(true);
      expect(result.isAborted).toBe(false);
      expect(result.hasError).toBe(false);

      console.log('Verification results:', verificationResult);
    } catch (error) {
      console.error('Test failed:', error);
      throw error;
    }
  });
});
describe('UnsealerWithLocal Interruption and Resume Tests', () => {
  jest.setTimeout(600000); // 10 minutes timeout
  let decryptionTest;

  // 修改为等待指定时间后中断
  const waitAndAbort = async (waitTimeMs) => {
    return new Promise((resolve) => {
      const timer = setTimeout(async () => {
        console.log(`${waitTimeMs}ms passed, initiating abort...`);
        await decryptionTest.unsealer.abort();
        console.log('Abort completed');
        resolve();
      }, waitTimeMs);

      // 保存最后的进度信息
      decryptionTest.unsealer.on('progress', (progressInfo) => {
        console.log('Progress update:', {
          percentage: progressInfo.percentage?.toFixed(2) + '%',
          processedBytes: progressInfo.processedBytes,
          writeBytes: progressInfo.writeBytes,
        });
      });
    });
  };

  beforeEach(() => {
    decryptionTest = new DecryptionTest(TEST_CONFIG);
  });

  afterEach(async () => {
    if (decryptionTest.unsealer) {
      await decryptionTest.cleanup().catch(console.error);
    }
  });

  test('should resume after periodic interruptions', async () => {
    const interruptInterval = 2000; // 每2秒中断一次
    const maxAttempts = 5; // 最多中断5次
    let lastProgress = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        console.log(`\nStarting decryption attempt ${attempt + 1}...`);
        const decryptionPromise = decryptionTest.runDecryption();

        // 等待2秒后中断
        await waitAndAbort(interruptInterval);

        // 验证中断状态
        const afterAbortVerification = await decryptionTest.verifyOutput();
        console.log(
          `Attempt ${attempt + 1} verification:`,
          afterAbortVerification
        );

        // 保存进度信息用于比较
        lastProgress = decryptionTest.lastProgress;

        // 等待确保清理完成
        await new Promise((resolve) => setTimeout(resolve, 500));

        // 创建新实例继续处理
        decryptionTest = new DecryptionTest(TEST_CONFIG);
      } catch (error) {
        if (error.message !== 'Decryption was aborted') {
          console.error(`Unexpected error in attempt ${attempt + 1}:`, error);
          throw error;
        }
        console.log(`Attempt ${attempt + 1} aborted as expected`);
      }
    }

    // 最后一次完整解密
    try {
      console.log('\nStarting final complete decryption...');
      const finalResult = await decryptionTest.runDecryption();
      console.log('Final decryption completed:', finalResult);

      // 验证最终结果
      const verificationResult = await decryptionTest.verifyOutput();
      console.log('Final verification:', verificationResult);

      expect(verificationResult.success).toBe(true);
      expect(verificationResult.fileSize).toBeGreaterThan(0);
      expect(verificationResult.remainingTempFiles).toHaveLength(0);
      expect(verificationResult.encryptedFileRemoved).toBe(true);

      if (lastProgress) {
        // 确保整体进度在增加
        expect(finalResult.writeBytes).toBeGreaterThan(
          lastProgress.writeBytes || 0
        );
      }
    } catch (error) {
      console.log('Final phase error:', error);
      throw error;
    }
  });
});

describe('UnsealerWithLocal Recovery Tests', () => {
  jest.setTimeout(600000); // 10 minutes timeout
  let decryptionTest;

  beforeEach(() => {
    decryptionTest = new DecryptionTest(TEST_CONFIG);
  });

  afterEach(async () => {
    if (decryptionTest.unsealer) {
      await decryptionTest.cleanup().catch(console.error);
    }
  });

  test('should recover from previous interrupted state', async () => {
    // 1. 首先检查是否存在之前的临时文件
    const initialState = await checkExistingProgress();
    console.log('Initial state:', initialState);

    if (initialState.hasExistingProgress) {
      console.log('Found existing progress, attempting to resume...');
    } else {
      console.log('No existing progress found, starting fresh...');
    }

    try {
      const result = await decryptionTest.runDecryption();
      console.log('Decryption completed:', result);

      // 验证结果
      const verificationResult = await decryptionTest.verifyOutput();
      console.log('Verification result:', verificationResult);

      expect(verificationResult.success).toBe(true);
      expect(verificationResult.fileSize).toBeGreaterThan(0);
      expect(verificationResult.remainingTempFiles).toHaveLength(0);
      expect(verificationResult.encryptedFileRemoved).toBe(true);
    } catch (error) {
      console.error('Decryption failed:', error);
      throw error;
    }
  });
});

// 辅助函数：检查现有进度
async function checkExistingProgress() {
  const progressFiles = [
    TEST_CONFIG.paths.output + '.progress',
    TEST_CONFIG.paths.output + '.progress.tmp',
    TEST_CONFIG.paths.output + '.decrypt.tmp',
  ];

  const existingFiles = await Promise.all(
    progressFiles.map(async (file) => {
      try {
        const stats = await fs.promises.stat(file);
        return {
          path: file,
          exists: true,
          size: stats.size,
        };
      } catch {
        return {
          path: file,
          exists: false,
          size: 0,
        };
      }
    })
  );

  const existingProgress = existingFiles.filter((f) => f.exists);

  return {
    hasExistingProgress: existingProgress.length > 0,
    existingFiles: existingProgress,
    totalProgressSize: existingProgress.reduce((sum, f) => sum + f.size, 0),
  };
}
