import { Node, mergeAttributes } from "@tiptap/core";

export const commentThreadIdsAttributeSpec = {
  commentThreadIds: {
    default: [] as string[],
    parseHTML: (element: HTMLElement) => {
      const raw = element.getAttribute("data-comment-thread-ids");
      if (!raw) return [];
      return raw.split(",").map((value) => value.trim()).filter(Boolean);
    },
    renderHTML: (attributes: { commentThreadIds?: unknown }) => {
      const ids = Array.isArray(attributes.commentThreadIds) ? attributes.commentThreadIds : [];
      if (ids.length === 0) return {};
      return { "data-comment-thread-ids": ids.join(",") };
    }
  }
};

export const RepoImageSchemaNode = Node.create({
  name: "repoImage",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: "" },
      alt: { default: "Repository image" },
      caption: {
        default: null,
        parseHTML: (element) => element.getAttribute("caption") || null
      },
      path: {
        default: null,
        parseHTML: (element) => element.getAttribute("path") || null
      },
      ...commentThreadIdsAttributeSpec
    };
  },
  parseHTML() {
    return [{ tag: "figure[data-repo-image]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["figure", mergeAttributes(HTMLAttributes, { "data-repo-image": "" })];
  }
});

export const TabBreakSchemaNode = Node.create({
  name: "tabBreak",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  defining: true,
  addAttributes() {
    return {
      tabId: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-tab-id") || "",
        renderHTML: (attributes) => {
          const id = typeof attributes.tabId === "string" ? attributes.tabId : "";
          return id ? { "data-tab-id": id } : {};
        }
      },
      title: {
        default: "Untitled tab",
        parseHTML: (element) => element.getAttribute("data-tab-title") || "Untitled tab",
        renderHTML: (attributes) => {
          const title = typeof attributes.title === "string" ? attributes.title : "Untitled tab";
          return { "data-tab-title": title };
        }
      }
    };
  },
  parseHTML() {
    return [{ tag: "div[data-tab-break]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-tab-break": "" })];
  }
});

export const EmbeddedWidgetSchemaNode = Node.create({
  name: "embeddedWidget",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      widgetId: {
        default: null,
        parseHTML: (element) => element.getAttribute("widgetid") || element.getAttribute("widgetId")
      },
      documentId: {
        default: null,
        parseHTML: (element) => element.getAttribute("documentid") || element.getAttribute("documentId")
      },
      shareToken: {
        default: null,
        parseHTML: (element) => element.getAttribute("sharetoken") || element.getAttribute("shareToken")
      },
      label: { default: "Interactive widget" },
      buildCmd: {
        default: "",
        parseHTML: (element) => element.getAttribute("buildcmd") || element.getAttribute("buildCmd") || ""
      },
      embedSource: {
        default: "",
        parseHTML: (element) => element.getAttribute("embedsource") || element.getAttribute("embedSource") || ""
      },
      src: { default: "" },
      collapsed: {
        default: true,
        parseHTML: (element) => element.getAttribute("collapsed") !== "false",
        renderHTML: (attributes) => ({
          collapsed: attributes.collapsed === false ? "false" : "true"
        })
      },
      ...commentThreadIdsAttributeSpec
    };
  },
  parseHTML() {
    return [{ tag: "div[data-embedded-widget]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-embedded-widget": "" })];
  }
});
