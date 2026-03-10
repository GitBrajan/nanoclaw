/**
 * Local agent runner for Ollama/Qwen.
 * Handles messages for groups with modelType='local' — no container.
 * Supports basic tool use (fetch_url, get_datetime) via Ollama's
 * OpenAI-compatible API.
 */

import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  GROUPS_DIR,
  OLLAMA_BASE_URL,
  OLLAMA_MODEL,
  TIMEZONE,
} from './config.js';
import { getMessagesSince, storeMessageDirect } from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { Channel, RegisteredGroup } from './types.js';

const LOCAL_CONTEXT_WINDOW = 32768;
const LOCAL_MAX_HISTORY = 20;
const LOCAL_TIMEOUT_MS = 120_000; // 2 minutes

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
}

interface OllamaToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OllamaChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: OllamaToolCall[];
    };
  }>;
}

// ---------------------------------------------------------------------------
// Tool definitions (Ollama OpenAI-compatible format)
// ---------------------------------------------------------------------------

const LOCAL_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'fetch_url',
      description:
        'Fetch the text content of a public URL (web page, RSS feed, API endpoint). Returns the first 8000 characters of the response body.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_datetime',
      description:
        'Get the current date and time in the configured timezone.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

const FETCH_MAX_CHARS = 8000;
const FETCH_TIMEOUT_MS = 15_000;

async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (name === 'fetch_url') {
    const url = args.url as string;
    if (!url || typeof url !== 'string') return 'Error: url parameter required';
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': 'NanoClaw/1.0' },
      });
      if (!res.ok) return `Error: HTTP ${res.status} ${res.statusText}`;
      const text = await res.text();
      return text.slice(0, FETCH_MAX_CHARS);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : 'fetch failed'}`;
    }
  }
  if (name === 'get_datetime') {
    return new Date().toLocaleString('en-US', {
      timeZone: TIMEZONE,
      dateStyle: 'full',
      timeStyle: 'long',
    });
  }
  return `Error: unknown tool ${name}`;
}

function readClaudeMd(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8').trim();
  } catch {
    return null;
  }
}

function buildSystemPrompt(group: RegisteredGroup): string {
  const base = `You are ${ASSISTANT_NAME}, a concise personal assistant. Timezone: ${TIMEZONE}. You have tools to fetch URLs and check the current date/time. Be direct and brief.`;

  const globalMemory = readClaudeMd(path.join(GROUPS_DIR, 'CLAUDE.md'));
  const groupMemory = readClaudeMd(
    path.join(resolveGroupFolderPath(group.folder), 'CLAUDE.md'),
  );

  const parts = [base];
  if (globalMemory) parts.push(`## Global Memory\n${globalMemory}`);
  if (groupMemory) parts.push(`## Group Context\n${groupMemory}`);

  return parts.join('\n\n');
}

/**
 * Build conversation history from recent DB messages for multi-turn context.
 */
function buildConversationHistory(chatJid: string): OllamaChatMessage[] {
  const messages: OllamaChatMessage[] = [];
  const recentMessages = getMessagesSince(
    chatJid,
    '',
    ASSISTANT_NAME,
    LOCAL_MAX_HISTORY,
  );

  for (const msg of recentMessages) {
    if (msg.is_from_me || msg.is_bot_message) {
      messages.push({ role: 'assistant', content: msg.content });
    } else {
      messages.push({ role: 'user', content: msg.content });
    }
  }

  return messages;
}

/**
 * Call Ollama's OpenAI-compatible chat completions endpoint.
 * When `tools` is provided, enters a tool-use loop (max MAX_TOOL_ROUNDS
 * iterations) that executes any tool calls returned by the model and feeds
 * results back before requesting the next completion.
 */
const MAX_TOOL_ROUNDS = 3;

