import { Extension } from "@tiptap/core";
import { collab, getVersion, sendableSteps } from "@tiptap/pm/collab";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Mappable, Mapping } from "@tiptap/pm/transform";
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

// Map a remote collaborator's position (captured at `remoteVersion`) into the
// local document's current coordinate space. This is the core of correct remote
// cursor/selection rendering: when the local user edits an EARLIER part of the
// document, every remote position after the insertion must shift by the same
// amount, otherwise the remote cursor/selection is drawn at the wrong place.
//
// We apply (a) the mappings we received for steps at or after the remote's
// version, then (b) our own not-yet-confirmed local step maps. Exported as a
// pure function so it can be regression-tested headlessly.
export function mapRemotePosition(
  pos: number,
  remoteVersion: number,
  bias: number,
  localVersion: number,
  receivedMappings: ReceivedMappingEntry[],
  unconfirmedMaps: Mappable[]
): number {
  let result = pos;
  if (remoteVersion < localVersion) {
    for (const entry of receivedMappings) {
      if (entry.versionBefore >= remoteVersion) {
        result = entry.mapping.map(result, bias);
      }
    }
  }
  for (const map of unconfirmedMaps) {
    result = map.map(result, bias);
  }
  return result;
}

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

              const mapPosition = (pos: number, remoteVersion: number, bias: number) =>
                mapRemotePosition(pos, remoteVersion, bias, localVersion, buffer, unconfirmedMaps);

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
