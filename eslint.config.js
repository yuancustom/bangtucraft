import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "_extract/**",
      "_tools/**",
      "data/**",
      "skills/vendor-bangtu/**",
      "packages/search-mcp/searxng/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["apps/server/**", "packages/**", "scripts/**", "*.js", "*.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["apps/web/src/**"],
    languageOptions: { globals: globals.browser },
  },
  {
    rules: {
      // 与 Mastra 动态类型交互时需要少量 any。
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
