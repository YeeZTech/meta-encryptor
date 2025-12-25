import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
export default {
  input: [
    "src/index.node.js",
    "src/index.browser.js",
    "src/utils.js"
  ],
  plugins: [
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
    },
    {
      dir: "build/commonjs",
      entryFileNames: "[name].cjs",
      chunkFileNames: "[name]-[hash].cjs",
      format: "cjs",
    },
  ],
};
