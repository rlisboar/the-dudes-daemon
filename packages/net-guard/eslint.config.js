export default [
  {
    files: ["*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: { URL: "readonly" } },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-undef": "error",
    },
  },
];
