import { getSchema } from "@tiptap/core";
import ImageExtension from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import Underline from "@tiptap/extension-underline";
import StarterKit from "@tiptap/starter-kit";

import { AiEditRange } from "@/components/document-workspace/ai-edit-selections";
import { CommentAnchor } from "@/components/document-workspace/comment-anchors";
import {
  EmbeddedWidgetSchemaNode,
  RepoImageSchemaNode,
  commentThreadIdsAttributeSpec
} from "@/lib/document-schema-nodes";

const Image = ImageExtension.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      ...commentThreadIdsAttributeSpec
    };
  }
});

export function createDocumentEditorSchema() {
  return getSchema([
    StarterKit,
    Underline,
    Image.configure({
      allowBase64: true,
      inline: false
    }),
    CommentAnchor,
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
    EmbeddedWidgetSchemaNode
  ]);
}
