import { describe, expect, it } from 'vitest';
import {
  createToolUseEntry,
  defaultInputSchema,
  toolResultError,
  toolResultSuccess,
} from '../../../../src/kiro/model/requests/tool.js';

describe('ToolResult', () => {
  it('test_tool_result_success', () => {
    const result = toolResultSuccess('tool-123', 'Operation completed');
    expect(result.isError).toBe(false);
    expect(result.status).toBe('success');
  });

  it('test_tool_result_error', () => {
    const result = toolResultError('tool-456', 'File not found');
    expect(result.isError).toBe(true);
    expect(result.status).toBe('error');
  });

  it('test_tool_result_serialize', () => {
    const result = toolResultSuccess('tool-789', 'Done');
    const json = JSON.stringify(result);
    expect(json).toContain('"toolUseId":"tool-789"');
    expect(json).toContain('"status":"success"');
    // `isError` is always serialized (including when false), so assert
    // on the presence of the explicit `"isError":false` field rather than
    // its absence. This is intentional: the Kiro backend accepts both
    // forms, and emitting the field explicitly is less surprising to read.
    expect(json).toContain('"isError":false');
  });
});

describe('ToolUseEntry', () => {
  it('test_tool_use_entry', () => {
    const entry = createToolUseEntry('use-123', 'read_file', { path: '/test.txt' });
    const json = JSON.stringify(entry);
    expect(json).toContain('"toolUseId":"use-123"');
    expect(json).toContain('"name":"read_file"');
    expect(json).toContain('"path":"/test.txt"');
  });
});

describe('InputSchema', () => {
  it('test_input_schema_default', () => {
    const schema = defaultInputSchema();
    expect((schema.json as { type: string }).type).toBe('object');
  });
});
