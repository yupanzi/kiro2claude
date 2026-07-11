# 为 kiro2claude 贡献

kiro2claude 是一个 **MIT 开源**项目,本仓库就是主开发仓——直接在这里提 issue 和 PR。

## 仓库内容(全部 MIT)

- `packages/plugin-api/` —— 插件契约(类型 + 抽象基类,0 运行时依赖)
- `packages/core/` —— 网关 runtime
- `packages/plugin-metering/` —— 随镜像默认启用的计量插件(注入 `usage.kiro_metering`)
- `packages/plugin-derived/` —— 随镜像默认启用的 credit 反演插件(注入 `usage.kiro_derived`)
- `packages/examples/echo-plugin/` —— 最小插件示范
- `tools/claude-code/` —— Claude Code 兼容性测试 harness(Docker,非 runtime)
- `docs/PLUGIN-DEVELOPMENT.md` —— 插件开发指南
- `docker/Dockerfile` —— 发布镜像构建(CI 推 ghcr.io)

全部以 [MIT](./LICENSE) 许可证发布,可商用,使用时保留版权与许可声明即可。core 网关不依赖任何私有组件即可独立运行,且符合标准 Anthropic API。

## 怎么贡献

### 报告 bug / 提需求

直接在本仓库开 issue。

### Pull Request

1. fork + 从 `main` / `master` 建分支
2. 改动,并确保 `pnpm run check`、`pnpm -r typecheck`、`pnpm -r test` 全绿(pre-commit 钩子也会强制这三道)
3. 提 PR;CI(`.github/workflows/ci.yml`)会在全 workspace 跑 lint + typecheck + test
4. 维护者审阅、合并

## 提交规范

提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/),由 `commit-msg` 钩子经 commitlint 校验(配置见 `commitlint.config.js`)。格式:

```text
<type>(<scope>): <主题>
```

- **type**(必填,小写英文):`feat` 新功能、`fix` 修复、`docs` 文档、`style` 格式、`refactor` 重构、`perf` 性能、`test` 测试、`build` 构建/依赖、`ci` CI、`chore` 杂项、`revert` 回滚。
- **scope**(可选,自由):如 `core`、`plugin-api`、`plugin-metering`、`kiro`、`claude`、`routes`、`plugin-host`、`docker`、`docs` 等。
- **主题**:祈使句、简洁、句末不加句号;中英文皆可(大小写校验已对中文关闭)。

示例:

```text
feat(core): 支持 claude-opus-4.8 原生 reasoning
fix(kiro): 修复 token 到期刷新写回 SQLite
docs: 补充 plugin 加载顺序说明
```

`pnpm install` 后会自动启用 `.gitmessage` 模板(执行 `git commit` 不带 `-m` 时弹出引导)。

## 版本与发布

版本发布**全自动**,由 [semantic-release](https://semantic-release.gitbook.io/) 驱动——维护者**无需**手动改版本号或打 tag。每次 push 到 `master`,`.github/workflows/release.yml` 会:

1. 跑发布门禁(`check` + `typecheck` + `build` + `test`,与 CI 同一套);
2. semantic-release 分析自上次发布以来的 commit,按 [Conventional Commits](https://www.conventionalcommits.org/) 决定版本号:
   - `fix:` → patch(`x.y.Z`)
   - `feat:` → minor(`x.Y.0`)
   - 提交体含 `BREAKING CHANGE:`(或 `type` 后加 `!`)→ major(`X.0.0`)
   - `docs:` / `chore:` / `ci:` / `refactor:` / `test:` / `style:` 等**不触发发版**
3. 自动写回 `packages/core/package.json.version`、生成 `CHANGELOG.md`、打 `vX.Y.Z` tag、建 GitHub Release,并构建镜像推送到 `ghcr.io/<owner>/kiro2claude:X.Y.Z` 与 `:latest`。

> **插件包版本手动管理**:`@kiro2claude/plugin-api`(契约包)、`plugin-metering`、`plugin-derived` 的版本号是**契约语义版本**,与镜像发布解耦,不由 semantic-release 自动 bump——改动契约时在对应 `package.json` 里手动 bump(尤其 plugin-api 的破坏性改动 = major,会级联影响所有插件作者)。

本地可 `pnpm run release:dry` 预演发版(dry-run,不推送、不建镜像)。

## 写插件

扩展 kiro2claude 不需要改动 core——实现 `@kiro2claude/plugin-api` 契约、打成自己的包即可。本项目不发布到 npm,获取契约的方式:clone 本仓库后在其 pnpm workspace 内开发,或参照 [`packages/plugin-api/`](./packages/plugin-api/) 的契约类型自行实现。详见 [`docs/PLUGIN-DEVELOPMENT.md`](./docs/PLUGIN-DEVELOPMENT.md)。

## 本地开发

```bash
pnpm install            # 同时装好 husky 钩子(pre-commit + commit-msg)
pnpm -r run typecheck
pnpm -r run test
pnpm run check          # biome lint + format(不写盘)
pnpm run lint:md        # markdown 样式
```

`pnpm dev` 启动 core 网关并热重载。不装任何插件时只服务 `/claude/v1/*`——这就是裸默认形态。

## 许可证

本仓库内所有内容以 [MIT](./LICENSE) 许可证发布,Copyright (c) 2026 yupanzi。
