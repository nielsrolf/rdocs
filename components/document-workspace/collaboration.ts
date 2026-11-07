import { Extension } from "@tiptap/core";
import { collab, getVersion, sendableSteps } from "@tiptap/pm/collab";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import type { Mappable, Step } from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { MutableRefObject } from "react";

export type RemoteSelection = {
  anchor: number;
  head: number;
  from: number;
  to: number;
  // The collab version the positions are expressed against: the sender's
  // CONFIRMED version, with positions mapped back out of their unconfirmed
  // steps (see buildPresenceSelection).
  version: number;
};

export type RemotePresenceView = {
  clientId: string;
  userId: string | null;
  userName: string;
  color: string;
  selection: RemoteSelection | null;
  typing: boolean;
  lastSeen: number;
};

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
  // Author of each step (parallel to mapping.maps). Lets a remote cursor follow
  // its OWNER's typing (assoc +1) while staying put when someone else inserts
  // at the same spot.
  clientIds?: ReadonlyArray<string | number>;
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
  steps: readonly Step[],
  clientIds?: ReadonlyArray<string | number>
): ReceivedMappingEntry {
  return {
    versionBefore,
    mapping: new Mapping(steps.map((step) => step.getMap())),
    ...(clientIds ? { clientIds } : {})
  };
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

// Map a remote collaborator's position (expressed at `remoteVersion`) into the
// local document's current coordinate space: through every confirmed step at or
// after the remote's version, then through our own not-yet-confirmed steps.
//
// `bias` decides which side of an insertion at exactly this point the position
// ends up on. When `ownerClientId` is given, steps authored by the presence's
// owner use +1 instead, so their caret follows their own typing.
export function mapRemotePosition(
  pos: number,
  remoteVersion: number,
  bias: number,
  localVersion: number,
  receivedMappings: ReceivedMappingEntry[],
  unconfirmedMaps: Mappable[],
  ownerClientId?: string
): number {
  let result = pos;
  if (remoteVersion < localVersion) {
    for (const entry of receivedMappings) {
      const maps = entry.mapping.maps;
      for (let index = 0; index < maps.length; index += 1) {
        if (entry.versionBefore + index < remoteVersion) continue;
        const author = entry.clientIds?.[index];
        const assoc =
          ownerClientId !== undefined && author !== undefined && String(author) === ownerClientId ? 1 : bias;
        result = maps[index].map(result, assoc);
      }
    }
  }
  for (const map of unconfirmedMaps) {
    result = map.map(result, bias);
  }
  return result;
}

// The local selection as presence, in the coordinates of our CONFIRMED version.
//
// Our editor positions already include our unconfirmed (not yet accepted by
// the server) steps, but the only version a receiver can map from is the
// confirmed one. Sending local positions labelled with the confirmed version
// made receivers apply our edit twice once our steps reached them: the cursor
// was drawn ahead of text they didn't have yet, then jumped, and a selection
// made after an edit stayed on the wrong text (2026-11-07 report). So map the
// selection back out of the unconfirmed steps; receivers then map it forward
// through the same steps when they arrive and land exactly on it.
export function buildPresenceSelection(state: EditorState): RemoteSelection {
  const sendable = sendableSteps(state);
  const inverse =
    sendable && sendable.steps.length > 0
      ? new Mapping(sendable.steps.map((step) => step.getMap())).invert()
      : null;
  const back = (pos: number, assoc: number) => (inverse ? inverse.map(pos, assoc) : pos);
  const { anchor, head, from, to } = state.selection;
  return {
    anchor: back(anchor, -1),
    head: back(head, -1),
    from: back(from, -1),
    to: back(to, 1),
    version: getVersion(state)
  };
}

// Where to draw a remote peer's selection in OUR document.
export function mapRemoteSelection(
  selection: { from: number; to: number; head: number; version: number },
  localVersion: number,
  receivedMappings: ReceivedMappingEntry[],
  unconfirmedMaps: Mappable[],
  ownerClientId?: string
) {
  const map = (pos: number, bias: number) =>
    mapRemotePosition(pos, selection.version, bias, localVersion, receivedMappings, unconfirmedMaps, ownerClientId);
  return { from: map(selection.from, -1), to: map(selection.to, 1), head: map(selection.head, -1) };
}

// Presence and steps travel separately, so a peer's presence can arrive
// claiming a version we haven't applied yet: its positions refer to text that
// isn't in our document. Drawing it then is the "cursor offset applied before
// the document diff" jump. Keep showing their last presence we CAN map until
// the steps arrive (the decorations recompute when they do).
export function pickRenderablePresence(
  current: RemotePresenceView,
  previous: RemotePresenceView | undefined,
  localVersion: number
): RemotePresenceView | null {
  if (!current.selection || current.selection.version <= localVersion) return current;
  if (previous?.selection && previous.selection.version <= localVersion) {
    return { ...current, selection: previous.selection };
  }
  return null;
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

export const REMOTE_CURSOR_LABEL_CLASS = "remote-collab-cursor-label";
export const REMOTE_CURSOR_LABEL_HIDDEN_CLASS = "remote-collab-cursor-label-hidden";

export type CaretBox = { left: number; right: number; top: number; bottom: number };

// True when a remote name label overlaps the local caret (with a few px of
// slack so a label grazing the caret also yields).
export function labelCoversCaret(label: CaretBox, caret: CaretBox, slack = 3): boolean {
  return (
    label.left - slack < caret.right &&
    label.right + slack > caret.left &&
    label.top - slack < caret.bottom &&
    label.bottom + slack > caret.top
  );
}

function hideLabelsCoveringLocalCaret(view: EditorView) {
  if (view.isDestroyed) return;
  const labels = view.dom.querySelectorAll<HTMLElement>(`.${REMOTE_CURSOR_LABEL_CLASS}`);
  if (labels.length === 0) return;
  let caret: CaretBox | null = null;
  try {
    const coords = view.coordsAtPos(view.state.selection.head);
    // coordsAtPos gives a zero-width box; widen it to the caret's 2px stroke.
    caret = { left: coords.left - 1, right: coords.right + 1, top: coords.top, bottom: coords.bottom };
  } catch {
    caret = null;
  }
  labels.forEach((label) => {
    // Hidden labels are only transparent, so their box is still measurable.
    const covers = caret !== null && labelCoversCaret(label.getBoundingClientRect(), caret);
    label.classList.toggle(REMOTE_CURSOR_LABEL_HIDDEN_CLASS, covers);
  });
}

// How long a remote cursor's name label shows when the cursor first appears;
// afterwards it shows only while hovered (labels sat on top of the text people
// were typing).
export const REMOTE_CURSOR_LABEL_INTRO_MS = 1000;
export const REMOTE_CURSOR_LABEL_INTRO_CLASS = "remote-collab-cursor-label-intro";

export function createRemotePresenceExtension(
  remotePresenceRef: MutableRefObject<RemotePresenceView[]>,
  receivedMappingsRef: MutableRefObject<ReceivedMappingEntry[]>
) {
  const refreshKey = new PluginKey("remotePresence");
  // Per remote client: the last presence we could map (see
  // pickRenderablePresence) and until when its name label is shown.
  const lastRenderable = new Map<string, RemotePresenceView>();
  const labelIntroUntil = new Map<string, number>();

  return Extension.create({
    name: "remotePresence",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: refreshKey,
          props: {
            decorations(state) {
              const decorations: Decoration[] = [];
              const maxPos = state.doc.content.size;
              const localVersion = getVersion(state);
              const unconfirmed = sendableSteps(state);
              const unconfirmedMaps = unconfirmed?.steps.map((step) => step.getMap()) ?? [];
              const buffer = receivedMappingsRef.current;
              const now = Date.now();

              const present = new Set(remotePresenceRef.current.map((presence) => presence.clientId));
              for (const clientId of Array.from(lastRenderable.keys())) {
                if (!present.has(clientId)) lastRenderable.delete(clientId);
              }
              for (const clientId of Array.from(labelIntroUntil.keys())) {
                if (!present.has(clientId)) labelIntroUntil.delete(clientId);
              }

              remotePresenceRef.current.forEach((incoming) => {
                const presence = pickRenderablePresence(
                  incoming,
                  lastRenderable.get(incoming.clientId),
                  localVersion
                );
                if (!presence) return;
                if (presence.selection === incoming.selection) {
                  lastRenderable.set(incoming.clientId, incoming);
                }
                const selection = presence.selection;
                if (!selection) {
                  return;
                }

                if (!labelIntroUntil.has(presence.clientId)) {
                  labelIntroUntil.set(presence.clientId, now + REMOTE_CURSOR_LABEL_INTRO_MS);
                }
                const showLabel = now < (labelIntroUntil.get(presence.clientId) ?? 0);

                const mapped = mapRemoteSelection(selection, localVersion, buffer, unconfirmedMaps, presence.clientId);
                const from = Math.max(0, Math.min(mapped.from, maxPos));
                const to = Math.max(from, Math.min(mapped.to, maxPos));
                const head = Math.max(0, Math.min(mapped.head, maxPos));

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
                      const label = document.createElement("span");
                      label.className = showLabel
                        ? `${REMOTE_CURSOR_LABEL_CLASS} ${REMOTE_CURSOR_LABEL_INTRO_CLASS}`
                        : REMOTE_CURSOR_LABEL_CLASS;
                      // Rendered by CSS (::after) so the name never becomes
                      // document text (copy, find, a11y, text assertions).
                      label.dataset.name = presence.userName;
                      cursor.appendChild(label);
                      return cursor;
                    },
                    {
                      // Stable across presence updates, so moving the cursor
                      // doesn't rebuild DOM next to the local caret.
                      key: `remote-cursor:${presence.clientId}:${presence.color}:${presence.userName}:${showLabel ? "intro" : "idle"}`,
                      side: -1
                    }
                  )
                );
              });

              return DecorationSet.create(state.doc, decorations);
            }
          },
          // A peer's name label floats above their caret and can sit right on
          // top of OUR caret (e.g. we're on the line above). Hide any label
          // that covers the local caret; it reappears once we move away.
          // Also re-render when a label's intro period ends.
          view: (editorView) => {
            let frame: number | null = null;
            let introTimer: ReturnType<typeof setTimeout> | null = null;
            const scheduleIntroEnd = (view: EditorView) => {
              const now = Date.now();
              const next = Math.min(
                ...Array.from(labelIntroUntil.values()).filter((until) => until > now)
              );
              if (!Number.isFinite(next) || introTimer !== null) return;
              introTimer = setTimeout(() => {
                introTimer = null;
                if (!view.isDestroyed) {
                  view.dispatch(view.state.tr.setMeta("remote-presence-refresh", Date.now()));
                }
              }, next - now + 20);
            };
            const schedule = (view: EditorView) => {
              if (frame !== null) cancelAnimationFrame(frame);
              frame = requestAnimationFrame(() => {
                frame = null;
                hideLabelsCoveringLocalCaret(view);
              });
              scheduleIntroEnd(view);
            };
            schedule(editorView);
            return {
              update: schedule,
              destroy: () => {
                if (frame !== null) cancelAnimationFrame(frame);
                if (introTimer !== null) clearTimeout(introTimer);
              }
            };
          }
        })
      ];
    }
  });
}
