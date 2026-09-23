/**
 * commitlint: 强制 conventional commits 格式
 *
 * 合法 type:
 *   feat / fix / docs / style / refactor / perf / test / chore / build / ci / revert
 *
 * subject: 不超过 72 字；首字母小写（除非专有名词）；不带句末标点
 */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'chore', 'build', 'ci', 'revert']
    ],
    'subject-case': [2, 'never', ['start-case', 'pascal-case']],
    'header-max-length': [2, 'always', 72]
  }
}