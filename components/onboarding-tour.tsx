"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Editor } from "@tiptap/react";

// Guided first-run tour. Tooltips anchor to [data-tour=…] elements and walk the
// user through building a real "How to use r-docs" document: headings, linking
// the r-docs repo, an AI selection edit, a comment + Ask AI, and an agent run
// that adds a plot / formulas / an interactive widget. Progress lives in
// localStorage so the tour survives the dashboard → document navigation.

const STORAGE_KEY = "rdocs-tour-v1";
const TOUR_EVENT = "rdocs-tour-event";

export type TourEventName =
  | "repo-linked"
  | "ai-edit-started"
  | "comment-created"
  | "ask-ai"
  | "agent-run-started";

/** Fire from app handlers so the matching tour step advances automatically. */
export function emitTourEvent(name: TourEventName) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(TOUR_EVENT, { detail: name }));
}

type TourState = {
  active: boolean;
  step: number;
  completedAt?: string;
  dismissedAt?: string;
};

function readState(): TourState {
  if (typeof window === "undefined") return { active: false, step: 0 };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { active: false, step: 0 };
    const parsed = JSON.parse(raw) as Partial<TourState>;
    return { active: parsed.active ?? false, step: parsed.step ?? 0, ...parsed };
  } catch {
    return { active: false, step: 0 };
  }
}

function writeState(state: TourState) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private-mode storage failures just make the tour non-persistent.
  }
}

export const REPO_TOUR_URL = "https://github.com/nielsrolf/rdocs";

type TourStep = {
  surface: "list" | "doc";
  target: string;
  title: string;
  body: ReactNode;
  /** Event that advances this step automatically (Next stays available). */
  advanceOn?: TourEventName;
  /** Render the "Insert starter content" convenience button. */
  offerStarter?: boolean;
};

const STEPS: TourStep[] = [
  {
    surface: "list",
    target: '[data-tour="new-doc"]',
    title: "Create a document",
    body: "Let's build a \"How to use r-docs\" guide together. Click New document to start."
  },
  {
    surface: "doc",
    target: '[data-tour="doc-title"]',
    title: "Name it",
    body: 'Click the title and call this document "How to use r-docs".'
  },
  {
    surface: "doc",
    target: '[data-tour="editor"]',
    title: "Write with headings",
    body: (
      <>
        Markdown shortcuts work as you type: <code># </code> makes a heading,{" "}
        <code>- </code> a bullet list, <code>$…$</code> a formula. Try typing{" "}
        <code># How to use r-docs</code> — or press the button below to insert a starter guide
        (the next steps build on its bullet points).
      </>
    ),
    offerStarter: true
  },
  {
    surface: "doc",
    target: '[data-tour="repo-menu"]',
    title: "Connect a repository",
    body: (
      <>
        Documents can drive a real repo. Open <strong>Repo</strong>, paste{" "}
        <code>{REPO_TOUR_URL}</code> (the r-docs source itself) and press Save. Agents get an
        isolated checkout and can answer questions from the code.
      </>
    ),
    advanceOn: "repo-linked"
  },
  {
    surface: "doc",
    target: '[data-tour="editor"]',
    title: "Ask AI to edit a selection",
    body: (
      <>
        Select the feature bullet points in the document, click <strong>Edit with AI</strong> in
        the popover, type <code>explain this</code> and press Apply edit. Claude rewrites just the
        selection — watch the shimmer while it works.
      </>
    ),
    advanceOn: "ai-edit-started"
  },
  {
    surface: "doc",
    target: '[data-tour="editor"]',
    title: "Comment on something",
    body: (
      <>
        Select the line about AI credentials, click <strong>Add comment</strong> and ask:{" "}
        <code>How do AI credentials and the GitHub PAT work?</code>
      </>
    ),
    advanceOn: "comment-created"
  },
  {
    surface: "doc",
    target: '[data-tour="comment-rail"]',
    title: "Ask AI in the thread",
    body: (
      <>
        Press <strong>Ask AI</strong> on your new comment. Claude reads the document and the
        linked repository and replies in the thread.
      </>
    ),
    advanceOn: "ask-ai"
  },
  {
    surface: "doc",
    target: '[data-tour="agents-button"]',
    title: "Run an agent on the whole doc",
    body: (
      <>
        Add a heading <code>## More demo cases</code> at the bottom, then open{" "}
        <strong>Agents</strong> and send:{" "}
        <code>
          Under &quot;More demo cases&quot;, add a plot of a damped oscillator, a few LaTeX
          formulas, and an interactive widget.
        </code>
      </>
    ),
    advanceOn: "agent-run-started"
  },
  {
    surface: "doc",
    target: '[data-tour="agents-button"]',
    title: "That's the tour!",
    body: (
      <>
        The agent commits its work to the linked repo as it goes — watch progress in the Agents
        panel. Explore the rest at your own pace: share links, suggestion mode, exports, and the
        MCP bridge under AI credentials.
      </>
    )
  }
];

// TipTap JSON for the starter guide. Kept in sync with the steps above: the
// bullets are what the AI-edit step selects, and the credentials line is what
// the comment step anchors to.
function starterContent() {
  const bullet = (text: string) => ({
    type: "listItem",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }]
  });
  return [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "How to use r-docs" }] },
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "r-docs is a research document that drives a repository: write, comment, and let Claude do the heavy lifting."
        }
      ]
    },
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Writing" }] },
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Markdown shortcuts work as you type: # for headings, - for bullet lists, $x^2$ for formulas."
        }
      ]
    },
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Features" }] },
    {
      type: "bulletList",
      content: [
        bullet("AI edits: select any text and click Edit with AI."),
        bullet("Comments: select text, Add comment, then Ask AI to get an answer in the thread."),
        bullet(
          "AI credentials and GitHub PAT: connect your own Anthropic, OpenRouter or LiteLLM key and a GitHub personal access token under AI credentials in the topbar."
        ),
        bullet("Linked repos: connect a GitHub repository so agents work in a real checkout."),
        bullet("Agents: run Claude on the whole document from the Agents panel.")
      ]
    }
  ];
}