async function callOllama(
  messages: OllamaChatMessage[],
  tools?: typeof LOCAL_TOOLS,
): Promise<string | null> {
  // Work on a mutable copy so tool-call messages can be appended.
  const conversation = [...messages];

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    try {
      const body: Record<string, unknown> = {
        model: OLLAMA_MODEL,
        messages: conversation,
        stream: false,
        options: { num_ctx: LOCAL_CONTEXT_WINDOW },
      };
      if (tools && tools.length > 0) {
        body.tools = tools;
      }

      const response = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(LOCAL_TIMEOUT_MS),
      });

      if (!response.ok) {
        logger.error(
          { status: response.status, statusText: response.statusText },
          'Ollama API error',
        );
        return null;
      }

      const data = (await response.json()) as OllamaChatResponse;
      const choice = data.choices?.[0]?.message;

      // No tool calls — return text content.
      const toolCalls = choice?.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        return choice?.content?.trim() || null;
      }

      // Guard: don't enter another round if we've exhausted the budget.
      if (round === MAX_TOOL_ROUNDS) {
        logger.warn('Max tool-use rounds reached, returning last content');
        return choice?.content?.trim() || null;
      }

      // Append the assistant message (with tool_calls) to conversation.
      conversation.push({
        role: 'assistant',
        content: choice?.content ?? '',
        // The raw tool_calls are forwarded via the spread below; however
        // OllamaChatMessage doesn't carry them — Ollama only needs the
        // subsequent tool-result messages to continue, so we keep the
        // assistant turn for context.
      });

      // Execute each tool call and append results.
      for (const tc of toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          // Malformed JSON from the model — pass empty args.
        }

        logger.info(
          { tool: tc.function.name, args, round },
          'Executing local tool',
        );

        const result = await executeTool(tc.function.name, args);

        conversation.push({
          role: 'tool',
          content: result,
          tool_call_id: tc.id,
        });
      }
    } catch (err) {
      logger.error({ err }, 'Failed to call Ollama');
      return null;
    }
  }

  // Should not be reached, but just in case.
  return null;
}

/**
 * Strip force-local prefixes from the prompt before sending to Qwen.
 */
const FORCE_LOCAL_PREFIXES = ['!local ', '!private ', '!qwen '];

function stripForceLocalPrefix(text: string): string {
  const lower = text.toLowerCase().trimStart();
  for (const prefix of FORCE_LOCAL_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return text.trimStart().slice(prefix.length);
    }
  }
  return text;
}

/**
 * Run a local agent for a group message. No container — uses local tools
 * (fetch_url, get_datetime) via Ollama's tool-call protocol.
 * Called from processGroupMessages when group.modelType === 'local'
 * or when the privacy filter diverts a message.
 */
export async function runLocalAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  channel: Channel,
): Promise<'success' | 'error'> {
  const systemPrompt = buildSystemPrompt(group);
  const history = buildConversationHistory(chatJid);
  const cleanPrompt = stripForceLocalPrefix(prompt);

  const messages: OllamaChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: cleanPrompt },
  ];

  logger.info(
    { group: group.name, historyLength: history.length },
    'Running local agent (Qwen)',
  );

  const text = await callOllama(messages, LOCAL_TOOLS);

  if (text) {
    // Send with [local] prefix so user knows which model answered
    await channel.sendMessage(chatJid, `[local] ${text}`);

    // Store response WITHOUT prefix so conversation history stays clean
    storeMessageDirect({
      id: `local-${Date.now()}`,
      chat_jid: chatJid,
      sender: ASSISTANT_NAME,
      sender_name: ASSISTANT_NAME,
      content: text,
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: true,
    });
    return 'success';
  }

  await channel.sendMessage(
    chatJid,
    '[local] Sorry, I could not process that locally. Try again or use the main channel.',
  );
  return 'error';
}

/**
 * Run a local agent for a scheduled task. Single-turn, no history.
 */
export async function runLocalTask(
  prompt: string,
): Promise<{ status: 'success' | 'error'; result: string | null; error?: string }> {
  const messages: OllamaChatMessage[] = [
    {
      role: 'system',
      content: `You are ${ASSISTANT_NAME}. Execute the following task concisely.`,
    },
    { role: 'user', content: prompt },
  ];

  const text = await callOllama(messages, LOCAL_TOOLS);

  if (text) {
    return { status: 'success', result: text };
  }
  return {
    status: 'error',
    result: null,
    error: 'Ollama unavailable or returned empty response',
  };
}

/**
 * Health check — verify Ollama is reachable.
 */
export async function checkOllamaHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
