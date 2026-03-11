export const config = {
  runtime: 'edge',
};

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const body = await req.json();
    const {
      provider,
      model,
      apiKey,
      messages,
      temperature = 0.7,
      topP = 1.0,
      maxTokens = 4096,
      outputFormat = 'none',
    } = body;

    if (!provider || !model || !apiKey || !messages?.length) {
      return errorResponse('Missing required fields: provider, model, apiKey, messages');
    }

    const processedMessages = addFormatInstruction(messages, outputFormat);

    switch (provider) {
      case 'openai':
        return proxyOpenAI(
          'https://api.openai.com/v1/chat/completions',
          apiKey, model, processedMessages, temperature, topP, maxTokens, outputFormat,
          { Authorization: `Bearer ${apiKey}` }
        );
      case 'openrouter':
        return proxyOpenAI(
          'https://openrouter.ai/api/v1/chat/completions',
          apiKey, model, processedMessages, temperature, topP, maxTokens, outputFormat,
          { Authorization: `Bearer ${apiKey}` }
        );
      case 'claude':
        return proxyClaude(apiKey, model, processedMessages, temperature, topP, maxTokens);
      case 'gemini':
        return proxyGemini(apiKey, model, processedMessages, temperature, topP, maxTokens);
      default:
        return errorResponse('Unknown provider: ' + provider);
    }
  } catch (err) {
    // Never include API keys in error messages
    const safeMessage = err.message?.replace(/sk-[a-zA-Z0-9]+/g, '[REDACTED]')
      .replace(/key-[a-zA-Z0-9]+/g, '[REDACTED]') || 'Internal server error';
    return errorResponse(safeMessage, 500);
  }
}

// --- Helpers ---

function errorResponse(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sanitizeAPIError(text) {
  return text
    .replace(/sk-[a-zA-Z0-9_-]+/g, '[REDACTED]')
    .replace(/key-[a-zA-Z0-9_-]+/g, '[REDACTED]')
    .replace(/AIza[a-zA-Z0-9_-]+/g, '[REDACTED]');
}

function addFormatInstruction(messages, outputFormat) {
  if (!outputFormat || outputFormat === 'none') return messages;

  const formats = {
    json: 'IMPORTANT: You must respond with valid JSON only. No text outside the JSON structure.',
    markdown: 'IMPORTANT: You must format your entire response in Markdown.',
    text: 'IMPORTANT: You must respond in plain text only, no markdown or HTML formatting.',
  };

  const instruction = formats[outputFormat];
  if (!instruction) return messages;

  const msgs = [...messages];
  if (msgs[0]?.role === 'system') {
    msgs[0] = { ...msgs[0], content: msgs[0].content + '\n\n' + instruction };
  } else {
    msgs.unshift({ role: 'system', content: instruction });
  }
  return msgs;
}

function createNormalizedStream(upstreamResponse, parseLine) {
  const reader = upstreamResponse.body.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream({
    async start(controller) {
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            const result = parseLine(trimmed);
            if (result === '__DONE__') {
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
              return;
            }
            if (result) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ content: result })}\n\n`)
              );
            }
          }
        }
        // Stream ended naturally
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (err) {
        const safeMsg = sanitizeAPIError(err.message || 'Stream error');
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: safeMsg })}\n\n`)
        );
        controller.close();
      }
    },
  });
}

// --- Provider: OpenAI / OpenRouter (same format) ---

