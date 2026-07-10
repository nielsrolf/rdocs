export type HashNavEntry = {
  slug: string;
  tabId: string | null;
};

export type HashNavDeps = {
  // Current location hash, without the leading '#'.
  getHash: () => string;
  // Latest outline entries (looked up fresh on every attempt, so retries see
  // tab metadata that loaded after the first attempt).
  getEntries: () => HashNavEntry[];
  // Switch tab if needed and scroll to the heading. Returns true once the
  // scroll actually landed (heading visible); false to retry later.
  attemptScroll: (entry: HashNavEntry) => boolean;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};

// Layout settles after images/widgets load, and tab switches apply a frame
// later — retry on a decaying schedule instead of trusting the first attempt.
export const HASH_NAV_DELAYS = [0, 150, 400, 900, 2000, 4000];

const MAX_ATTEMPTS = 30;

export function createHeadingHashNav(deps: HashNavDeps) {
  const setT = deps.setTimeoutFn ?? setTimeout;
  const clearT = deps.clearTimeoutFn ?? clearTimeout;
  let doneHash: string | null = null;
  let attempts = 0;
  let timers: ReturnType<typeof setTimeout>[] = [];

  function clearTimers() {
    for (const timer of timers) clearT(timer);
    timers = [];
  }

  function attempt(hash: string) {
    if (doneHash === hash || attempts >= MAX_ATTEMPTS) return;
    if (deps.getHash() !== hash) return;
    const entry = deps.getEntries().find((candidate) => candidate.slug === hash);
    if (!entry) return;
    attempts += 1;
    if (deps.attemptScroll(entry)) {
      doneHash = hash;
      clearTimers();
    }
  }

  function kick() {
    const hash = deps.getHash();
    if (!hash || doneHash === hash || attempts >= MAX_ATTEMPTS) return;
    clearTimers();
    for (const delay of HASH_NAV_DELAYS) {
      timers.push(setT(() => attempt(hash), delay));
    }
  }

  return {
    // Call when outline entries refresh; re-arms pending navigation.
    onEntriesChanged() {
      kick();
    },
    // Call on window 'hashchange'; allows navigating to a new heading.
    onHashChange() {
      doneHash = null;
      attempts = 0;
      kick();
    },
    stop() {
      clearTimers();
    }
  };
}
