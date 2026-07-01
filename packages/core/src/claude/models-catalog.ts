/**
 * Static model catalog for `GET /claude/v1/models`.
 *
 * The catalog is a literal data table — when Claude ships a new model,
 * add an entry here and re-run `pnpm test`.
 */

import type { Model, ModelsResponse } from './types.js';

/** Full list of Claude model identifiers exposed by this proxy. */
export const MODELS: Model[] = [
  {
    id: 'claude-opus-4-8',
    object: 'model',
    created: 1779840000,
    owned_by: 'anthropic',
    display_name: 'Claude Opus 4.8',
    type: 'chat',
    max_tokens: 64000,
  },
  {
    id: 'claude-opus-4-8-thinking',
    object: 'model',
    created: 1779840000,
    owned_by: 'anthropic',
    display_name: 'Claude Opus 4.8 (Thinking)',
    type: 'chat',
    max_tokens: 64000,
  },
  {
    id: 'claude-opus-4-7',
    object: 'model',
    created: 1776384000,
    owned_by: 'anthropic',
    display_name: 'Claude Opus 4.7',
    type: 'chat',
    max_tokens: 64000,
  },
  {
    id: 'claude-opus-4-7-thinking',
    object: 'model',
    created: 1776384000,
    owned_by: 'anthropic',
    display_name: 'Claude Opus 4.7 (Thinking)',
    type: 'chat',
    max_tokens: 64000,
  },
  {
    id: 'claude-opus-4-6',
    object: 'model',
    created: 1770336000,
    owned_by: 'anthropic',
    display_name: 'Claude Opus 4.6',
    type: 'chat',
    max_tokens: 64000,
  },
  {
    id: 'claude-opus-4-6-thinking',
    object: 'model',
    created: 1770336000,
    owned_by: 'anthropic',
    display_name: 'Claude Opus 4.6 (Thinking)',
    type: 'chat',
    max_tokens: 64000,
  },
  {
    id: 'claude-sonnet-5',
    object: 'model',
    created: 1781481600,
    owned_by: 'anthropic',
    display_name: 'Claude Sonnet 5',
    type: 'chat',
    max_tokens: 64000,
  },
  {
    id: 'claude-sonnet-5-thinking',
    object: 'model',
    created: 1781481600,
    owned_by: 'anthropic',
    display_name: 'Claude Sonnet 5 (Thinking)',
    type: 'chat',
    max_tokens: 64000,
  },
  {
    id: 'claude-sonnet-4-6',
    object: 'model',
    created: 1771372800,
    owned_by: 'anthropic',
    display_name: 'Claude Sonnet 4.6',
    type: 'chat',
    max_tokens: 64000,
  },
  {
    id: 'claude-sonnet-4-6-thinking',
    object: 'model',
    created: 1771372800,
    owned_by: 'anthropic',
    display_name: 'Claude Sonnet 4.6 (Thinking)',
    type: 'chat',
    max_tokens: 64000,
  },
  {
    id: 'claude-opus-4-5-20251101',
    object: 'model',
    created: 1761955200,
    owned_by: 'anthropic',
    display_name: 'Claude Opus 4.5',
    type: 'chat',
    max_tokens: 64000,
  },
  {
    id: 'claude-opus-4-5-20251101-thinking',
    object: 'model',
    created: 1761955200,
    owned_by: 'anthropic',
    display_name: 'Claude Opus 4.5 (Thinking)',
    type: 'chat',
    max_tokens: 64000,
  },
  {
    id: 'claude-sonnet-4-5-20250929',
    object: 'model',
    created: 1759104000,
    owned_by: 'anthropic',
    display_name: 'Claude Sonnet 4.5',
    type: 'chat',
    max_tokens: 64000,
  },
  {
    id: 'claude-sonnet-4-5-20250929-thinking',
    object: 'model',
    created: 1759104000,
    owned_by: 'anthropic',
    display_name: 'Claude Sonnet 4.5 (Thinking)',
    type: 'chat',
    max_tokens: 64000,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    object: 'model',
    created: 1759276800,
    owned_by: 'anthropic',
    display_name: 'Claude Haiku 4.5',
    type: 'chat',
    max_tokens: 64000,
  },
  {
    id: 'claude-haiku-4-5-20251001-thinking',
    object: 'model',
    created: 1759276800,
    owned_by: 'anthropic',
    display_name: 'Claude Haiku 4.5 (Thinking)',
    type: 'chat',
    max_tokens: 64000,
  },
];

/** Shape the catalog as the `list`-typed response expected by clients. */
export function getModelsResponse(): ModelsResponse {
  return {
    object: 'list',
    data: MODELS,
  };
}
