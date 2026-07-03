
module.exports = {
  testEnvironment: 'node',
  // Several suites seal/unseal 100–500MB files; jest's default 5s timeout
  // fails them before they get a chance to run.
  testTimeout: 300000,
  testMatch: [
    "**/test/*.spec.js"
  ],
  testPathIgnorePatterns: [
    "<rootDir>/test/Browser.*\\.spec\\.js$"
  ],
  roots: ['<rootDir>/test', '<rootDir>/src'],
  
  moduleFileExtensions: ['js', 'json', 'jsx'],
  setupFiles: ['<rootDir>/jest.setup.node.cjs'],
  setupFilesAfterEnv: ['<rootDir>/jest.hooks.cjs'],
  collectCoverage: true,
  coverageDirectory: 'coverage/node' 
};