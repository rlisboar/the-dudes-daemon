export default [
  {
    files: ["*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: { process: "readonly", console: "readonly", URL: "readonly", setTimeout: "readonly" } },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-undef": "error",
    },
  },
  {
    files: ["*.test.js"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly", setTimeout: "readonly" } },
  },
];
