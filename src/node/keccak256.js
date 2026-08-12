/**
 * Node 侧 keccak256 原语与滚动哈希。
 *
 * 密封/解封的每个 item 都要过一遍 keccak（rolling hash），所以这个原语的速度直接
 * 决定加密、解密、校验三条路的吞吐：@noble/hashes 的纯 JS 实现实测约 20~40MB/s，
 * `keccak` 原生 addon 约 350MB/s（同输入摘要一致）。GB 级文件差的是分钟级的时间。
 *
 * 因此这里默认「能用原生就用原生」：`keccak` 是 optionalDependency，装不上
 * （无编译工具链 / 平台无 prebuild）或加载失败时静默回退纯 JS，功能不变只是慢。
 * 需要强制纯 JS 时设环境变量 META_ENCRYPTOR_DISABLE_NATIVE_KECCAK=1。
 *
 * 本模块只被 src/node/** 引用；浏览器构建入口是 src/index.browser.js（只走
 * src/browser + src/common），不会把 `keccak` 或 node 内置模块拉进 bundle。
 *
 * 加载方式刻意不用 `import.meta.url`：Jest 把 ESM 转成 CJS 后会在解析阶段
 * 直接 SyntaxError。改用 createRequire + 包根路径，Node / Electron / 测试都能跑。
 */

import { keccak_256 as keccakJs } from '@noble/hashes/sha3';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { MaxItemSize } from '../common/limits.js';
import log from 'loglevel';

const logger = log.getLogger('meta-encryptor/keccak256');

const HASH_SEED = 'Fidelius';
const HASH_SIZE = 32;
const INITIAL_ITEM_BUFFER_SIZE = MaxItemSize + 4096;

/** keccak256("Fidelius")：密封文件哈希的种子，正好当自检向量 */
const SELF_TEST_INPUT = HASH_SEED;
const SELF_TEST_EXPECTED =
  'f9a8b9cdf375f5ba676e67d87f29aaf8975ed9a78386926ea0703d3a7ba7ae59';

/** 'native' | 'js'；undefined 表示还没探测 */
let implementation;
let nativeHash = null;

const PACKAGE_NAME = '@yeez-tech/meta-encryptor';

/**
 * 从 startDir 向上找 ME 的 package.json，返回锚定在该包的 require。
 * @param {string} startDir
 * @returns {NodeRequire | null}
 */
function findMetaEncryptorRequire(startDir) {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const name = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).name;
        if (name === PACKAGE_NAME) {
          return createRequire(pkgPath);
        }
      } catch {
        /* keep walking */
      }
    }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * 从本包安装目录解析 optionalDependency（不依赖 process.cwd()）。
 * - Electron 打包态：process.resourcesPath/app.asar.unpacked/node_modules/@yeez-tech/meta-encryptor
 * - 常规安装态：从 cwd 能 resolve 到 @yeez-tech/meta-encryptor 时上溯 package.json
 * - 本仓库开发态：退回 process.cwd()/package.json
 */
function createPackageRequire() {
  const candidates = [];

  if (process.resourcesPath) {
    candidates.push(
      path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        PACKAGE_NAME,
      ),
    );
  }

  const fromCwd = createRequire(path.join(process.cwd(), 'package.json'));
  try {
    candidates.push(path.dirname(fromCwd.resolve(PACKAGE_NAME)));
  } catch {
    /* packaged .app 的 cwd 往往不在 node_modules 旁 */
  }

  for (const start of candidates) {
    const req = findMetaEncryptorRequire(start);
    if (req) return req;
  }

  return fromCwd;
}

/** @param {string} reason @param {Record<string, unknown>} [extra] */
function warnJsKeccakFallback(reason, extra = {}) {
  logger.warn('keccak using pure JS fallback (encrypt/decrypt throughput will be degraded)', {
    reason,
    implementation: 'js',
    cwd: process.cwd(),
    resourcesPath: process.resourcesPath || null,
    ...extra,
  });
}

