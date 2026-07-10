const fs = require('node:fs');
const path = require('node:path');
const {
  cleanupAll,
  cleanupTestTmpRoot,
  registerTemp,
  testPath,
} = require('./tempRegistry.cjs');

test('cleanup never removes unregistered files from the repository root', () => {
  const sentinel = path.resolve('user-data.sealed');
  fs.writeFileSync(sentinel, 'keep');
  try {
    cleanupAll();
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('keep');
  } finally {
    fs.rmSync(sentinel, { force: true });
  }
});

test('only paths below test_tmp can be registered', () => {
  expect(() => registerTemp(path.resolve('outside.tmp'))).toThrow(
    /outside test_tmp/
  );
});

test('registered test_tmp artifacts are removed', () => {
  const temp = testPath('registry', 'artifact.bin');
  fs.mkdirSync(path.dirname(temp), { recursive: true });
  fs.writeFileSync(temp, 'temporary');
  cleanupAll();
  expect(fs.existsSync(temp)).toBe(false);
  cleanupTestTmpRoot();
});
