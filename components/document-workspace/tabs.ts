import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export type TabSummary = {
  id: string;
  title: string;
  // Position of the tabBreak node itself, or -1 for the implicit leading tab.
  breakPos: number;
  // [contentFrom, contentTo) — top-level positions covering blocks inside this tab.
  contentFrom: number;
  contentTo: number;
};

export const IMPLICIT_TAB_ID = "__implicit__";

export function listTabs(doc: ProseMirrorNode): TabSummary[] {
  const tabs: TabSummary[] = [];
  const docSize = doc.content.size;
  let current: TabSummary | null = null;

  doc.forEach((child, offset) => {
    if (child.type.name !== "tabBreak") return;
    if (current) {
      current.contentTo = offset;
      tabs.push(current);
    }
    const attrs = child.attrs as { tabId?: unknown; title?: unknown };
    const id = typeof attrs.tabId === "string" && attrs.tabId ? attrs.tabId : `tab-${offset}`;
    const title = typeof attrs.title === "string" && attrs.title ? attrs.title : "Untitled tab";
    current = {
      id,
      title,
      breakPos: offset,
      contentFrom: offset + child.nodeSize,
      contentTo: docSize
    };
  });

  if (current) tabs.push(current);
  return tabs;
}

export function findTabByPosition(tabs: TabSummary[], pos: number): TabSummary | null {
  for (const tab of tabs) {
    if (pos >= tab.contentFrom && pos <= tab.contentTo) return tab;
  }
  return tabs[tabs.length - 1] ?? null;
}

type TabsPluginState = {
  activeTabId: string | null;
};

const tabsPluginKey = new PluginKey<TabsPluginState>("tabs-visibility");

const SET_ACTIVE_TAB_META = "tabs:set-active";

export function createTabsVisibilityExtension(initialActiveTabId: string | null) {
  return Extension.create({
    name: "tabsVisibility",
    addKeyboardShortcuts() {
      const selectActiveTab = () => {
        const editor = this.editor;
        const tabs = listTabs(editor.state.doc);
        if (tabs.length === 0) return false;
        const activeId = tabsPluginKey.getState(editor.state)?.activeTabId ?? null;
        const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
        const from = activeTab.contentFrom;
        const to = Math.min(activeTab.contentTo, editor.state.doc.content.size);
        if (to <= from) return false;
        const $from = editor.state.doc.resolve(from);
        const $to = editor.state.doc.resolve(to);
        const tr = editor.state.tr.setSelection(TextSelection.between($from, $to));
        editor.view.dispatch(tr);
        return true;
      };
      return {
        "Mod-a": selectActiveTab,
        "Mod-A": selectActiveTab
      };
    },
    addProseMirrorPlugins() {
      return [
        new Plugin<TabsPluginState>({
          key: tabsPluginKey,
          state: {
            init: () => ({ activeTabId: initialActiveTabId }),
            apply(tr, state) {
              const meta = tr.getMeta(SET_ACTIVE_TAB_META);
              if (typeof meta === "string" || meta === null) {
                return { activeTabId: meta as string | null };
              }
              return state;
            }
          },
          props: {
            decorations(state) {
              const tabs = listTabs(state.doc);
              if (tabs.length === 0) return DecorationSet.empty;

              const pluginState = tabsPluginKey.getState(state);
              const activeId = pluginState?.activeTabId ?? null;
              const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
              const decorations: Decoration[] = [];

              state.doc.forEach((child, offset) => {
                const blockFrom = offset;
                const blockTo = offset + child.nodeSize;
                const inActive = blockFrom >= activeTab.contentFrom && blockTo <= activeTab.contentTo;
                const isOwnBreak = child.type.name === "tabBreak";
                if (inActive && !isOwnBreak) return;
                decorations.push(
                  Decoration.node(blockFrom, blockTo, {
                    class: "tab-hidden-block",
                    style: "display:none"
                  })
                );
              });

              return DecorationSet.create(state.doc, decorations);
            }
          }
        })
      ];
    }
  });
}

export function setActiveTab(editor: Editor, tabId: string | null) {
  const tr = editor.state.tr.setMeta(SET_ACTIVE_TAB_META, tabId);
  editor.view.dispatch(tr);
}

export function getActiveTabId(editor: Editor): string | null {
  const state = tabsPluginKey.getState(editor.state);
  return state?.activeTabId ?? null;
}

/**
 * If the doc has explicit tabBreaks but ALSO has content before the first
 * break, prepend a leading break so every block lives inside a named tab. We
 * pick a title from the first existing tab (sliding it left into the prelude
 * position) is not safe — instead we name the new leading tab "Tab 1" and let
 * the user rename. Returns the new active tab id if we created a leading break.
 */
export function normalizePreludeTab(editor: Editor): { createdTabId: string | null } {
  const doc = editor.state.doc;
  let firstBreakOffset = -1;
  doc.forEach((child, offset) => {
    if (firstBreakOffset !== -1) return;
    if (child.type.name === "tabBreak") {
      firstBreakOffset = offset;
    }
  });

  if (firstBreakOffset <= 0) {
    return { createdTabId: null };
  }

  // Skip normalization if the prelude is just one empty paragraph (the doc's
  // default placeholder); deleting that paragraph instead is cleaner than
  // wrapping it.
  let preludeHasContent = false;
  doc.forEach((child, offset) => {
    if (offset >= firstBreakOffset) return;
    if (child.type.name !== "paragraph" || child.textContent.length > 0 || child.content.size > 0) {
      preludeHasContent = true;
    }
  });

  const tabBreakType = editor.schema.nodes.tabBreak;
  if (!tabBreakType) return { createdTabId: null };

  if (!preludeHasContent) {
    // Drop the empty prelude paragraph(s).
    const tr = editor.state.tr.delete(0, firstBreakOffset);
    editor.view.dispatch(tr);
    return { createdTabId: null };
  }

  const newId = createTabId();
  const tr = editor.state.tr.insert(0, tabBreakType.create({ tabId: newId, title: "Tab 1" }));
  editor.view.dispatch(tr);
  return { createdTabId: newId };
}

/**
 * Ensure each tab has at least one paragraph after its tabBreak, so the editor
 * can place the cursor inside an "empty" tab. Returns true if the doc was mutated.
 */
export function ensureTabsHaveContent(editor: Editor): boolean {
  const doc = editor.state.doc;
  const paragraphType = editor.schema.nodes.paragraph;
  const tabBreakType = editor.schema.nodes.tabBreak;
  if (!paragraphType || !tabBreakType) return false;

  // Walk top-level children. When a tabBreak is immediately followed by another
  // tabBreak (or the end of the doc), insert an empty paragraph between them.
  const insertions: number[] = [];
  let prevWasBreak = false;
  let prevBreakEnd = -1;
  doc.forEach((child, offset) => {
    const isBreak = child.type.name === "tabBreak";
    if (prevWasBreak && isBreak) {
      insertions.push(prevBreakEnd);
    }
    prevWasBreak = isBreak;
    prevBreakEnd = offset + child.nodeSize;
  });
  // Trailing tabBreak with no content after.
  if (prevWasBreak) {
    insertions.push(prevBreakEnd);
  }

  if (insertions.length === 0) return false;

  let tr = editor.state.tr;
  // Insert from the end so earlier offsets remain valid.
  for (let i = insertions.length - 1; i >= 0; i -= 1) {
    tr = tr.insert(insertions[i], paragraphType.create());
  }
  editor.view.dispatch(tr);
  return true;
}

export function createTabId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `tab-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
