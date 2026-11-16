import Table from "@tiptap/extension-table";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { columnResizing, tableEditing } from "@tiptap/pm/tables";

// Width an unsized column counts for. A table is at least (columns x this)
// wide, so a table with more columns than the page can hold scrolls sideways
// inside its `.tableWrapper` instead of squeezing every column.
export const TABLE_AUTO_COLUMN_MIN_WIDTH = 120;

// Narrowest width a column can be dragged to.
export const TABLE_RESIZED_COLUMN_MIN_WIDTH = 40;

// The document table: always rendered inside a horizontally scrollable
// `.tableWrapper`, with column widths stored in the cells' `colwidth` attr
// (part of the stock cell schema, so client and server schemas stay equal).
//
// `resizable` only decides whether the drag handles exist. The wrapper node
// view is installed either way: stock TipTap drops it for a non-editable or
// non-resizable editor, which would leave readers without the scroll container.
// Suggest-only users must not get the handles: a width change is a change to
// committed content, which the collab guard rejects for them.
export const DocumentTable = Table.extend({
  addOptions() {
    return {
      ...this.parent?.(),
      resizable: false,
      renderWrapper: true,
      cellMinWidth: TABLE_AUTO_COLUMN_MIN_WIDTH
    };
  },

  addProseMirrorPlugins() {
    const { View, cellMinWidth, handleWidth, lastColumnResizable, allowTableNodeSelection } = this.options;
    const layout = this.options.resizable
      ? columnResizing({
          handleWidth,
          cellMinWidth: TABLE_RESIZED_COLUMN_MIN_WIDTH,
          defaultCellMinWidth: cellMinWidth,
          View,
          lastColumnResizable
        })
      : new Plugin({
          key: new PluginKey("tableScrollWrapper"),
          props: {
            nodeViews: View
              ? { [this.name]: (node, view) => new View(node, cellMinWidth, view) }
              : {}
          }
        });
    return [layout, tableEditing({ allowTableNodeSelection })];
  }
});
