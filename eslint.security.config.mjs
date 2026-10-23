import base from "./eslint.config.mjs";
import security from "eslint-plugin-security";
export default [
  ...base,
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    plugins: { security },
    rules: Object.fromEntries(
      Object.keys(security.configs.recommended.rules).map((name) => [
        name,
        "warn",
      ]),
    ),
  },
];
