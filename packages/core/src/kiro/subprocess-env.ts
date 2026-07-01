/**
 * 为 kiro-cli 子进程构造环境变量。
 *
 * 由 `bootstrap-login.ts`（device flow 登录）和 `auto-capture.ts`
 * （启动期 client profile 抓取）共用——两者都需要 spawn 真实的
 * `kiro-cli` 二进制，并且都踩到了同一个坑：
 *
 * **KIRO2CLAUDE_API_KEY 命名空间冲突**。kiro-cli（Rust Amazon Q CLI）把
 * `KIRO2CLAUDE_API_KEY` 视为"用户已用 API key 认证"，会让 `whoami` 返回
 * Authenticated 并让 `login` 拒绝执行（"Already logged in"）。而
 * kiro2claude 这边把它当作下游 Claude 客户端的鉴权 key——完全不同
 * 的语义，但公用一个环境变量名。
 *
 * 顺便把 `KIRO2CLAUDE_LOGIN_*` 也清理掉：kiro-cli 目前不读它们，但这些
 * 是 kiro2claude 专属的配置，没必要泄漏到子进程。
 */

/** 返回一份剥掉 `KIRO2CLAUDE_API_KEY` / `KIRO2CLAUDE_LOGIN_*` 的 process.env 副本 */
export function cleanKiroCliEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'KIRO2CLAUDE_API_KEY') continue;
    if (k.startsWith('KIRO2CLAUDE_LOGIN_')) continue;
    out[k] = v;
  }
  return out;
}