export function OnboardingTour({
  surface,
  editor = null,
  autoOffer = false
}: {
  surface: "list" | "doc";
  editor?: Editor | null;
  autoOffer?: boolean;
}) {
  const [state, setState] = useState<TourState>(() => readState());
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [starterInserted, setStarterInserted] = useState(false);

  const update = useCallback((next: TourState) => {
    writeState(next);
    setState(next);
  }, []);

  // Crossing from the dashboard into the new document advances step 0.
  useEffect(() => {
    if (surface === "doc" && state.active && state.step === 0) {
      update({ ...state, step: 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface, state.active, state.step]);

  const step = state.active ? STEPS[state.step] : undefined;
  const visible = Boolean(step && step.surface === surface);

  const advance = useCallback(() => {
    if (!state.active) return;
    if (state.step >= STEPS.length - 1) {
      update({ active: false, step: 0, completedAt: new Date().toISOString() });
    } else {
      update({ ...state, step: state.step + 1 });
    }
  }, [state, update]);

  // Auto-advance on app events matching the current step.
  useEffect(() => {
    if (!visible || !step?.advanceOn) return;
    const handler = (event: Event) => {
      if ((event as CustomEvent).detail === step.advanceOn) advance();
    };
    window.addEventListener(TOUR_EVENT, handler);
    return () => window.removeEventListener(TOUR_EVENT, handler);
  }, [visible, step, advance]);

  // Track the anchor element's position (and highlight it).
  useEffect(() => {
    if (!visible || !step) {
      setTargetRect(null);
      return;
    }
    const el = document.querySelector<HTMLElement>(step.target);
    if (!el) {
      setTargetRect(null);
      return;
    }
    el.classList.add("tour-target-highlight");
    const measure = () => setTargetRect(el.getBoundingClientRect());
    measure();
    const interval = window.setInterval(measure, 400);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      el.classList.remove("tour-target-highlight");
      window.clearInterval(interval);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [visible, step]);

  const tooltipStyle = useMemo(() => {
    if (!targetRect) {
      return { bottom: "1.25rem", right: "1.25rem" } as const;
    }
    const margin = 12;
    const width = 340;
    const below = targetRect.bottom + margin;
    const left = Math.max(
      12,
      Math.min(targetRect.left, (typeof window !== "undefined" ? window.innerWidth : 1200) - width - 12)
    );
    // Place below the anchor unless that would run off-screen — then above.
    if (typeof window !== "undefined" && below + 220 > window.innerHeight) {
      return { bottom: `${window.innerHeight - targetRect.top + margin}px`, left: `${left}px` } as const;
    }
    return { top: `${below}px`, left: `${left}px` } as const;
  }, [targetRect]);

  function handleInsertStarter() {
    if (!editor) return;
    editor.chain().focus("end").insertContent(starterContent()).run();
    setStarterInserted(true);
  }

  function dismiss() {
    update({ active: false, step: 0, dismissedAt: new Date().toISOString() });
  }

  // Offer card on the dashboard for users who haven't taken or dismissed it.
  if (!state.active) {
    const alreadyClosed = Boolean(state.completedAt || state.dismissedAt);
    if (surface === "list" && autoOffer && !alreadyClosed) {
      return (
        <div className="tour-tooltip tour-offer" role="dialog" aria-label="Take the tour">
          <strong>New here?</strong>
          <p>Take a two-minute tour: build a &quot;How to use r-docs&quot; document with AI edits, comments and an agent run.</p>
          <div className="tour-actions">
            <button className="ghost-button" onClick={dismiss} type="button">
              No thanks
            </button>
            <button
              className="primary-button"
              onClick={() => update({ active: true, step: 0 })}
              type="button"
            >
              Start the tour
            </button>
          </div>
        </div>
      );
    }
    return null;
  }

  if (!visible || !step) return null;

  return (
    <div className="tour-tooltip" role="dialog" aria-label={step.title} style={tooltipStyle}>
      <div className="tour-progress">
        Step {state.step + 1} of {STEPS.length}
      </div>
      <strong>{step.title}</strong>
      <p>{step.body}</p>
      {step.offerStarter && editor ? (
        <button
          className="ghost-button"
          disabled={starterInserted}
          onClick={handleInsertStarter}
          type="button"
        >
          {starterInserted ? "Starter content inserted ✓" : "Insert starter content"}
        </button>
      ) : null}
      <div className="tour-actions">
        <button className="ghost-button" onClick={dismiss} type="button">
          Skip tour
        </button>
        {state.step > 0 && STEPS[state.step - 1].surface === surface ? (
          <button
            className="ghost-button"
            onClick={() => update({ ...state, step: state.step - 1 })}
            type="button"
          >
            Back
          </button>
        ) : null}
        <button className="primary-button" onClick={advance} type="button">
          {state.step >= STEPS.length - 1 ? "Finish" : step.advanceOn ? "Skip step" : "Next"}
        </button>
      </div>
    </div>
  );
}

/** Small "Take the tour" restart affordance for the dashboard header. */
export function TourRestartButton() {
  return (
    <button
      className="ghost-button"
      onClick={() => {
        writeState({ active: true, step: 0 });
        window.dispatchEvent(new Event("storage"));
        window.location.reload();
      }}
      type="button"
    >
      Take the tour
    </button>
  );
}
