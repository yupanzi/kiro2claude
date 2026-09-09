import { describe, expect, it } from 'vitest';
import { convertRequest } from '../../../src/claude/converter.js';
import type { MessagesRequest } from '../../../src/claude/types.js';
import { serializeKiroRequest } from '../../../src/kiro/model/requests/kiro.js';
import { convertResponsesRequest } from '../../../src/openai/responses/converter.js';
import type { ResponsesRequest } from '../../../src/openai/responses/types.js';

const PNG_A = 'data:image/png;base64,QUJDRA==';
const PNG_B = 'data:image/png;base64,WllYWA==';

function serializeState(request: MessagesRequest) {
  const { conversationState } = convertRequest(request, { identityOverride: false });
  return JSON.parse(serializeKiroRequest({ conversationState })).conversationState;
}

function responsesState(request: ResponsesRequest) {
  return serializeState(convertResponsesRequest(request).payload);
}

function currentWire(request: ResponsesRequest) {
  return responsesState(request).currentMessage.userInputMessage;
}

function imagePart(imageUrl: string) {
  return { type: 'input_image' as const, image_url: imageUrl };
}

describe('Responses multi-image boundaries', () => {
  it('does not alter the single-image content contract', () => {
    const wire = currentWire({
      model: 'gpt-5.6-sol',
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'Inspect it.' }, imagePart(PNG_A)],
        },
      ],
    });

    expect(wire.content).toBe('Inspect it.');
    expect(wire.images).toEqual([{ format: 'png', source: { bytes: 'QUJDRA==' } }]);
  });

  it.each([
    'low',
    'medium',
    'high',
  ])('keeps identical image items independently addressable at %s effort', (effort) => {
    const wire = currentWire({
      model: 'gpt-5.6-sol',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Inspect every supplied image.' },
            imagePart(PNG_A),
            imagePart(PNG_A),
          ],
        },
      ],
      reasoning: { effort },
    });

    expect(wire.images).toHaveLength(2);
    expect(wire.images[0]).toEqual(wire.images[1]);
    expect(wire.content).toContain(
      '[Image 1: independent input; source=user message; content index=1]',
    );
    expect(wire.content).toContain(
      '[Image 2: independent input; source=user message; content index=2]',
    );
    expect(wire.content).toContain('Images 1-2 are separate inputs, not tiles of one canvas.');
    expect(wire.reasoning).toEqual({ effort });
  });

  it('keeps different images ordered and restores interleaved content positions', () => {
    const wire = currentWire({
      model: 'gpt-5.6-sol',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'before' },
            imagePart(PNG_A),
            { type: 'input_text', text: 'between' },
            imagePart(PNG_B),
            { type: 'input_text', text: 'after' },
          ],
        },
      ],
    });

    expect(wire.images.map((image: { source: { bytes: string } }) => image.source.bytes)).toEqual([
      'QUJDRA==',
      'WllYWA==',
    ]);
    expect(wire.content).toBe(
      [
        'before',
        '[Image 1: independent input; source=user message; content index=1]',
        'between',
        '[Image 2: independent input; source=user message; content index=3]',
        'after',
        'Images 1-2 are separate inputs, not tiles of one canvas.',
      ].join('\n'),
    );
  });

  it('associates multiple tool output images with their tool result', () => {
    const wire = currentWire({
      model: 'gpt-5.6-sol',
      input: [
        { role: 'user', content: 'Load both screenshots.' },
        {
          type: 'function_call',
          call_id: 'call_images',
          name: 'view_images',
          arguments: '{}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_images',
          output: [imagePart(PNG_A), imagePart(PNG_B)],
        },
      ],
    });
    const resultText = wire.userInputMessageContext.toolResults[0].content[0].text;

    expect(wire.images).toHaveLength(2);
    expect(resultText).toContain(
      '[Image 1: independent input; source=user message tool result "call_images"; content index=0]',
    );
    expect(resultText).toContain(
      '[Image 2: independent input; source=user message tool result "call_images"; content index=1]',
    );
    expect(wire.content).toBe('Images 1-2 are separate inputs, not tiles of one canvas.');
  });

  it('keeps a user attachment distinct from a tool result image in the same turn', () => {
    const state = serializeState({
      model: 'gpt-5.6-sol',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'Load the generated screenshot.' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_mix', name: 'Read', input: {} }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'QUJDRA==' },
            },
            {
              type: 'tool_result',
              tool_use_id: 'toolu_mix',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'WllYWA==' },
                },
              ],
            },
          ],
        },
      ],
    });
    const wire = state.currentMessage.userInputMessage;
    const resultText = wire.userInputMessageContext.toolResults[0].content[0].text;

    expect(wire.images.map((image: { source: { bytes: string } }) => image.source.bytes)).toEqual([
      'QUJDRA==',
      'WllYWA==',
    ]);
    expect(wire.content).toContain(
      '[Image 1: independent input; source=user message; content index=0]',
    );
    expect(resultText).toContain(
      '[Image 2: independent input; source=user message tool result "toolu_mix"; content index=0]',
    );
  });

  it('retains source turns when consecutive historical user messages are merged', () => {
    const state = responsesState({
      model: 'gpt-5.6-sol',
      input: [
        { role: 'user', content: [imagePart(PNG_A)] },
        { role: 'user', content: [imagePart(PNG_B)] },
        { role: 'user', content: 'Compare the preceding inputs.' },
      ],
    });
    const historyUser = state.history.find((message: { userInputMessage?: unknown }) =>
      Boolean(message.userInputMessage),
    ).userInputMessage;

    expect(historyUser.images).toHaveLength(2);
    expect(historyUser.content).toContain(
      '[Image 1: independent input; source=user message 1; content index=0]',
    );
    expect(historyUser.content).toContain(
      '[Image 2: independent input; source=user message 2; content index=0]',
    );
  });

  it('keeps images from separate historical turns in separate Kiro messages', () => {
    const state = responsesState({
      model: 'gpt-5.6-sol',
      input: [
        { role: 'user', content: [imagePart(PNG_A)] },
        { role: 'assistant', content: 'First image recorded.' },
        { role: 'user', content: [imagePart(PNG_B)] },
        { role: 'assistant', content: 'Second image recorded.' },
        { role: 'user', content: 'Compare both earlier images.' },
      ],
    });
    const historyUsers = state.history
      .filter((message: { userInputMessage?: unknown }) => Boolean(message.userInputMessage))
      .map((message: { userInputMessage: unknown }) => message.userInputMessage);

    expect(historyUsers).toHaveLength(2);
    expect(historyUsers.map((message: { images: unknown[] }) => message.images.length)).toEqual([
      1, 1,
    ]);
    expect(state.currentMessage.userInputMessage.images).toEqual([]);
  });
});
