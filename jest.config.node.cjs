
module.exports = {
  testEnvironment: 'node',
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