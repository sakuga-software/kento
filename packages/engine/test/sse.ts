// REV-108. A stream of the Messages API of Anthropic, as server-sent events, for the tests.

type Block = { type: string; [key: string]: unknown };
type Usage = { input?: number; cacheRead?: number; cacheWrite?: number; output?: number; thinking?: number };

/**
 * A response with these events, cut in chunks of 7 bytes so that an event spans several chunks.
 * With `hang`, the stream stays open after the events until `signal` aborts, as a model that thinks.
 */
export function sseResponse(events: object[], signal?: AbortSignal | null, hang = false): Response {
  const bytes = new TextEncoder().encode(events.map((e) => `event: ${(e as { type: string }).type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join(''));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      if (!hang) controller.close();
      else signal?.addEventListener('abort', () => controller.error(signal.reason));
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

/** The start of a message: the input tokens come here. */
export function startEvents(model: string, usage: Usage = {}): object[] {
  return [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: usage.input ?? 0, cache_read_input_tokens: usage.cacheRead ?? 0, cache_creation_input_tokens: usage.cacheWrite ?? 0, output_tokens: 1 } } },
    { type: 'ping' },
  ];
}

/** The events of each block, with its text, thinking or tool input in two deltas. */
export function blockEvents(blocks: Block[]): object[] {
  return blocks.flatMap((block, index): object[] => {
    const halves = (text: string) => [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))];
    if (block.type === 'text') {
      return [
        { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
        ...halves(String(block.text)).map((text) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } })),
        { type: 'content_block_stop', index },
      ];
    }
    if (block.type === 'thinking') {
      return [
        { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } },
        ...halves(String(block.thinking)).map((thinking) => ({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } })),
        { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } },
        { type: 'content_block_stop', index },
      ];
    }
    if (block.type === 'tool_use') {
      return [
        { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } },
        ...halves(JSON.stringify(block.input)).map((partial_json) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } })),
        { type: 'content_block_stop', index },
      ];
    }
    throw new Error(`no events for a block of type ${block.type}`);
  });
}

/** The end of a message: its stop_reason, and its output tokens. */
export function endEvents(stopReason: string, usage: Usage = {}): object[] {
  return [
    {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: usage.output ?? 0, ...(usage.thinking !== undefined ? { output_tokens_details: { thinking_tokens: usage.thinking } } : {}) },
    },
    { type: 'message_stop' },
  ];
}

/** A whole message. */
export function messageResponse(model: string, blocks: Block[], stopReason: string, usage: Usage = {}): Response {
  return sseResponse([...startEvents(model, usage), ...blockEvents(blocks), ...endEvents(stopReason, usage)]);
}