function loadNative() {
  if (process.env.META_ENCRYPTOR_DISABLE_NATIVE_KECCAK === '1') {
    warnJsKeccakFallback('META_ENCRYPTOR_DISABLE_NATIVE_KECCAK');
    return null;
  }

  let createKeccak;
  let jsFallbackPrototype;
  try {
    const nodeRequire = createPackageRequire();
    createKeccak = nodeRequire('keccak');
    jsFallbackPrototype = Object.getPrototypeOf(nodeRequire('keccak/js')('keccak256'));
  } catch (e) {
    warnJsKeccakFallback('native_keccak_unavailable', {
      error: e && e.message ? e.message : String(e),
    });
    return null;
  }

  // 被打包器内联时，keccak 内部的 node-gyp-build 找不到 .node，keccak 自己会退回纯 JS。
  // 这种情况摘要仍然正确，只有原型能区分 —— 别让它冒充原生，否则日志会骗人。
  if (Object.getPrototypeOf(createKeccak('keccak256')) === jsFallbackPrototype) {
    warnJsKeccakFallback('keccak_js_fallback_prototype', {
      hint: 'keep @yeez-tech/meta-encryptor (and keccak) external in Electron main webpack',
    });
    return null;
  }

  const hash = (data) =>
    createKeccak('keccak256').update(Buffer.isBuffer(data) ? data : Buffer.from(data)).digest();

  const actual = hash(Buffer.from(SELF_TEST_INPUT, 'utf-8')).toString('hex');
  if (actual !== SELF_TEST_EXPECTED) {
    warnJsKeccakFallback('native_keccak_self_test_mismatch', {
      expected: SELF_TEST_EXPECTED,
      actual,
    });
    return null;
  }
  return hash;
}

function ensureResolved() {
  if (implementation !== undefined) return;
  nativeHash = loadNative();
  implementation = nativeHash ? 'native' : 'js';
  logger.info('keccak256 implementation selected', { implementation });
}

/**
 * 当前生效的 keccak256 实现，便于宿主打日志排查性能问题。
 * @returns {'native' | 'js'}
 */
export function getKeccakImplementation() {
  ensureResolved();
  return implementation;
}

/**
 * 默认 keccak256：原生可用时走原生，否则纯 JS。
 * @param {Uint8Array} data
 * @returns {Buffer}
 */
export function keccak256(data) {
  ensureResolved();
  return nativeHash ? nativeHash(data) : Buffer.from(keccakJs(data));
}

/**
 * @param {{ keccak256: (data: Uint8Array) => Uint8Array }} [hashProvider]
 *   调用方自带实现（测试或特殊环境用）；省略则用默认选择。
 * @returns {(data: Uint8Array) => Buffer}
 */
export function resolveKeccak256(hashProvider) {
  if (hashProvider && typeof hashProvider.keccak256 === 'function') {
    return (data) => Buffer.from(hashProvider.keccak256(data));
  }
  return keccak256;
}

/**
 * 滚动哈希器（hash_0 = keccak256("Fidelius")，hash_i = keccak256(hash_{i-1} ‖ item_i)）。
 * 复用一块 `prevHash ‖ item` 缓冲，避免每个 item 都 concat / hex 往返。
 * 密封（DataProvider）、解封（Unsealer）、校验（SealedHash）三处口径必须一致，故共用此实现。
 *
 * @param {(data: Uint8Array) => Buffer} [hashFn] 省略则用默认 keccak256
 * @param {Buffer} [seedHash] 断点续算的中间哈希；省略则从种子开始
 */
export function createRollingHasher(hashFn = keccak256, seedHash) {
  let buffer = Buffer.allocUnsafe(HASH_SIZE + INITIAL_ITEM_BUFFER_SIZE);
  let current = seedHash || hashFn(Buffer.from(HASH_SEED, 'utf-8'));

  return {
    get value() {
      return current;
    },
    /** @returns {Buffer} 更新后的哈希 */
    update(item) {
      const needed = current.length + item.length;
      if (buffer.length < needed) buffer = Buffer.allocUnsafe(needed);
      buffer.set(current, 0);
      buffer.set(item, current.length);
      current = hashFn(buffer.subarray(0, needed));
      return current;
    },
  };
}
