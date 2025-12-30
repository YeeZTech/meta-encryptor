module.exports = {
  presets: [
    ['@babel/preset-env', (function(){
      const isTest = process.env.BABEL_ENV === 'test' || process.env.NODE_ENV === 'test';
      return {
        targets: {
          node: '18',
          browsers: ['last 2 versions', 'ie >= 11', 'iOS >= 12', 'Android >= 8']
        },
        useBuiltIns: 'usage',
        corejs: 3,
        modules: isTest ? 'commonjs' : false,
      };
    })()],
  ],
};