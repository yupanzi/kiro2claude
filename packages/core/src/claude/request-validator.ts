/**
 * Request-level validation and normalization.
 *
 * Holds the "thinking override from model name" rule, which the zod schema
 * can't express because it depends on `payload.thinking` being mutable after
 * parse. Only adaptive thinking exists (budget_tokens unsupported).
 */

import { getLogger } from '../shared/logger.js';
import type { MessagesRequest } from './types.js';

/**
 * Check model name for a "thinking" suffix and turn thinking on.
 *
 * 只有 adaptive 一种语义(`budget_tokens` 不支持):`-thinking` 后缀 =
 * `thinking:{type:"adaptive"}`,effort 取客户端已给的 `output_config.effort`,没给则 high。
 * 只对原生 reasoning 模型有效(落到顶层 `additionalModelRequestFields`);非原生模型不做
 * thinking 控制,后缀对它们是空操作。这里不区分模型,路由在 converter 的 `usesNativeReasoning`。
 *
 * Mutates `payload.thinking` / `payload.output_config`. This side-effect-on-input is
 * intentional: the downstream converter reads these fields without knowing about
 * the model-name convention.
 */
export function overrideThinkingFromModelName(payload: MessagesRequest): void {
  const modelLower = payload.model.toLowerCase();
  if (!modelLower.includes('thinking')) return;

  getLogger().info({
    msg: 'thinking override from model name',
    model: payload.model,
    thinking_type: 'adaptive',
  });

  payload.thinking = { type: 'adaptive' };
  payload.output_config ??= { effort: 'high' };
}
