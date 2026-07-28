import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import polyfillNode from "rollup-plugin-polyfill-node";
import { babel as rollupBabel } from '@rollup/plugin-babel';
import fs from 'fs';
import path from 'path';

const packageJson = JSON.parse(fs.readFileSync(path.resolve('./package.json'), 'utf-8'));
// optionalDependencies 也必须 external：keccak 是原生 addon，一旦被内联进 bundle，
// 它内部 node-gyp-build 的 __dirname 就指向 bundle 目录，找不到 .node 而静默退回纯 JS。
const externalDeps = [
  ...Object.keys(packageJson.dependencies || {}),
  ...Object.keys(packageJson.optionalDependencies || {}),
  ...Object.keys(packageJson.peerDependencies || {})
];

const nodeConfig = {
  input: [
    "src/index.node.js",
    "src/utils.js"
  ],
  plugins: [
    resolve({
      browser: false,
      preferBuiltins: true,
      exportConditions: ['node', 'default']
    }),
    json(),
    commonjs({
      include: [
        /node_modules/,
        "src/**",
      ],
      transformMixedEsModules: true
    }),
  ],
  output: [
    {
      dir: "build/es",
      format: "es",
      entryFileNames: "[name].js",
      exports: "named"
    },
    {
      dir: "build/commonjs",
      entryFileNames: "[name].cjs",
      chunkFileNames: "[name]-[hash].cjs",
      format: "cjs",
    },
  ],
  external: externalDeps,
};

const browserConfig = {
  input: "src/index.browser.js",
  plugins: [
    polyfillNode({
      exclude: ['crypto'],
    }),
    resolve({
      browser: true,
      preferBuiltins: false,
      exportConditions: ['browser', 'default']
    }),
    json(),
    commonjs({
      include: [
        /node_modules/,
        "src/**",
      ],
      transformMixedEsModules: true
    }),
    rollupBabel({
      babelHelpers: 'bundled',
      babelrc: false,
      presets: [
        [
          '@babel/preset-env',
          {
            targets: '>0.25%, not dead',
            modules: false
          }
        ]
      ],
      include: [
        'src/**',
        'node_modules/aes-js/**'
      ]
    }),
  ],
  output: {
    file: "build/es/index.browser.js",
    format: "es",
    exports: "named",
    inlineDynamicImports: true,
  },
  external: [],
};

export default [nodeConfig, browserConfig];
