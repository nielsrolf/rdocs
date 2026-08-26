import { Mark, mergeAttributes } from "@tiptap/core";

export const HIGHLIGHT_COLORS = ["yellow", "red", "green"] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

export function isHighlightColor(value: unknown): value is HighlightColor {
  return typeof value === "string" && HIGHLIGHT_COLORS.includes(value as HighlightColor);
}

// A deliberately small, semantic palette. Storing names rather than raw CSS
// colors keeps old documents stable if the visual theme changes later.
export const TextHighlight = Mark.create({
  name: "textHighlight",
  inclusive: false,
  addAttributes() {
    return {
      color: {
        default: "yellow",
        parseHTML: (element) => {
          const value = element.getAttribute("data-highlight-color");
          return isHighlightColor(value) ? value : "yellow";
        },
        renderHTML: (attributes) => ({
          "data-highlight-color": isHighlightColor(attributes.color) ? attributes.color : "yellow"
        })
      }
    };
  },
  parseHTML() {
    return [{ tag: "mark[data-highlight-color]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["mark", mergeAttributes(HTMLAttributes), 0];
  }
});
