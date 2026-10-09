const js = require("@eslint/js");
const globals = require("globals");

// Flat config (ESLint 9+). Backend is CommonJS on Node 24; tests run in Jest.
// Formatting is Prettier's job (see root .prettierrc), so no stylistic rules.
module.exports = [
  { ignores: ["node_modules", "coverage", "data/vendor"] },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: globals.node,
    },
    rules: {
      ...js.configs.recommended.rules,
      // The codebase intentionally uses empty catch blocks for best-effort
      // cleanup (e.g. AbortController.abort()); allow them when commented.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Underscore prefix marks intentionally unused bindings (e.g. the
      // `_ch` loop variable in formatHuman's displayWidth).
      "no-unused-vars": [
        "error",
        {
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["__tests__/**/*.js", "jest.setup.js"],
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
    },
  },
];
