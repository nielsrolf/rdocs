import { stripCommentAnchorMarks } from "@/lib/content";

type JsonNode = {
  type?: string;
  text?: string;
  marks?: Array<Record<string, unknown>>;
  content?: JsonNode[];
  [key: string]: unknown;
};

function nodeSize(node: JsonNode): number {
  if (node.type === "text") {
    return typeof node.text === "string" ? node.text.length : 0;
  }

  const children = Array.isArray(node.content) ? node.content : [];
  const contentSize = children.reduce((total, child) => total + nodeSize(child), 0);
  return node.type === "doc" ? contentSize : contentSize + 2;
}

function addAnchorMark(marks: Array<Record<string, unknown>> | undefined, threadId: string) {
  const withoutSameAnchor = (marks ?? []).filter((mark) => {
    return mark.type !== "commentAnchor" || (mark.attrs as { threadId?: unknown } | undefined)?.threadId !== threadId;
  });

  return [
    ...withoutSameAnchor,
    {
      type: "commentAnchor",
      attrs: {
        threadId
      }
    }
  ];
}

function markNodeRange(node: JsonNode, pos: number, from: number, to: number, threadId: string): JsonNode {
  if (node.type === "text") {
    const text = typeof node.text === "string" ? node.text : "";
    const textEnd = pos + text.length;
    if (textEnd <= from || pos >= to) {
      return { ...node };
    }

    const markStart = Math.max(from, pos) - pos;
    const markEnd = Math.min(to, textEnd) - pos;
    if (markStart <= 0 && markEnd >= text.length) {
      return {
        ...node,
        marks: addAnchorMark(node.marks, threadId)
      };
    }

    return {
      _split: [
        markStart > 0
          ? {
              ...node,
              text: text.slice(0, markStart)
            }
          : null,
        {
          ...node,
          text: text.slice(markStart, markEnd),
          marks: addAnchorMark(node.marks, threadId)
        },
        markEnd < text.length
          ? {
              ...node,
              text: text.slice(markEnd)
            }
          : null
      ].filter(Boolean)
    };
  }

  if (!Array.isArray(node.content) || node.content.length === 0) {
    return { ...node };
  }

  let childPos = node.type === "doc" ? pos : pos + 1;
  const nextContent: JsonNode[] = node.content.flatMap((child): JsonNode[] => {
    const marked = markNodeRange(child, childPos, from, to, threadId);
    childPos += nodeSize(child);
    if (Array.isArray(marked._split)) {
      return marked._split as JsonNode[];
    }
    return [marked];
  });

  return {
    ...node,
    content: nextContent
  };
}

export function addCommentAnchorToContent(content: unknown, from: number, to: number, threadId: string) {
  if (
    !content ||
    typeof content !== "object" ||
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to <= from ||
    !threadId
  ) {
    return null;
  }

  return markNodeRange(content as JsonNode, 0, from, to, threadId);
}

export function differsOnlyByCommentAnchors(currentContent: unknown, nextContent: unknown) {
  return JSON.stringify(stripCommentAnchorMarks(currentContent)) === JSON.stringify(stripCommentAnchorMarks(nextContent));
}
