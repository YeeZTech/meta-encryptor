module.exports = {
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'mjs'],
  transform: {
    '^.+\\.(m?js)$': ['babel-jest', {
      configFile: './babel.config.cjs',
    }],
  },
  transformIgnorePatterns: [
    // transform noble secp for ESM export
    'node_modules/(?!(?:@noble/secp256k1)/)'
  ],
  testTimeout: 1000 * 60 * 10
};
