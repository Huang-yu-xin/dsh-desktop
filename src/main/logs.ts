/**
 * Log sanitization, centralized and exported so verification scripts can
 * assert the exact product behavior. Everything shown to the renderer goes
 * through `sanitizeLogs`; the raw buffers never leave the main process.
 */
export function sanitizeLogs(text: string): string {
  return text
    // Authorization headers, with or without a scheme ("Authorization: Bearer x",
    // "authorization=x").
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?\S+/gi, '$1[REDACTED]')
    // Standalone bearer tokens.
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
    // Common secret names in key=value / key: value form.
    .replace(
      /\b(DEEPSEEK_API_KEY|DEEPSEEK_BASE_URL|OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|API_KEY|X_API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|TOKEN)\b\s*[=:]\s*[^\s"']+/gi,
      '$1=[REDACTED]',
    )
    // Dashed header-style key names.
    .replace(/\b(x-api-key|api-key)\b\s*[=:]\s*[^\s"']+/gi, '$1=[REDACTED]')
    // DeepSeek/OpenAI style keys.
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED-KEY]');
}
