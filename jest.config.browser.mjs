
export default {
  testEnvironment: 'jsdom',
  testMatch: [
    "<rootDir>/test/Browser*.spec.mjs"
  ],
  
  roots: ['<rootDir>/test', '<rootDir>/src'],
  
  moduleFileExtensions: ['mjs', 'js', 'json', 'jsx'],
  // Use babel-jest for transforming test files; ESM mode controlled via globals
  transform: {},
  transformIgnorePatterns: [],
  extensionsToTreatAsEsm: [],
  // Keep node_modules mostly ignored; allow explicit transforms only when necessary.
  /*
  transformIgnorePatterns: [
    '/node_modules/'
  ],
  */
  
  globals: {
    'process.env.BROWSER': true,
    window: true, // 显式启用 window 全局对象
    document: true // 显式启用 document 全局对象
  },
  testEnvironmentOptions: {
    customExportConditions: ['node', 'module']
  },
  setupFilesAfterEnv: ["<rootDir>/jest.setup.browser.mjs"],
  collectCoverage: true,
  coverageDirectory: 'coverage/browser' 
};