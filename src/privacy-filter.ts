/**
 * Layered privacy filter for NanoClaw.
 * Classifies messages before they reach Claude API.
 * Sensitive messages are routed to local Qwen instead.
 *
 * Layer 1: User override (!local prefix) — instant, deterministic
 * Layer 2: Regex patterns — instant, deterministic, injection-proof
 * Layer 3: Qwen classification — 1-2s latency, probabilistic, fail-open
 */

import {
  OLLAMA_BASE_URL,
  OLLAMA_MODEL,
  PRIVACY_QWEN_LAYER_ENABLED,
} from './config.js';
import { logger } from './logger.js';

export type PrivacyVerdict = 'sensitive' | 'normal' | 'force_local';

export interface PrivacyClassification {
  verdict: PrivacyVerdict;
  layer: string; // 'user_override' | 'regex' | 'qwen' | 'pass'
  detail?: string; // which pattern matched
}

// --- Layer 1: User override prefixes ---

const FORCE_LOCAL_PREFIXES = ['!local ', '!private ', '!qwen '];

// --- Layer 2: Regex patterns (deterministic, injection-proof) ---

const SENSITIVE_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // API keys / tokens
  {
    name: 'api_key_value',
    pattern:
      /(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S{8,}/i,
  },
  {
    name: 'bearer_token',
    pattern: /Bearer\s+[A-Za-z0-9\-._~+/]{20,}/i,
  },
  { name: 'aws_key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'github_token', pattern: /gh[pous]_[A-Za-z0-9]{36,}/ },
  { name: 'sk_key', pattern: /sk-[A-Za-z0-9]{20,}/ },

  // Financial
  {
    name: 'iban',
    pattern:
      /\b[A-Z]{2}\d{2}\s?[\dA-Z]{4}\s?[\dA-Z]{4}\s?[\dA-Z]{4}\s?[\dA-Z]{0,4}\s?[\dA-Z]{0,4}\s?[\dA-Z]{0,2}\b/,
  },
  {
    name: 'credit_card',
    pattern:
      /\b(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/,
  },

  // Personal IDs
  { name: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
  { name: 'swiss_ahv', pattern: /\b756\.\d{4}\.\d{4}\.\d{2}\b/ },

  // Credentials in plaintext
  {
    name: 'password_plain',
    pattern: /(?:my\s+(?:password|pw|pass)\s+is\s+|password:\s*|passwd:\s*|pw:\s*)\S+/i,
  },
  {
    name: 'private_key',
    pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
  },
];

/**
 * Layer 2: Fast regex check. Deterministic and injection-proof.
 */
function regexPrivacyCheck(
  message: string,
): { sensitive: boolean; matchedPattern?: string } {
  for (const { name, pattern } of SENSITIVE_PATTERNS) {
    if (pattern.test(message)) {
      return { sensitive: true, matchedPattern: name };
    }
  }
  return { sensitive: false };
}

/**
 * Layer 3: Qwen-based classification.
 * Only called when regex is inconclusive. Fail-open on error.
 */
async function qwenPrivacyClassify(
  message: string,
): Promise<'sensitive' | 'normal'> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are a privacy classifier. Reply with ONLY the single word SENSITIVE or NORMAL.\n\nSENSITIVE = message contains or requests handling of: passwords, API keys, secret tokens, private credentials, financial account numbers/IBAN/card numbers, medical records, government ID numbers, private keys, personal addresses combined with names, detailed financial information.\n\nNORMAL = everything else (general questions, coding help, task requests, casual conversation).\n\nWhen in doubt, reply NORMAL.',
          },
          { role: 'user', content: message },
        ],
        stream: false,
        options: { num_ctx: 4096 },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return 'normal';

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const verdict = data.choices?.[0]?.message?.content?.trim().toUpperCase();
    return verdict?.includes('SENSITIVE') ? 'sensitive' : 'normal';
  } catch (err) {
    logger.warn(
      { err },
      'Privacy classifier unavailable, falling through to Claude',
    );
    return 'normal';
  }
}

/**
 * Full privacy classification pipeline.
 * Evaluates layers in order: user override -> regex -> Qwen.
 */
export async function classifyPrivacy(
  message: string,
): Promise<PrivacyClassification> {
  // Layer 1: user override prefix
  const lower = message.toLowerCase().trimStart();
  for (const prefix of FORCE_LOCAL_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return { verdict: 'force_local', layer: 'user_override' };
    }
  }

  // Layer 2: regex patterns
  const regexResult = regexPrivacyCheck(message);
  if (regexResult.sensitive) {
    return {
      verdict: 'sensitive',
      layer: 'regex',
      detail: regexResult.matchedPattern,
    };
  }

  // Layer 3: Qwen classification (optional)
  if (PRIVACY_QWEN_LAYER_ENABLED) {
    const qwenResult = await qwenPrivacyClassify(message);
    if (qwenResult === 'sensitive') {
      return { verdict: 'sensitive', layer: 'qwen' };
    }
  }

  return { verdict: 'normal', layer: 'pass' };
}
