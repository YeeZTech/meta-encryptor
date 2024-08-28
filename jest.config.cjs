module.exports = {
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'mjs'],
  transform: {
    '^.+\\.(m?js)$': ['babel-jest', {
      configFile: './babel.config.cjs',
    }],
  },
  testTimeout: 1000 * 60 * 3
};
