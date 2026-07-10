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

const STALE_ROOT_NAMES = new Set([
  'small.file',
  'medium.file',
  'large.file',
  'Unsealerlarge.file',
  'BrowserUnsealerLarge.file',
  'test.remote.xUnsealerlarge.file',
  'SealedFileStream.xlarge.file',
  'SealedFileStream.xlarge.file.copy',
  'test_context',
  'pause_resume_large.file',
  'pause_resume_large_context',
  'pause_resume_large.rand.file',
  'pause_resume_large_context.rand',
  'pause_resume_large.same.file',
  'pause_resume_large_context.same',
  'multi_pause_resume_large.rand_same.file',
  'multi_pause_resume_large_context.rand_same',
  'final_verify_context',
  'truncate_residual_test.file',
  'truncate_residual_context',
]);

const STALE_ROOT_PREFIXES = [
  'pause_resume_large.',
  'multi_pause_resume_large.',
];

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

function cleanupStaleRootArtifacts(cwd = process.cwd()) {
  let entries = [];
  try {
    entries = fs.readdirSync(cwd, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const name = ent.name;
    if (STALE_ROOT_NAMES.has(name)) {
      rmSafe(path.join(cwd, name));
      continue;
    }
    if (STALE_ROOT_PREFIXES.some((pfx) => name.startsWith(pfx))) {
      rmSafe(path.join(cwd, name));
      continue;
    }
    if (!ent.isFile()) continue;
    if (/\.(sealed|sealed\.ret|unsealed\.ret|util\.sealed)$/.test(name)) {
      rmSafe(path.join(cwd, name));
    }
  }
}

function cleanupAll() {
  cleanupRegistered();
  cleanupStaleRootArtifacts();
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
  cleanupStaleRootArtifacts,
  installJestHooks,
};
