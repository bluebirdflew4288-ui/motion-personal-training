// Upstream error bodies can echo the credential in plain text or in a JSON string.
export function redactCredential(text: string, credential?: string): string {
  if (!credential) return text;
  const escaped = JSON.stringify(credential).slice(1, -1);
  const redacted = escaped === credential ? text : text.replaceAll(escaped, '[REDACTED]');
  return redacted.replaceAll(credential, '[REDACTED]');
}
