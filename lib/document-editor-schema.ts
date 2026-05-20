import { getSchema } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import Underline from "@tiptap/extension-underline";
import StarterKit from "@tiptap/starter-kit";

import { CommentAnchor } from "@/components/document-workspace/comment-anchors";
import { EmbeddedWidgetSchemaNode, RepoImageSchemaNode } from "@/lib/document-schema-nodes";

export function createDocumentEditorSchema() {
  return getSchema([
    StarterKit,
    Underline,
    Image.configure({
      allowBase64: true,
      inline: false
    }),
    CommentAnchor,
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
