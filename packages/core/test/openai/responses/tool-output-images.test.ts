import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { convertRequest } from '../../../src/claude/converter.js';
import type { ConversationState } from '../../../src/kiro/model/requests/conversation.js';
import { serializeKiroRequest } from '../../../src/kiro/model/requests/kiro.js';
import { REMOTE_IMAGE_PLACEHOLDER } from '../../../src/openai/converter.js';
import { convertResponsesRequest } from '../../../src/openai/responses/converter.js';
import type {
  ResponsesContentPart,
  ResponsesInputItem,
  ResponsesRequest,
} from '../../../src/openai/responses/types.js';

const imageData = readFileSync(
  new URL('../../fixtures/images/test-small.png', import.meta.url),
).toString('base64');

function toolRoundTrip(
  custom: boolean,
  output: ResponsesContentPart[],
  history: boolean,
): ConversationState {
  const call: ResponsesInputItem = custom
    ? {
        type: 'custom_tool_call',
        call_id: 'call_image',
        name: 'exec',
        input: 'image((await tools.view_image({path:"/workspace/chart.png"})).image_url)',
      }
    : {
        type: 'function_call',
        call_id: 'call_image',
        name: 'view_image',
        arguments: '{"path":"/workspace/chart.png"}',
      };
  const request: ResponsesRequest = {
    model: 'gpt-5.6-sol',
    input: [
      { role: 'user', content: 'Read chart.png and describe the chart.' },
      call,
      {
        type: custom ? 'custom_tool_call_output' : 'function_call_output',
        call_id: 'call_image',
        output,
      },
    ],
  };
  if (history && Array.isArray(request.input)) {
    request.input.push(
      { role: 'assistant', content: 'The chart has been loaded.' },
      { role: 'user', content: 'What is the largest value in that chart?' },
    );
  }
  const { payload } = convertResponsesRequest(request);
  const { conversationState } = convertRequest(payload, { identityOverride: false });
  return JSON.parse(serializeKiroRequest({ conversationState })).conversationState;
}

function findImageResult(state: ConversationState) {
  const messages = [
    ...state.history.flatMap((message) =>
      'userInputMessage' in message ? [message.userInputMessage] : [],
    ),
    state.currentMessage.userInputMessage,
  ];
  return messages.find((message) =>
    message.userInputMessageContext?.toolResults?.some(
      (result) => result.toolUseId === 'call_image',
    ),
  );
}

describe.each([false, true])('Responses tool images (custom=%s)', (custom) => {
  it.each([false, true])('preserves image bytes on the Kiro wire (history=%s)', (history) => {
    const state = toolRoundTrip(
      custom,
      [
        { type: 'input_text', text: 'Here is chart.png:' },
        { type: 'input_image', image_url: `data:image/png;base64,${imageData}` },
        { type: 'input_text', text: 'Image loaded successfully.' },
      ],
      history,
    );
    const message = findImageResult(state);
    expect(message?.images).toHaveLength(1);
    expect(message?.images).toEqual([{ format: 'png', source: { bytes: imageData } }]);
    expect(message?.userInputMessageContext?.toolResults).toMatchObject([
      {
        toolUseId: 'call_image',
        content: [
          {
            text: 'Here is chart.png:\n[image 1 attached to this message]\nImage loaded successfully.',
          },
        ],
      },
    ]);
  });

  it('retains an image-only result with a nonempty attachment reference', () => {
    const message = findImageResult(
      toolRoundTrip(
        custom,
        [{ type: 'input_image', image_url: `data:image/png;base64,${imageData}` }],
        false,
      ),
    );
    expect(message?.images).toHaveLength(1);
    expect(message?.userInputMessageContext?.toolResults).toMatchObject([
      { toolUseId: 'call_image', content: [{ text: '[image 1 attached to this message]' }] },
    ]);
  });

  it('explains unsupported remote images instead of silently deleting them', () => {
    const message = findImageResult(
      toolRoundTrip(
        custom,
        [{ type: 'input_image', image_url: 'https://example.com/chart.png' }],
        false,
      ),
    );
    expect(message?.images ?? []).toHaveLength(0);
    expect(message?.userInputMessageContext?.toolResults).toMatchObject([
      { toolUseId: 'call_image', content: [{ text: REMOTE_IMAGE_PLACEHOLDER }] },
    ]);
  });
});
