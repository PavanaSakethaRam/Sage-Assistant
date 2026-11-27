import tseslint from "typescript-eslint";
export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      ".vite/**",
      "out/**",
      "graphify-out/**",
      "docs/**",
      ".superpowers/**",
      ".venv/**",
      ".runtime/**",
      ".cache/**",
      "coverage/**",
      "extension/dist/**",
      "extension/test/driver/dist/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["desktop/**/*.{ts,tsx}", "extension/**/*.ts", "*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
);
