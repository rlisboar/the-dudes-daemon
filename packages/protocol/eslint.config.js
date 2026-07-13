export default [
  {
    files: ["*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: { TextEncoder: "readonly", TextDecoder: "readonly" } },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-undef": "error",
    },
  },
  {
    files: ["*.test.js"],
    languageOptions: {
      globals: { Buffer: "readonly" },
    },
  },
];
