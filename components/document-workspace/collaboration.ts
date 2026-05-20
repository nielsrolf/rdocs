import { Extension } from "@tiptap/core";
import { collab } from "@tiptap/pm/collab";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { MutableRefObject } from "react";

export type RemotePresenceView = {
  clientId: string;
  userId: string | null;
  userName: string;
  color: string;
  selection: {
    anchor: number;
    head: number;
    from: number;
    to: number;
  } | null;
  typing: boolean;
  lastSeen: number;
};

export function createCollaborationExtension(version: number, clientID: string) {
  return Extension.create({
    name: "documentCollaboration",
    priority: 1000,
    addProseMirrorPlugins() {
      return [
        collab({
          version,
          clientID
        })
      ];
    }
  });
}

export function createRemotePresenceExtension(remotePresenceRef: MutableRefObject<RemotePresenceView[]>) {
  return Extension.create({
    name: "remotePresence",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: new PluginKey("remotePresence"),
          props: {
            decorations(state) {
              const decorations: Decoration[] = [];
              const maxPos = state.doc.content.size;

              remotePresenceRef.current.forEach((presence) => {
                const selection = presence.selection;
                if (!selection) {
                  return;
                }

                const from = Math.max(0, Math.min(selection.from, maxPos));
                const to = Math.max(from, Math.min(selection.to, maxPos));
                const head = Math.max(0, Math.min(selection.head, maxPos));

                if (to > from) {
                  decorations.push(
                    Decoration.inline(from, to, {
                      class: "remote-collab-selection",
                      style: `background-color: ${presence.color}33;`
                    })
                  );
                }

                decorations.push(
                  Decoration.widget(
                    head,
                    () => {
                      const cursor = document.createElement("span");
                      cursor.className = "remote-collab-cursor";
                      cursor.style.borderColor = presence.color;
                      cursor.style.setProperty("--remote-collab-color", presence.color);
                      cursor.dataset.name = presence.typing
                        ? `${presence.userName} is typing`
                        : presence.userName;
                      return cursor;
                    },
                    {
                      key: `remote-cursor:${presence.clientId}:${presence.lastSeen}`,
                      side: -1
                    }
                  )
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
