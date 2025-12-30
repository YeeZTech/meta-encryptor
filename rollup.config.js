import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import polyfillNode from "rollup-plugin-polyfill-node";
import { babel as rollupBabel } from '@rollup/plugin-babel';
import fs from 'fs';
import path from 'path';

const packageJson = JSON.parse(fs.readFileSync(path.resolve('./package.json'), 'utf-8'));
const externalDeps = [
  ...Object.keys(packageJson.dependencies || {}),
  ...Object.keys(packageJson.peerDependencies || {})
];

// Node build should treat package deps as external.
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

// Browser build should bundle most deps and include node polyfills;
const browserConfig = {
  input: [
    "src/index.browser.js"
  ],
  plugins: [
    polyfillNode(), // provide buffer/stream/process/crypto shims for browser
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
    // Transpile problematic node_modules (aes-js) for browser
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
  output: [
    {
      dir: "build/es",
      format: "es",
      entryFileNames: "[name].browser.js",
      exports: "named"
    }
  ],
  // keep browser bundle self-contained; do not mark regular deps as external
  external: externalDeps //Object.keys(packageJson.peerDependencies || {}),
}
export default [nodeConfig, browserConfig];