async function proxyOpenAI(url, apiKey, model, messages, temperature, topP, maxTokens, outputFormat, headers) {
  const body = {
    model,
    messages,
    stream: true,
    temperature,
    top_p: topP,
    max_tokens: maxTokens,
  };

  if (outputFormat === 'json') {
    body.response_format = { type: 'json_object' };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = sanitizeAPIError(await res.text());
    return errorResponse(`API error (${res.status}): ${errText}`, res.status);
  }

  const stream = createNormalizedStream(res, (line) => {
    if (!line.startsWith('data: ')) return null;
    const data = line.slice(6).trim();
    if (data === '[DONE]') return '__DONE__';
    try {
      const parsed = JSON.parse(data);
      return parsed.choices?.[0]?.delta?.content || null;
    } catch {
      return null;
    }
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

// --- Provider: Claude (Anthropic) ---

async function proxyClaude(apiKey, model, messages, temperature, topP, maxTokens) {
  let system = '';
  const claudeMessages = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : msg.content.map((p) => p.text || '').join('\n');
      system += (system ? '\n\n' : '') + text;
      continue;
    }

    if (typeof msg.content === 'string') {
      claudeMessages.push(msg);
    } else {
      const parts = msg.content.map((part) => {
        if (part.type === 'text') return part;
        if (part.type === 'image_url') {
          const match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/s);
          if (match) {
            return {
              type: 'image',
              source: { type: 'base64', media_type: match[1], data: match[2] },
            };
          }
        }
        return part;
      });
      claudeMessages.push({ role: msg.role, content: parts });
    }
  }

  const body = {
    model,
    messages: claudeMessages,
    max_tokens: maxTokens,
    stream: true,
    temperature,
    top_p: topP,
  };
  if (system) body.system = system;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = sanitizeAPIError(await res.text());
    return errorResponse(`Claude API error (${res.status}): ${errText}`, res.status);
  }

  const stream = createNormalizedStream(res, (line) => {
    if (line.startsWith('event:')) return null; // skip event type lines
    if (!line.startsWith('data: ')) return null;
    const data = line.slice(6).trim();
    if (!data) return null;
    try {
      const parsed = JSON.parse(data);
      if (parsed.type === 'content_block_delta') {
        return parsed.delta?.text || null;
      }
      if (parsed.type === 'message_stop') {
        return '__DONE__';
      }
      if (parsed.type === 'error') {
        return null; // error handled by stream end
      }
      return null;
    } catch {
      // Partial JSON chunk — ignore and wait for next line
      return null;
    }
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

// --- Provider: Gemini (Google) ---

async function proxyGemini(apiKey, model, messages, temperature, topP, maxTokens) {
  let systemText = '';
  const contents = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : msg.content.map((p) => p.text || '').join('\n');
      systemText += (systemText ? '\n\n' : '') + text;
      continue;
    }

    const role = msg.role === 'assistant' ? 'model' : 'user';

    if (typeof msg.content === 'string') {
      contents.push({ role, parts: [{ text: msg.content }] });
    } else {
      const parts = msg.content.map((part) => {
        if (part.type === 'text') return { text: part.text };
        if (part.type === 'image_url') {
          const match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/s);
          if (match) {
            return { inlineData: { mimeType: match[1], data: match[2] } };
          }
        }
        return { text: '' };
      });
      contents.push({ role, parts });
    }
  }

  const body = {
    contents,
    generationConfig: {
      temperature,
      topP,
      maxOutputTokens: maxTokens,
    },
  };

  if (systemText) {
    body.systemInstruction = { parts: [{ text: systemText }] };
  }

  // Gemini uses API key as query param for streaming endpoint
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = sanitizeAPIError(await res.text());
    return errorResponse(`Gemini API error (${res.status}): ${errText}`, res.status);
  }

  // Gemini SSE can be inconsistent — handle partial JSON and varied formats
  const stream = createNormalizedStream(res, (line) => {
    if (!line.startsWith('data: ')) return null;
    const data = line.slice(6).trim();
    if (!data || data === '[DONE]') return data === '[DONE]' ? '__DONE__' : null;

    try {
      const parsed = JSON.parse(data);

      // Check for finish reason (stream may not always send [DONE])
      const finishReason = parsed.candidates?.[0]?.finishReason;
      const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;

      if (text) return text;
      if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
        return null; // Safety filter or other non-content finish
      }
      return null;
    } catch {
      // Gemini sometimes sends partial JSON across chunks — skip gracefully
      return null;
    }
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
