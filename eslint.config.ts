import globals from 'globals'
import { globalIgnores } from 'eslint/config'
import pluginJs from '@eslint/js'
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import eslintConfigPrettier from 'eslint-config-prettier'
import eslintPluginPrettier from 'eslint-plugin-prettier'

/** 需要类型信息的规则（仅适用于 tsconfig project 内的文件） */
const typedRules = {
  '@typescript-eslint/no-explicit-any': 'warn',
  '@typescript-eslint/no-unused-vars': 'warn',
  '@typescript-eslint/no-unsafe-argument': 'warn',
  '@typescript-eslint/no-unsafe-assignment': 'warn',
}

/** 把 typedRules 全部关掉（用于不在 tsconfig project 内的脚本） */
const untypedRules = Object.fromEntries(Object.keys(typedRules).map((rule) => [rule, 'off']))

export default [
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    languageOptions: {
      globals: globals.node,
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        projectService: {
          allowDefaultProject: ['*.config.ts'], // 根目录的 .config.ts 文件
        },
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      prettier: eslintPluginPrettier,
    },
    rules: {
      ...pluginJs.configs.recommended.rules,
      'no-unused-vars': 'off',
      ...typedRules,
      'prettier/prettier': 'error',
    },
  },
  eslintConfigPrettier,
  // tests/e2e 下的全链路脚本是**直接跑 node/tsx 的 ESM 脚本**（.mjs 不在 tsconfig project 内），
  // 关闭类型感知即可 lint（tsx 运行的 .ts 脚本仍走上面的类型感知配置）
  {
    files: ['tests/e2e/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: globals.node,
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        // 这些 .mjs 不在 tsconfig project 内 → 关闭类型感知（否则 projectService 报 parsing error）
        projectService: false,
      },
    },
    rules: {
      ...pluginJs.configs.recommended.rules,
      ...untypedRules,
      'no-unused-vars': 'off',
      'prettier/prettier': 'error',
    },
  },
  // tmp/ 为本地临时产物（已 gitignore，不在任何 tsconfig project 内），不参与 lint
  globalIgnores(['**/dist/**', '**/dist-ssr/**', '**/coverage/**', 'tmp/**']),
]
