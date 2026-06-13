// 0rb consumer-install defaults.

module.exports = {
  // Default local brain — Qwen VL 8B (vision + tool-calling = full orb
  // functionality, no code changes). Must be an Ollama-pullable tag. If
  // qwen3-vl:8b isn't in the Ollama library yet, FALLBACK is pulled instead.
  DEFAULT_MODEL: process.env.RAK00N_MODEL || 'qwen3-vl:8b',
  FALLBACK_MODEL: 'qwen2.5vl:7b',

  OLLAMA_URL: 'http://127.0.0.1:11434',
  API_PORT: Number(process.env.RAK00N_API_PORT || 9080),

  // Where to send users to install Ollama if it's missing.
  OLLAMA_DOWNLOAD: 'https://ollama.com/download',
}
