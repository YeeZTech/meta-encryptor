
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
  collectCoverage: true,
  coverageDirectory: 'coverage/node' 
};