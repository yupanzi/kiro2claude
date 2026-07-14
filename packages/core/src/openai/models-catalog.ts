/**
 * OpenAI `GET /openai/v1/models` 目录。
 *
 * 单一真相源复用 claude/models-catalog.ts 的 `MODELS`(GPT + Claude 全量),
 * 转成 OpenAI `/v1/models` 形状。`owned_by` 沿用条目自身的值(gpt→openai,
 * claude→anthropic)。OpenAI 端点服务全部模型,任意 OpenAI SDK 客户端可用。
 */

import { MODELS } from '../claude/models-catalog.js';
import type { OpenAiModel, OpenAiModelsResponse } from './types.js';

/** 把 Claude 目录条目转成 OpenAI model 形状。 */
function toOpenAiModel(m: (typeof MODELS)[number]): OpenAiModel {
  return {
    id: m.id,
    object: 'model',
    created: m.created,
    owned_by: m.owned_by,
  };
}

/** 静态目录:模块加载时构建一次,只读共享(每个 GET /models 直接返回)。 */
const OPENAI_MODELS_RESPONSE: OpenAiModelsResponse = {
  object: 'list',
  data: MODELS.map(toOpenAiModel),
};

/** OpenAI `/models` 响应(list 形状)。 */
export function getOpenAiModelsResponse(): OpenAiModelsResponse {
  return OPENAI_MODELS_RESPONSE;
}
