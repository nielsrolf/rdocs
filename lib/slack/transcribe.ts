// Voice-message transcription for the Slack bot (OpenAI Whisper API shape).
//
// Credential resolution mirrors the agent-credential chain and runs per
// TRIGGERING user: document env OPENAI_API_KEY → the user's "openai"
// credential → the document owner's — then the same for LiteLLM (which
// proxies /v1/audio/transcriptions when a whisper model is configured).
// No credential → the caller tells the user how to enable voice support.

import { db } from "@/lib/db";
import { loadDocumentEnv } from "@/lib/document-env";
import { getUserCredential } from "@/lib/user-credentials";

export type TranscriptionConfig = {
  provider: "openai" | "litellm";
  apiKey: string;
  /** Full endpoint URL for audio/transcriptions. */
  url: string;
  model: string;
};

function litellmTranscriptionUrl(baseUrl: string) {
  // The stored base URL targets containers (host.docker.internal); the
  // transcription call runs in the SERVER process, where the tunnel is on
  // localhost.
  const hostBase = baseUrl.replace("host.docker.internal", "localhost").replace(/\/$/, "");
  return hostBase.endsWith("/v1") ? `${hostBase}/audio/transcriptions` : `${hostBase}/v1/audio/transcriptions`;
}

export async function resolveTranscriptionConfig(
  documentId: string,
  userId: string | null
): Promise<TranscriptionConfig | null> {
  const [docEnv, document] = await Promise.all([
    loadDocumentEnv(documentId),
    db.document.findUnique({ where: { id: documentId }, select: { ownerId: true } })
  ]);
  const ownerId = document?.ownerId ?? null;

  const openaiKey =
    docEnv.OPENAI_API_KEY?.trim() ||
    (userId ? (await getUserCredential(userId, "openai"))?.value : null) ||
    (ownerId && ownerId !== userId ? (await getUserCredential(ownerId, "openai"))?.value : null);
  if (openaiKey) {
    return {
      provider: "openai",
      apiKey: openaiKey,
      url: "https://api.openai.com/v1/audio/transcriptions",
      model: process.env.WHISPER_MODEL?.trim() || "whisper-1"
    };
  }

  const litellmKey =
    docEnv.LITELLM_API_KEY?.trim() ||
    (userId ? (await getUserCredential(userId, "litellm"))?.value : null) ||
    (ownerId && ownerId !== userId ? (await getUserCredential(ownerId, "litellm"))?.value : null);
  const litellmBase = docEnv.LITELLM_BASE_URL?.trim() || process.env.LITELLM_BASE_URL?.trim();
  if (litellmKey && litellmBase) {
    return {
      provider: "litellm",
      apiKey: litellmKey,
      url: process.env.LITELLM_TRANSCRIBE_URL?.trim() || litellmTranscriptionUrl(litellmBase),
      model: process.env.LITELLM_WHISPER_MODEL?.trim() || "whisper-1"
    };
  }

  return null;
}

export async function transcribeAudio(
  config: TranscriptionConfig,
  file: { bytes: Buffer; filename: string; mimetype: string }
): Promise<string> {
  const form = new FormData();
  form.append("model", config.model);
  form.append(
    "file",
    new Blob([new Uint8Array(file.bytes)], { type: file.mimetype || "application/octet-stream" }),
    file.filename
  );
  const response = await fetch(config.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Transcription failed (${config.provider}, http ${response.status}): ${detail.slice(0, 200)}`);
  }
  const payload = (await response.json().catch(() => null)) as { text?: string } | null;
  if (typeof payload?.text !== "string") {
    throw new Error(`Transcription returned no text (${config.provider}).`);
  }
  return payload.text.trim();
}

export const VOICE_SUPPORT_HINT =
  "🎙️ I received a voice message but can't transcribe it yet. To enable voice support, add an OpenAI API key " +
  "(AI credentials in the rdocs topbar — used only for Whisper transcription) or a LiteLLM key with a whisper model, " +
  "then send the voice note again.";
