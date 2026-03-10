# Qwen Local Model Helper

When `OLLAMA_BASE_URL` is set in your environment, you have access to a local Qwen 3.5 9B model via Ollama. This model runs on the host machine — no API tokens needed, no data leaves the network.

## When to use Qwen

- Summarizing long text (web pages, documents, logs)
- Classifying or categorizing content
- Simple text generation (drafts, templates)
- Privacy-sensitive content processing

## When NOT to use Qwen

- Complex multi-step reasoning (use your own capabilities instead)
- Tasks requiring tools or code execution
- Anything requiring >32K context

## How to call Qwen

Check if available:
```bash
[ -n "$OLLAMA_BASE_URL" ] && echo "Qwen available at $OLLAMA_BASE_URL" || echo "Qwen not configured"
```

Simple completion:
```bash
curl -s "$OLLAMA_BASE_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "'"$OLLAMA_MODEL"'",
    "messages": [
      {"role": "system", "content": "You are a concise assistant."},
      {"role": "user", "content": "Summarize this text: ..."}
    ],
    "stream": false
  }' | jq -r '.choices[0].message.content'
```

## Limitations

- 9B parameter model — less capable than Claude for complex tasks
- 32K context window
- No tool use, no function calling
- Single request at a time (may queue behind other requests)
- More susceptible to prompt injection — do NOT use for processing untrusted content that drives decisions
