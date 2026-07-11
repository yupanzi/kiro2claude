// Conventional Commits 校验配置(配合 .husky/commit-msg 钩子)。
// 提交规范说明见 CONTRIBUTING.md 的「提交规范」节。
//
// 中文适配:
// - subject-case 关闭——大小写是 ASCII 概念,对中文无意义,且会误判中英混排的主题。
// - 行长规则放宽——CJK 字符更"占行",正文/脚注按 warning 处理,不阻断提交。
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'subject-case': [0],
    'header-max-length': [2, 'always', 120],
    'body-max-line-length': [1, 'always', 200],
    'footer-max-line-length': [1, 'always', 200],
  },
};
