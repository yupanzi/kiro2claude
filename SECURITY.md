# 安全策略

## 报告漏洞

请**不要**为安全问题开公开 issue。

请在本仓库开启私有的 GitHub Security Advisory,或直接邮件联系维护者。

我们力争在 72 小时内确认收到,并在 7 天内对高危问题给出修复方案。

## 范围

本仓库包含开源的 core 网关与公开的插件契约。以下属于范围内:

- `packages/core/` 中的鉴权绕过 / API key 泄漏
- 构造的上游 payload 导致内存 / CPU 耗尽
- `@kiro2claude/plugin-api` 中允许插件逃逸其沙箱的缺陷

first-party 企业插件与工具单独分发,有各自的私有披露渠道。

## 支持的版本

仅支持最新的 `main`。我们不向旧 tag 回移安全修复。
