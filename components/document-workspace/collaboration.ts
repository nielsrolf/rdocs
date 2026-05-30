import { Extension } from "@tiptap/core";
import { collab, getVersion, sendableSteps } from "@tiptap/pm/collab";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Mappable, Mapping } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { MutableRefObject } from "react";

// A few characters of text immediately before/after a position, captured within
// the position's text block. Used to re-anchor a remote cursor/selection if OT
// mapping drifts during sync (the "jumping cursor" fix).
export type PositionContext = { before: string; after: string };

export type SelectionContext = {
  from: PositionContext;
  to: PositionContext;
  head: PositionContext;
};

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
    context?: SelectionContext | null;
  } | null;
  typing: boolean;
  lastSeen: number;
};

// Correct a mapped remote position by locating its captured surrounding text
// within the SAME text block. ProseMirror positions and plain-text offsets line
// up 1:1 inside a single text block, so `blockStart + textIndex` is an exact
// position. If the text at the mapped spot already matches the context it's a
// no-op; if the context can't be found we keep the mapped position. This makes
// the function a safe corrective layer over OT mapping — it only moves a cursor
// when it can prove the better spot, eliminating the transient "jump" without
// risking worse placement. Pure, so it's unit-testable with plain strings.
export function reanchorWithinBlock(
  blockText: string,
  blockStart: number,
  mappedPos: number,
  ctx: PositionContext | undefined
): number {
  if (!ctx) return mappedPos;
  const target = ctx.before + ctx.after;
  if (!target) return mappedPos;

  const guess = mappedPos - blockStart; // text index the OT mapping points at
  const here = blockText.slice(Math.max(0, guess - ctx.before.length), guess + ctx.after.length);
  if (here === target) return mappedPos; // already correct — no jump needed

  let bestPos = mappedPos;
  let bestDist = Infinity;
  for (let idx = blockText.indexOf(target); idx !== -1; idx = blockText.indexOf(target, idx + 1)) {
    const candidate = blockStart + idx + ctx.before.length;
    const dist = Math.abs(candidate - mappedPos);
    if (dist < bestDist) {
      bestDist = dist;
      bestPos = candidate;
    }
  }
  return bestPos;
}

export type ReceivedMappingEntry = {
  versionBefore: number;
  mapping: Mapping;
};

// Shape of a /collaboration step push/pull response (and the SSE "steps" event).
export type CollaborationStepResponse = {
  accepted?: boolean;
  steps?: unknown[];
  clientIds?: Array<string | number>;
  fromVersion?: number;
  version?: number;
  updatedAt?: string | null;
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

              // Correct OT drift by re-finding the captured surrounding text in
              // the same block. A no-op when the mapped spot already matches, and
              // a safe fallback (returns the mapped position) when it doesn't.
              const reanchor = (mappedPos: number, ctx?: PositionContext) => {
                if (!ctx) return mappedPos;
                const clamped = Math.max(0, Math.min(mappedPos, maxPos));
                try {
                  const resolved = state.doc.resolve(clamped);
                  if (!resolved.parent.isTextblock) return clamped;
                  const blockStart = resolved.start();
                  const blockText = state.doc.textBetween(blockStart, resolved.end());
                  return reanchorWithinBlock(blockText, blockStart, clamped, ctx);
                } catch {
                  return clamped;
                }
              };

              remotePresenceRef.current.forEach((presence) => {
                const selection = presence.selection;
                if (!selection) {
                  return;
                }

                const remoteVersion = selection.version;
                const context = selection.context ?? undefined;
                const mappedFrom = reanchor(mapPosition(selection.from, remoteVersion, -1), context?.from);
                const mappedTo = reanchor(mapPosition(selection.to, remoteVersion, 1), context?.to);
                const mappedHead = reanchor(mapPosition(selection.head, remoteVersion, -1), context?.head);

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
