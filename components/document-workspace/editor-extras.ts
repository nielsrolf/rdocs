import { Extension, InputRule } from "@tiptap/core";
import TaskItemBase from "@tiptap/extension-task-item";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";

export const StrikeShortcut = Extension.create({
  name: "strikeShortcut",
  addKeyboardShortcuts() {
    return {
      "Mod-Shift-x": () => this.editor.commands.toggleStrike()
    };
  }
});

function tryMoveBlockAtDepth(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  depth: number,
  dir: 1 | -1
) {
  const { $from } = state.selection;
  if (depth < 1 || depth > $from.depth) return false;

  const node = $from.node(depth);
  if (!node.isBlock) return false;

  const parent = $from.node(depth - 1);
  const index = $from.index(depth - 1);
  const newIndex = index + dir;
  if (newIndex < 0 || newIndex >= parent.childCount) return false;

  const parentStart = depth - 1 === 0 ? 0 : $from.start(depth - 1);
  let blockStart = parentStart;
  for (let i = 0; i < index; i++) blockStart += parent.child(i).nodeSize;
  const block = parent.child(index);
  const other = parent.child(newIndex);

  const tr = state.tr;
  const blockEnd = blockStart + block.nodeSize;
  let newBlockStart: number;

  if (dir === 1) {
    tr.delete(blockStart, blockEnd);
    newBlockStart = blockStart + other.nodeSize;
    tr.insert(newBlockStart, block);
  } else {
    const otherStart = blockStart - other.nodeSize;
    tr.delete(blockStart, blockEnd);
    newBlockStart = otherStart;
    tr.insert(newBlockStart, block);
  }

  const oldFrom = state.selection.from;
  const offsetInBlock = oldFrom - blockStart;
  const targetPos = newBlockStart + Math.max(1, Math.min(block.nodeSize - 1, offsetInBlock));

  try {
    tr.setSelection(TextSelection.create(tr.doc, targetPos));
  } catch {
    // selection restoration is best-effort
  }

  if (dispatch) dispatch(tr.scrollIntoView());
  return true;
}

function moveBlock(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined, dir: 1 | -1) {
  const { $from } = state.selection;
  for (let d = $from.depth; d >= 1; d--) {
    if (tryMoveBlockAtDepth(state, dispatch, d, dir)) return true;
  }
  return false;
}

export const MoveBlock = Extension.create({
  name: "moveBlock",
  addKeyboardShortcuts() {
    return {
      "Alt-ArrowUp": ({ editor }) => moveBlock(editor.state, editor.view.dispatch, -1),
      "Alt-ArrowDown": ({ editor }) => moveBlock(editor.state, editor.view.dispatch, 1)
    };
  }
});

const slashTabRegex = /^\/tab\s$/;

export const SlashTab = Extension.create<{
  onInsertTab?: () => boolean;
}>({
  name: "slashTab",
  addOptions() {
    return { onInsertTab: undefined };
  },
  addInputRules() {
    return [
      new InputRule({
        find: slashTabRegex,
        handler: ({ state, range, chain }) => {
          // Only fire when the rule consumes the entire current block's text.
          const $from = state.doc.resolve(range.from);
          const parent = $from.parent;
          if (parent.type.name !== "paragraph") return null;
          if ($from.parentOffset !== 0) return null;

          const handler = this.options.onInsertTab;
          chain()
            .command(({ tr }) => {
              tr.delete(range.from, range.to);
              return true;
            })
            .run();
          if (handler) {
            // Run async so the input-rule transaction commits first.
            queueMicrotask(() => handler());
          }
        }
      })
    ];
  }
});

const taskCheckboxRegex = /^\s*\[([ xX])\]\s$/;

export const TaskItem = TaskItemBase.extend({
  addInputRules() {
    const parentRules = this.parent?.() ?? [];
    return [
      new InputRule({
        find: taskCheckboxRegex,
        handler: ({ state, range, match, chain }) => {
          const checked = match[1] !== " ";
          const $start = state.doc.resolve(range.from);

          let listItemDepth = -1;
          let bulletListDepth = -1;
          for (let d = $start.depth; d > 0; d--) {
            const name = $start.node(d).type.name;
            if (name === "listItem" && listItemDepth === -1) listItemDepth = d;
            if (name === "bulletList" && bulletListDepth === -1) bulletListDepth = d;
          }

          if (listItemDepth === -1 || bulletListDepth === -1) {
            return null;
          }

          const taskItemType = state.schema.nodes.taskItem;
          const taskListType = state.schema.nodes.taskList;
          if (!taskItemType || !taskListType) return null;

          const bulletListPos = $start.before(bulletListDepth);
          const currentListItemIndex = $start.index(bulletListDepth);

          chain()
            .command(({ tr }) => {
              tr.delete(range.from, range.to);
              const bulletList = tr.doc.nodeAt(bulletListPos);
              if (!bulletList) return false;

              let pos = bulletListPos + 1;
              for (let i = 0; i < bulletList.childCount; i++) {
                const child = bulletList.child(i);
                if (child.type.name === "listItem") {
                  tr.setNodeMarkup(pos, taskItemType, {
                    ...child.attrs,
                    checked: i === currentListItemIndex ? checked : false
                  });
                }
                pos += child.nodeSize;
              }
              tr.setNodeMarkup(bulletListPos, taskListType);
              return true;
            })
            .run();
        }
      }),
      ...parentRules
    ];
  }
});
