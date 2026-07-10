'use strict';

const fs = require('fs');
const path = require('path');

const TEST_TMP_DIR = path.join(
  process.cwd(),
  'test_tmp',
  `w${process.env.JEST_WORKER_ID || '0'}`
);

const registered = new Set();
let currentTestTemps = new Set();

function rmSafe(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function registerTemp(target) {
  if (!target) return;
  const abs = path.resolve(target);
  const tmpRoot = path.resolve(process.cwd(), 'test_tmp');
  if (abs !== tmpRoot && !abs.startsWith(tmpRoot + path.sep)) {
    throw new Error(`Refusing to register test artifact outside test_tmp: ${abs}`);
  }
  registered.add(abs);
  currentTestTemps.add(abs);
}

function registerDerivedTemps(basePath) {
  const abs = path.resolve(basePath);
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  registerTemp(abs);
  for (const suffix of [
    '.sealed',
    '.sealed.ret',
    '.unsealed.ret',
    '.util.sealed',
    '.browser.unsealed',
    '.copy',
  ]) {
    registerTemp(path.join(dir, base + suffix));
  }
}

function testPath(...segments) {
  fs.mkdirSync(TEST_TMP_DIR, { recursive: true });
  const p = path.join(TEST_TMP_DIR, ...segments);
  registerTemp(p);
  registerDerivedTemps(p);
  return p;
}

function cleanupCurrentTestTemps() {
  for (const p of currentTestTemps) {
    rmSafe(p);
  }
  currentTestTemps.clear();
}

function cleanupRegistered() {
  for (const p of registered) {
    rmSafe(p);
  }
  registered.clear();
  currentTestTemps.clear();
}

function cleanupAll() {
  cleanupRegistered();
}

function cleanupTestTmpRoot(cwd = process.cwd()) {
  rmSafe(path.join(cwd, 'test_tmp'));
}

function cleanupAfterTest() {
  cleanupCurrentTestTemps();
}

let jestHooksInstalled = false;

function installJestHooks() {
  if (jestHooksInstalled || typeof jest === 'undefined') return;
  jestHooksInstalled = true;
  afterEach(cleanupAfterTest);
  afterAll(cleanupAll);
}

module.exports = {
  TEST_TMP_DIR,
  testPath,
  registerTemp,
  registerDerivedTemps,
  cleanupAfterTest,
  cleanupAll,
  cleanupTestTmpRoot,
  installJestHooks,
};
