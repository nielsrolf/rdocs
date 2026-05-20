import { getCurrentUser } from "@/lib/auth";
import { subscribeToCollaboration } from "@/lib/collaboration";
import { resolveDocumentAccess } from "@/lib/permissions";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();
  const url = new URL(request.url);
  const shareToken = url.searchParams.get("share");
  const clientId = url.searchParams.get("clientId") ?? "";

  if (!clientId) {
    return new Response("Missing clientId", { status: 400 });
  }

  const access = await resolveDocumentAccess(id, user?.id, shareToken);
  if (!access) {
    return new Response("Document not found", { status: 404 });
  }

  const encoder = new TextEncoder();
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, payload: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
        );
      };

      unsubscribe = subscribeToCollaboration({
        documentId: id,
        rawContent: access.document.content,
        currentUpdatedAt: access.document.updatedAt,
        clientId,
        send
      });

      keepAlive = setInterval(() => {
        send("ping", { now: Date.now() });
      }, 15_000);
    },
    cancel() {
      if (keepAlive) {
        clearInterval(keepAlive);
      }
      unsubscribe?.();
    }
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream"
    }
  });
}
