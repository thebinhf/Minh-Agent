import js from "@eslint/js";

/** ESLint covers static browser JS only; TypeScript is checked via `tsc`. */
export default [
  {
    ignores: ["dist/**", "node_modules/**", "src/**", "test/**"],
  },
  {
    ...js.configs.recommended,
    files: ["public/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        document: "readonly",
        fetch: "readonly",
        window: "readonly",
        console: "readonly",
      },
    },
  },
];
