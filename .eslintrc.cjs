/*
 * ESLint 配置
 *
 * 范围：
 *   client/.ts, client/.vue
 *   server/.ts
 *
 * 风格：宽松实用，避免 prettier 重复规则
 *   Vue: 官方 vue-eslint-parser + vue3-recommended
 *   TS:  @typescript-eslint 推荐 + 关闭 no-unused-vars
 */
module.exports = {
  root: true,
  env: {
    browser: true,
    node: true,
    es2022: true
  },
  parser: 'vue-eslint-parser',
  parserOptions: {
    parser: '@typescript-eslint/parser',
    ecmaVersion: 'latest',
    sourceType: 'module',
    extraFileExtensions: ['.vue']
  },
  plugins: ['@typescript-eslint', 'vue'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:vue/vue3-recommended'
  ],
  rules: {
    // TS 推荐太严，开发体验差
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-non-null-assertion': 'off',

    // Vue: scoped css 不要求 prop 验证
    'vue/multi-word-component-names': 'off',
    'vue/html-self-closing': 'off',
    'vue/max-attributes-per-line': 'off',
    'vue/singleline-html-element-content-newline': 'off',
    'vue/html-indent': 'off',
    'vue/html-closing-bracket-newline': 'off',
    'vue/attributes-order': 'off',
    'vue/first-attribute-linebreak': 'off',
    'vue/no-v-html': 'off',

    // 通用
    'no-console': 'off',
    'no-empty': ['error', { allowEmptyCatch: true }],
    'prefer-const': 'warn'
  },
  overrides: [
    {
      // 测试文件宽松
      files: ['server/tests/**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off'
      }
    },
    {
      // 配置类 .cjs
      files: ['*.cjs'],
      parserOptions: { sourceType: 'script' }
    }
  ]
}