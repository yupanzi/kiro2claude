# 为 kiro2claude 贡献

> 你正在看的公开仓库是一个**只读 mirror**。开发在一个私有 monorepo 中进行,每次推送到
> `main` 时由 `.github/workflows/sync-mirror.yml` 自动同步过来。同步会把开源子集**压成单个
> `Initial public release` commit 强制覆盖**公开历史——所以这里没有可累积的提交历史,直接在本
> mirror 上提的分支会在下次同步时被覆盖。

## 这里有什么(开源 / MIT)

- `packages/plugin-api/` —— 插件契约(类型 + 抽象基类,0 运行时依赖)
- `packages/core/` —— 网关 runtime
- `packages/plugin-metering/` —— 随镜像分发、默认启用的免费计量插件
- `packages/examples/echo-plugin/` —— 最小插件示范
- `docs/PLUGIN-DEVELOPMENT.md` —— 插件开发指南
- `docker/Dockerfile` —— 公开镜像构建

全部以 [MIT](./LICENSE) 许可证发布,可商用,使用时保留版权与许可声明即可。

## 这里没有什么(企业版 / 闭源)

first-party 企业插件与部署工具在独立的闭源仓,通过私有渠道分发。core 网关不依赖它们即可独立运行,且符合标准 Anthropic API。

## 怎么贡献

### 报告 bug / 提需求

在本 mirror 开 issue,会被审阅并转入上游私有仓处理。

### Pull Request

本 mirror 的 PR **可读但无法在此合并**(每次上游提交都会强制覆盖公开历史,你的分支会被冲掉)。维护者会:

1. 阅读 PR
2. 把补丁 cherry-pick 进上游私有 monorepo
3. 合并后回复对应的上游 commit
4. 关闭 mirror PR

所以**提交信息与 PR 描述很重要**——它们是 cherry-pick 之后唯一留存的信号。

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
