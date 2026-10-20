/**
 * secp256k1 实现探测：原生可用时报 native；原生 addon 加载失败（例如混进了别的平台的
 * build/Release/addon.node）时报 elliptic，并在 warn 日志里带上加载错误。
 */

import fs from 'fs';
import path from 'path';

/** 每次拿一份全新的模块状态，以及它实际用的那个 logger（isolateModules 会重载 loglevel） */
function loadFresh() {
  let mod;
  let logger;
  jest.isolateModules(() => {
    mod = require('../src/node/secp256k1Impl.js');
    logger = require('loglevel').getLogger('meta-encryptor/secp256k1');
  });
  return {
    getSecp256k1Implementation: mod.getSecp256k1Implementation,
    info: jest.spyOn(logger, 'info'),
    warn: jest.spyOn(logger, 'warn').mockImplementation(() => {}),
  };
}

describe('getSecp256k1Implementation', () => {
  const originalCwd = process.cwd();
  // 放在仓库内，bindings.js 依赖的 node-gyp-build 才能沿目录向上解析到
  const sandbox = path.join(originalCwd, 'test', '.secp256k1-impl-sandbox');

  afterEach(() => {
    process.chdir(originalCwd);
    jest.restoreAllMocks();
  });

  afterAll(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('reports native and logs the selection once', () => {
    const { getSecp256k1Implementation, info, warn } = loadFresh();

    expect(getSecp256k1Implementation()).toBe('native');
    expect(getSecp256k1Implementation()).toBe('native');
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      'secp256k1 implementation selected',
      expect.objectContaining({ implementation: 'native' })
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports elliptic with the load error when build/Release holds a foreign binary', () => {
    const pkgDir = path.join(sandbox, 'node_modules', 'secp256k1');
    fs.rmSync(sandbox, { recursive: true, force: true });
    fs.cpSync(path.join(originalCwd, 'node_modules', 'secp256k1'), pkgDir, { recursive: true });
    fs.rmSync(path.join(pkgDir, 'build'), { recursive: true, force: true });
    fs.mkdirSync(path.join(pkgDir, 'build', 'Release'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'build', 'Release', 'addon.node'), 'not a native module');
    fs.writeFileSync(path.join(sandbox, 'package.json'), '{"name":"secp256k1-impl-sandbox"}');

    process.chdir(sandbox);
    const { getSecp256k1Implementation, warn } = loadFresh();

    expect(getSecp256k1Implementation()).toBe('elliptic');
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, detail] = warn.mock.calls[0];
    expect(message).toMatch(/pure JS fallback/);
    expect(detail.path).toBe(fs.realpathSync(pkgDir));
    expect(detail.error).toMatch(/addon\.node/);
  });
});
