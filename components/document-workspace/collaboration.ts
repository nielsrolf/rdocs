import { Extension } from "@tiptap/core";
import { collab, getVersion, sendableSteps } from "@tiptap/pm/collab";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Mapping } from "@tiptap/pm/transform";
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
    version: number;
  } | null;
  typing: boolean;
  lastSeen: number;
};

export type ReceivedMappingEntry = {
  versionBefore: number;
  mapping: Mapping;
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

export function createRemotePresenceExtension(
  remotePresenceRef: MutableRefObject<RemotePresenceView[]>,
  receivedMappingsRef: MutableRefObject<ReceivedMappingEntry[]>
) {
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
              const localVersion = getVersion(state);
              const unconfirmed = sendableSteps(state);
              const unconfirmedMaps = unconfirmed?.steps.map((step) => step.getMap()) ?? [];
              const buffer = receivedMappingsRef.current;

              const mapPosition = (pos: number, remoteVersion: number, bias: number) => {
                let result = pos;
                if (remoteVersion < localVersion) {
                  for (const entry of buffer) {
                    if (entry.versionBefore >= remoteVersion) {
                      result = entry.mapping.map(result, bias);
                    }
                  }
                }
                for (const map of unconfirmedMaps) {
                  result = map.map(result, bias);
                }
                return result;
              };

              remotePresenceRef.current.forEach((presence) => {
                const selection = presence.selection;
                if (!selection) {
                  return;
                }

                const remoteVersion = selection.version;
                const mappedFrom = mapPosition(selection.from, remoteVersion, -1);
                const mappedTo = mapPosition(selection.to, remoteVersion, 1);
                const mappedHead = mapPosition(selection.head, remoteVersion, -1);

                const from = Math.max(0, Math.min(mappedFrom, maxPos));
                const to = Math.max(from, Math.min(mappedTo, maxPos));
                const head = Math.max(0, Math.min(mappedHead, maxPos));

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
