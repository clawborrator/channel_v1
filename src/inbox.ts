// In-memory inbox for routed prompts arriving from the hub. The
// `await_routed_prompt` MCP tool reads from here.
//
// Why a queue rather than callback-driven: Claude Code can only see
// "messages" the operator types (or that the MCP returns from a tool
// call). To inject a routed prompt, the only mechanism we have today
// is for Claude to CALL a tool that returns the pending prompt as
// its result — Claude then treats the result as the next thing to
// answer.
//
// The convention in CLAUDE.md / the tool description is: at the
// start of each turn, Claude calls `await_routed_prompt({maxWaitMs:0})`.
// If the result has a non-null prompt, Claude answers by calling
// `reply({chat_id, text})` and skips its normal user-facing reply.

interface InboxEntry {
  chatId: string;
  text:   string;
}

const queue: InboxEntry[] = [];
let waiters: ((entry: InboxEntry | null) => void)[] = [];

export function enqueueRoutedPrompt(entry: InboxEntry): void {
  // If a waiter is parked, hand off directly.
  const w = waiters.shift();
  if (w) { w(entry); return; }
  queue.push(entry);
}

export function tryDequeue(): InboxEntry | null {
  return queue.shift() ?? null;
}

export function awaitDequeue(maxWaitMs: number): Promise<InboxEntry | null> {
  const immediate = tryDequeue();
  if (immediate || maxWaitMs <= 0) {
    return Promise.resolve(immediate);
  }
  return new Promise((resolve) => {
    let resolved = false;
    let timer: NodeJS.Timeout | null = null;
    const settle = (entry: InboxEntry | null) => {
      if (resolved) return;
      resolved = true;
      const i = waiters.indexOf(settle);
      if (i >= 0) waiters.splice(i, 1);
      if (timer) clearTimeout(timer);
      resolve(entry);
    };
    waiters.push(settle);
    timer = setTimeout(() => settle(null), maxWaitMs);
  });
}

export function inboxSize(): number {
  return queue.length;
}
