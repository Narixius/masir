import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core, antiSlop],
  ignorePatterns: [...(core.ignorePatterns ?? []), "src/xray/proto/**", "src/injectables/xray/proto/**"],
  rules: {
    "anti-slop/no-runtime-typeof": "off",
    "anti-slop/no-unsafe-dictionary-type": "off",
    "anti-slop/require-safety-comment-for-type-assertion": "off",
    "eslint/max-classes-per-file": "off",
    "no-shadow": "off",
    "sort-keys": "off",
    "promise/prefer-await-to-callbacks": "off",
    "promise/prefer-await-to-then": "off",
    "func-names": "off",
    "promise/avoid-new": "off",
    "promise/valid-params": "off",
    "unicorn/import-style": "off",
  },
});
