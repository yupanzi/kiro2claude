## [1.4.4](https://github.com/yupanzi/kiro2claude/compare/v1.4.3...v1.4.4) (2026-07-30)


### Bug Fixes

* **kiro:** 升 kiro-cli fixture 到 2.15.2，统一向上走查 ([2a63eb1](https://github.com/yupanzi/kiro2claude/commit/2a63eb1236c61f4347a48f6a1e788302a7d4a841))

## [1.4.3](https://github.com/yupanzi/kiro2claude/compare/v1.4.2...v1.4.3) (2026-07-30)


### Bug Fixes

* **kiro:** auto-capture 逐级向上查找 capture 脚本 ([8acf3f6](https://github.com/yupanzi/kiro2claude/commit/8acf3f68713b5283e58e57aac58c392c72d795ae))

## [1.4.2](https://github.com/yupanzi/kiro2claude/compare/v1.4.1...v1.4.2) (2026-07-30)


### Bug Fixes

* **core:** 上游 5xx 容量不足改判可重试 503 ([88af8a4](https://github.com/yupanzi/kiro2claude/commit/88af8a4940efb8862a2db528129e59f2f2193e20))

## [1.4.1](https://github.com/yupanzi/kiro2claude/compare/v1.4.0...v1.4.1) (2026-07-28)


### Bug Fixes

* **core:** 修流式无声截断、空流重试判据与请求日志噪声 ([69b492a](https://github.com/yupanzi/kiro2claude/commit/69b492a45d7ed3c48fe6632a8f6551750b609bc4)), closes [#21](https://github.com/yupanzi/kiro2claude/issues/21) [#22](https://github.com/yupanzi/kiro2claude/issues/22)

# [1.4.0](https://github.com/yupanzi/kiro2claude/compare/v1.3.0...v1.4.0) (2026-07-25)


### Features

* 新增 Claude Opus 5 模型支持 ([dae497c](https://github.com/yupanzi/kiro2claude/commit/dae497c49e7eb636ca3876a13fe9d42b48591854))

# [1.3.0](https://github.com/yupanzi/kiro2claude/compare/v1.2.0...v1.3.0) (2026-07-15)


### Features

* OpenAI 协议回包注入 plugin usage 扩展 ([7e3021f](https://github.com/yupanzi/kiro2claude/commit/7e3021f7122cf488b6ce658c949faca5e0c6c8e4))
* 工具描述长度上限与断连主动 abort 上游 ([09bfacb](https://github.com/yupanzi/kiro2claude/commit/09bfacb5cecb6b8141988290d6cf8fc6d0ec857c))

# [1.2.0](https://github.com/yupanzi/kiro2claude/compare/v1.1.0...v1.2.0) (2026-07-14)


### Features

* GPT-5.6 credit 锚定反演 ([7ec15ed](https://github.com/yupanzi/kiro2claude/commit/7ec15ede302b77886dabf17e02bd968e06e12231))

# [1.1.0](https://github.com/yupanzi/kiro2claude/compare/v1.0.0...v1.1.0) (2026-07-14)


### Features

* 新增 OpenAI 双协议兼容层(Chat Completions + Responses) ([04156df](https://github.com/yupanzi/kiro2claude/commit/04156dfa563453a27fcd5da7fee10879123f6ded))

# 1.0.0 (2026-07-12)


### Features

* 初始化 kiro2claude 项目 ([78461c2](https://github.com/yupanzi/kiro2claude/commit/78461c28d775befbe63535ea92bdde8dc130b2a3))
