/**
 * Node 侧 secp256k1 实现探测（只用于日志与排查，不改变加载结果）。
 *
 * secp256k1 包的 index.js 是 `try { require('./bindings') } catch { require('./elliptic') }`：
 * 原生 addon 加载失败时静默换成纯 JS 的 elliptic。每个 item 的 ECDH 从约 70µs 变成约
 * 900µs，加密/解密吞吐会掉到原来的 1/3~1/4，而且没有任何报错。典型原因是安装包里混进了
 * 别的平台 / 架构编译的 build/Release/addon.node（node-gyp-build 优先加载它，不校验平台）。
 *
 * 判定方式：在 ME 实际加载的那份 secp256k1 目录里重放一次 `require('./bindings')`。
 * 成功的模块会被缓存（不重复加载），失败的不会被缓存，所以结果与 index.js 当时的选择一致，
 * 失败时还能拿到具体报错。
 */

import 'secp256k1';
import { createRequire } from 'module';
import path from 'path';
import log from 'loglevel';

const logger = log.getLogger('meta-encryptor/secp256k1');

/** 'native' | 'elliptic' | 'unknown'；undefined 表示还没探测 */
let implementation;

/** Node 模块缓存里已加载的 secp256k1/index.js 所在目录（Electron 下是 app.asar 内路径） */
function findLoadedPackageDir(req) {
  const suffix = `${path.sep}secp256k1${path.sep}index.js`;
  const key = Object.keys(req.cache || {}).find((k) => k.endsWith(suffix));
  return key ? path.dirname(key) : null;
}

function detect() {
  const req = createRequire(path.join(process.cwd(), 'package.json'));
  let dir = findLoadedPackageDir(req);
  if (!dir) {
    // Jest 等自带模块注册表的环境不写 Node 缓存，退回按 cwd 解析
    try {
      dir = path.dirname(req.resolve('secp256k1'));
    } catch {
      return { implementation: 'unknown', reason: 'secp256k1_not_located' };
    }
  }
  try {
    createRequire(path.join(dir, 'index.js'))('./bindings');
    return { implementation: 'native', dir };
  } catch (e) {
    return {
      implementation: 'elliptic',
      dir,
      reason: 'native_binding_unavailable',
      error: e && e.message ? e.message : String(e),
    };
  }
}

/**
 * 当前生效的 secp256k1 实现，进程内首次调用时打日志（与 keccak256 的日志对应）。
 * @returns {'native' | 'elliptic' | 'unknown'}
 */
export function getSecp256k1Implementation() {
  if (implementation !== undefined) return implementation;
  const result = detect();
  implementation = result.implementation;
  if (implementation !== 'native') {
    logger.warn('secp256k1 using pure JS fallback (encrypt/decrypt throughput will be degraded)', {
      implementation,
      reason: result.reason,
      error: result.error,
      path: result.dir || null,
      platform: process.platform,
      arch: process.arch,
    });
  }
  logger.info('secp256k1 implementation selected', {
    implementation,
    path: result.dir || null,
  });
  return implementation;
}
