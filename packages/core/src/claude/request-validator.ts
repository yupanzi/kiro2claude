/**
 * Request-level validation and normalization.
 *
 * Holds the "thinking override from model name" rule, which the zod schema
 * can't express because it depends on `payload.thinking` being mutable after
 * parse.
 */

import { getLogger } from '../shared/logger.js';
import type { MessagesRequest } from './types.js';

/**
 * Check model name for a "thinking" suffix and override the thinking config.
 *
 * - Opus 4.6 / 4.7 / 4.8: adaptive type
 * - Other models: enabled type
 * - budget_tokens fixed at 20000 (schema later clamps to 24576 ceiling)
 *
 * Mutates `payload.thinking` and, for adaptive-capable Opus, `payload.output_config`.
 * This side-effect-on-input is intentional: the downstream converter reads
 * these fields without knowing about the model-name convention.
 */
export function overrideThinkingFromModelName(payload: MessagesRequest): void {
  const modelLower = payload.model.toLowerCase();
  if (!modelLower.includes('thinking')) return;

  // 注意:这是"thinking 类型是否为 adaptive"的判定,与 converter.ts 的
  // MODELS_WITH_NATIVE_REASONING("是否走原生 reasoning.effort wire 字段")是
  // 两个不同的事实 —— 4.6 在此为 adaptive,但 *不* 在 native 集合里,故走
  // <thinking_mode> prompt 注入路径(generateThinkingPrefix 读 output_config.effort)。
  // 两份版本清单必须随新增 Opus 版本一起更新,否则 thinking 路由会与 effort 处理脱节。
  const isAdaptiveOpus =
    modelLower.includes('opus') &&
    (modelLower.includes('4-6') ||
      modelLower.includes('4.6') ||
      modelLower.includes('4-7') ||
      modelLower.includes('4.7') ||
      modelLower.includes('4-8') ||
      modelLower.includes('4.8'));

  const thinkingType = isAdaptiveOpus ? 'adaptive' : 'enabled';

  getLogger().info({
    msg: 'thinking override from model name',
    model: payload.model,
    thinking_type: thinkingType,
  });

  payload.thinking = {
    type: thinkingType,
    budget_tokens: 20000,
  };

  if (isAdaptiveOpus) {
    payload.output_config = { effort: 'high' };
  }
}
