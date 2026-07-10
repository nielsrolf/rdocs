import { Extension } from "@tiptap/core";
import { collab, getVersion, sendableSteps } from "@tiptap/pm/collab";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import type { Mappable, Step } from "@tiptap/pm/transform";
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
  ctx: PositionContext | undefined,
  // True when the remote peer's presence is at a newer collab version than ours
  // — i.e. they've made edits (typically the char they just typed at the cursor)
  // that we haven't received yet. In that window `before` holds text absent from
  // our block, so we pin the cursor to the still-stable text AFTER it instead of
  // letting it render ahead of content that hasn't arrived.
  remoteAhead = false
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
  if (bestDist !== Infinity) return bestPos; // exact full-context match wins

  if (remoteAhead) {
    // The remote's just-typed char(s) aren't in our block yet, so the full
    // context can't match. Anchor to the start of the stable `after` text (the
    // cursor sits immediately before it) so we don't draw past missing content.
    if (ctx.after) {
      let bestAfter = -1;
      let bestAfterDist = Infinity;
      for (let idx = blockText.indexOf(ctx.after); idx !== -1; idx = blockText.indexOf(ctx.after, idx + 1)) {
        const candidate = blockStart + idx;
        const dist = Math.abs(candidate - mappedPos);
        if (dist < bestAfterDist) {
          bestAfterDist = dist;
          bestAfter = candidate;
        }
      }
      if (bestAfter !== -1) return bestAfter;
    }
    // Typing at the end of the block (no stable `after`): clamp to the current
    // block end rather than one char past it.
    return Math.min(mappedPos, blockStart + blockText.length);
  }

  return bestPos;
}

// Maximum collaboration steps allowed in a single /collaboration push. A large
// edit (a big AI reformat, a paste of a long document) can produce hundreds of
// ProseMirror steps at once; the server caps a single POST at this many steps
// (the zod `.max()` in app/api/documents/[id]/collaboration/route.ts), so the
// client MUST chunk a large flush into batches no larger than this. A push that
// exceeds the cap is rejected with a non-recoverable 400 ("steps:too_big"), and
// because the buffer never drains the tab is stranded on "Save failed" forever.
// Keep this value in lockstep with the server cap in that route.
export const COLLAB_MAX_STEPS_PER_PUSH = 200;

// Decide what a single push should send from the current unconfirmed-step
// buffer. Sends at most `max` steps; once those are confirmed the collab plugin
// advances its version and the next flush picks up where this one left off, so
// an arbitrarily large edit drains over several round-trips without ever
// tripping the server cap. `isFinalBatch` is true when this push drains the
// whole buffer — the caller attaches one-shot AI-edit version metadata only
// then, so the version snapshot captures the complete post-edit content rather
// than an intermediate chunk.
export function planCollaborationPush<T>(
  steps: readonly T[],
  max: number = COLLAB_MAX_STEPS_PER_PUSH
): { batch: T[]; isFinalBatch: boolean } {
  const batch = steps.slice(0, max);
  return { batch, isFinalBatch: batch.length === steps.length };
}

// Decide how to recover from an UNRECOVERABLE divergence — the local doc has
// drifted so far from the server's confirmed version that prosemirror-collab can
// no longer rebase the pending steps (applyCollaborationPayload threw). Mirrors
// `git`: a sole editor force-pushes its branch; with collaborators present we
// must not clobber their work, so the user resolves a manual merge instead. The
// server re-checks presence authoritatively, so a force-push it refuses falls
// back to the merge path. Pure so it is unit-testable.
export function planDivergenceRecovery(input: {
  otherClientsPresent: boolean;
}): "force-push" | "manual-merge" {
  return input.otherClientsPresent ? "manual-merge" : "force-push";
}

export type ReceivedMappingEntry = {
  versionBefore: number;
  mapping: Mapping;
};

// Build the received-mapping buffer entry for a confirmed batch of steps
// (covering server versions [versionBefore, versionBefore + steps.length)).
//
// The mapping MUST come from the steps themselves (server-canonical), not from
// the receiveTransaction that applied them: when the batch is our OWN steps
// being confirmed after a push, that transaction changes nothing locally and
// its mapping is empty — recording it made remote cursors snap back to their
// pre-edit position the moment our typing was confirmed (the "jumping cursor"
// while a collaborator types). For foreign steps with no local unconfirmed
// work the two are identical, so step maps are correct in every case.
export function buildReceivedMappingEntry(
  versionBefore: number,
  steps: readonly Step[]
): ReceivedMappingEntry {
  return { versionBefore, mapping: new Mapping(steps.map((step) => step.getMap())) };
}

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
      const stepCount = entry.mapping.maps.length;
      if (entry.versionBefore >= remoteVersion) {
        result = entry.mapping.map(result, bias);
      } else if (entry.versionBefore + stepCount > remoteVersion) {
        // The batch straddles the remote's version: apply only the step maps
        // for versions the remote has not yet incorporated.
        result = entry.mapping.slice(remoteVersion - entry.versionBefore).map(result, bias);
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
              const reanchor = (mappedPos: number, ctx?: PositionContext, remoteAhead = false) => {
                if (!ctx) return mappedPos;
                const clamped = Math.max(0, Math.min(mappedPos, maxPos));
                try {
                  const resolved = state.doc.resolve(clamped);
                  if (!resolved.parent.isTextblock) return clamped;
                  const blockStart = resolved.start();
                  const blockText = state.doc.textBetween(blockStart, resolved.end());
                  return reanchorWithinBlock(blockText, blockStart, clamped, ctx, remoteAhead);
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
                // The peer reports a newer version than we've applied: they've
                // edited (usually typed at their cursor) ahead of the steps we've
                // received, so pin positions to stable text instead of rendering
                // ahead of not-yet-arrived content.
                const remoteAhead = remoteVersion > localVersion;
                const mappedFrom = reanchor(mapPosition(selection.from, remoteVersion, -1), context?.from, remoteAhead);
                const mappedTo = reanchor(mapPosition(selection.to, remoteVersion, 1), context?.to, remoteAhead);
                const mappedHead = reanchor(mapPosition(selection.head, remoteVersion, -1), context?.head, remoteAhead);

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
