import { getSchema } from "@tiptap/core";
import ImageExtension from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import Underline from "@tiptap/extension-underline";
import StarterKit from "@tiptap/starter-kit";

import { AiEditRange } from "@/components/document-workspace/ai-edit-selections";
import { CommentAnchor } from "@/components/document-workspace/comment-anchors";
import { Mention } from "@/components/document-workspace/mention";
import {
  AttachmentChipSchemaNode,
  EmbeddedWidgetSchemaNode,
  RepoImageSchemaNode,
  TabBreakSchemaNode,
  aiEditSelectionIdsAttributeSpec,
  commentThreadIdsAttributeSpec
} from "@/lib/document-schema-nodes";

const Image = ImageExtension.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      ...commentThreadIdsAttributeSpec,
      ...aiEditSelectionIdsAttributeSpec
    };
  }
});

export function createDocumentEditorSchema() {
  return getSchema([
    StarterKit,
    Underline,
    TaskList,
    TaskItem.configure({ nested: true }),
    Image.configure({
      allowBase64: true,
      inline: false
    }),
    CommentAnchor,
    Mention,
    AiEditRange,
    Link.configure({
      openOnClick: false,
      autolink: true,
      defaultProtocol: "https"
    }),
    Table.configure({
      resizable: false
    }),
    TableRow,
    TableHeader,
    TableCell,
    RepoImageSchemaNode,
    EmbeddedWidgetSchemaNode,
    AttachmentChipSchemaNode,
    TabBreakSchemaNode
  ]);
}
