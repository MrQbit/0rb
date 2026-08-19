/**
 * Console-configurable setting keys — shared by the settings API and the
 * agent-facing Settings tool so both enforce the same whitelist.
 */
export const SETTINGS_KEYS = [
  // Voice (STT/TTS run as GPU services; see ORB2_STT_URL/ORB2_TTS_URL)
  'ORB2_VOICE_ENABLED', 'ORB2_VOICE_BACKEND', 'ORB2_TTS_VOICE',
  'ORB2_STT_URL', 'ORB2_TTS_URL',
  // Home Assistant — the device backbone (lights/locks/climate/etc.)
  'ORB2_HA_URL', 'ORB2_HA_TOKEN',
  // Home location — used for the concierge's "nearby stores" search
  'ORB2_HOME_LOCATION',
  // Daily morning briefing (HH:MM, empty = off)
  'ORB2_BRIEFING_TIME',
  // Push (FCM) — proactive nudges to the 0rb apps
  'ORB2_FCM_PROJECT_ID', 'ORB2_FCM_SERVICE_ACCOUNT',
  // Access — who may sign in, and how OTP codes are emailed
  'ORB2_AUTH_ALLOWED_EMAILS',
  'ORB2_SMTP_HOST', 'ORB2_SMTP_PORT', 'ORB2_SMTP_USER', 'ORB2_SMTP_PASS', 'ORB2_SMTP_FROM',
  // Telegram channel
  'ORB2_TELEGRAM_BOT_TOKEN', 'ORB2_TELEGRAM_OWNER_ID',
  // WhatsApp channel
  'ORB2_OWNER_PHONE',
  // Models — the active model (applied to process.env so chat + voice use it)
  // and the HuggingFace token for gated downloads. BASE_URL/API_KEY let the
  // user point the brain at a cloud OpenAI-compatible endpoint if they can't
  // run locally (endpoint/key changes apply on the next api restart).
  'OPENAI_MODEL', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'ORB2_HF_TOKEN',
  // Model router — default local; route by intent to OpenRouter when enabled.
  'ORB2_ROUTER_ENABLED', 'ORB2_OPENROUTER_KEY', 'ORB2_ROUTER_STRONG_MODEL',
  // Connected apps (set from Settings → Apps; enable the matching tools live)
  'ORB2_YOUTUBE_API_KEY', 'ORB2_SPOTIFY_CLIENT_ID', 'ORB2_SPOTIFY_CLIENT_SECRET', 'ORB2_BRAVE_API_KEY',
  'ORB2_NEWSAPI_KEY', 'ORB2_VERCEL_TOKEN', 'ORB2_VERCEL_TEAM_ID',
  // Cloud Storage (Google Drive + Microsoft OneDrive) — OAuth client creds
  'ORB2_GOOGLE_CLIENT_ID', 'ORB2_GOOGLE_CLIENT_SECRET',
  'ORB2_MS_CLIENT_ID', 'ORB2_MS_CLIENT_SECRET',
  // Apps registry — comma-separated ids of widgets the user turned OFF.
  'ORB2_WIDGETS_DISABLED',
] as const

// Keys safe to echo back in plaintext (never secrets).
export const SETTINGS_PLAINTEXT_KEYS = new Set([
  'ORB2_VOICE_ENABLED', 'ORB2_VOICE_BACKEND', 'ORB2_TTS_VOICE',
  'ORB2_STT_URL', 'ORB2_TTS_URL',
  'ORB2_AUTH_ALLOWED_EMAILS',
  'ORB2_SMTP_HOST', 'ORB2_SMTP_PORT', 'ORB2_SMTP_FROM',
  'ORB2_TELEGRAM_OWNER_ID', 'ORB2_OWNER_PHONE', 'OPENAI_MODEL', 'OPENAI_BASE_URL',
  'ORB2_WIDGETS_DISABLED', 'ORB2_ROUTER_ENABLED', 'ORB2_ROUTER_STRONG_MODEL',
])

/**
 * Settings only an OWNER may change: the brain, its endpoint/keys, who can
 * sign in, message channels, smart-home credentials, and self-modification.
 * A member changing any of these could take over or brick the household.
 */
export const CRITICAL_SETTINGS = new Set<string>([
  'OPENAI_MODEL', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'ORB2_HF_TOKEN',
  'ORB2_ROUTER_ENABLED', 'ORB2_OPENROUTER_KEY', 'ORB2_ROUTER_STRONG_MODEL',
  'ORB2_AUTH_ALLOWED_EMAILS',
  'ORB2_SMTP_HOST', 'ORB2_SMTP_PORT', 'ORB2_SMTP_USER', 'ORB2_SMTP_PASS', 'ORB2_SMTP_FROM',
  'ORB2_TELEGRAM_BOT_TOKEN', 'ORB2_TELEGRAM_OWNER_ID', 'ORB2_OWNER_PHONE',
  'ORB2_HA_URL', 'ORB2_HA_TOKEN',
  'ORB2_FCM_PROJECT_ID', 'ORB2_FCM_SERVICE_ACCOUNT',
])
