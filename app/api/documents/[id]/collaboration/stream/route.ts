import { requireDocumentAccess, type RouteContext } from "@/lib/api-helpers";
import { subscribeToCollaboration } from "@/lib/collaboration";

const STREAM_RETRY_MS = 1000;

export async function GET(request: Request, { params }: RouteContext<{ id: string }>) {
  const { id } = await params;
  const url = new URL(request.url);
  const clientId = url.searchParams.get("clientId") ?? "";

  if (!clientId) {
    return new Response("Missing clientId", { status: 400 });
  }

  const gate = await requireDocumentAccess(request, id, "VIEW");
  if (!gate.ok) {
    return gate.response;
  }
  const { access } = gate;

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
      // Server-initiated end (blue/green drain handover): stop pinging and end
      // the response so the browser's EventSource reconnects — through the
      // load balancer, i.e. to the new process.
      const close = () => {
        if (keepAlive) {
          clearInterval(keepAlive);
          keepAlive = null;
        }
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      };

      // Reconnect quickly after a drop or a drain handover (browser default is
      // ~3-5 s, during which the tab falls back to 500 ms polling).
      controller.enqueue(encoder.encode(`retry: ${STREAM_RETRY_MS}\n\n`));

      unsubscribe = subscribeToCollaboration({
        documentId: id,
        rawContent: access.document.content,
        currentUpdatedAt: access.document.updatedAt,
        clientId,
        send,
        close
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
