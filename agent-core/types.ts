// Shared, framework-free types for the agent runner. This module (and the rest
// of agent-core/) must NOT import from the Next.js app, Prisma, or the `@/`
// alias — it is imported both by the app and by the standalone container
// entrypoint, which has none of those available.

export type AiDocumentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      src: string;
      alt: string | null;
    }
  | {
      type: "repoImage";
      src: string | null;
      path: string | null;
      alt: string | null;
      caption: string | null;
    }
  | {
      type: "widget";
      widgetId: string | null;
      label: string;
      buildCmd: string | null;
      embedSource: string | null;
      src: string | null;
    };
