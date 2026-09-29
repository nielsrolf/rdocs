// Transactional email via Resend's HTTP API (no SDK dependency). Configured by
// RESEND_API_KEY; EMAIL_FROM overrides the sender, which must be on the
// verified mail.nielsrolf.com domain. Without a key, emailEnabled() is false and
// callers keep the pre-email behaviour (no verification step), so dev copies
// and tests never need a key.

const DEFAULT_FROM = "r-docs <noreply@mail.nielsrolf.com>";

// Reserved / test domains (RFC 2606, RFC 6761). Sending there only bounces,
// and bounces hurt the sender domain's reputation — integration tests sign up
// with @example.com addresses against the live server.
const UNDELIVERABLE = /@(example\.(com|org|net)|[^@]+\.(test|invalid|localhost|example))$/i;

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export function emailEnabled() {
  return Boolean(process.env.RESEND_API_KEY);
}

export function isDeliverableAddress(address: string) {
  return !UNDELIVERABLE.test(address.trim());
}

export async function sendEmail(message: EmailMessage): Promise<{ sent: boolean }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !isDeliverableAddress(message.to)) {
    console.info(`[email] not sent (${apiKey ? "undeliverable address" : "RESEND_API_KEY unset"}) to=${message.to} subject=${JSON.stringify(message.subject)}`);
    return { sent: false };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || DEFAULT_FROM,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html
    }),
    signal: AbortSignal.timeout(15_000)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Resend rejected email (${response.status}): ${detail.slice(0, 300)}`);
  }

  return { sent: true };
}
