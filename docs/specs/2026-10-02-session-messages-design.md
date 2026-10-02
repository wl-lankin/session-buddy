# Message to a session

A line "Message this session" in the session view of every live session. The text reaches the session through the hooks that already run, in any terminal (also Warp), without typing into it. Sessions that Session Buddy started itself (see session-control-design.md) take the message directly and need none of this.

## What the CLI offers (checked on 2.1.287)

- `PreToolUse` and `PostToolUse` hooks may answer `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"..."}}` (same with `PostToolUse`): the text is added to the model's context mid-turn.
- The `Stop` hook may answer `{"decision":"block","reason":"..."}`: the turn does not end, the model continues with the reason. The island's reply card already relies on this.
- A session idle at its input prompt fires no hook and cannot be woken from here. The interactive sessions' internal peer sockets (`~/.claude/sessions/<pid>.json`, `messagingSocketPath`) are undocumented and need their key file: not used.

## Delivery

1. The island sends `session_message_send(session_id, text)`. It is the user's own text: no confirmation. The app queues it per session in memory (at most 5 per session, 4000 characters, control characters except newlines removed). It is never written to disk.
2. The relay already forwards every hook event to the app. For `PreToolUse`, `PostToolUse` and `Stop` it now also waits for the app's immediate answer: the app always replies at once (a few milliseconds), either "nothing" or the queued text. The relay prints the matching JSON for that event. If the app is not running, or no answer comes within the existing 100 ms budget, the relay prints nothing and Claude Code is never delayed. Events that already wait for the user (permission requests, questions, plans) keep their behaviour.
3. The first of these events after the message was queued delivers it:
   - `PreToolUse` / `PostToolUse`: `additionalContext` with the wrapped text (below); delivered mid-turn, the session reads it before its next step.
   - `Stop`: `{"decision":"block","reason":"<wrapped text>"}`, so a session that is about to stop continues with it. Only when a message is queued, and the queue is cleared by that delivery, so there is no loop.
4. Wrapping, so the model knows where it comes from and treats it as the user's instruction:
   `Message from the user, sent through Session Buddy while you were working: <text>`
   For the Stop case: `The user sent this message through Session Buddy: <text>`.
5. States per message, shown under the composer: `queued` (with a Cancel link), `delivered` (time and whether mid-turn or at the end), `expired` (the session ended before it could be delivered; the text stays visible so it can be copied). A message to a session that is idle or finished shows "Will be delivered as soon as the session works again" instead of a promise it cannot keep.

The same queue serves the chat: its `send_prompt` tool, for a session that is not managed, queues the text this way (the island still asks for confirmation first).

## Island

- Composer in the session view, for every live session: placeholder "Message this session", Enter sends, Shift+Enter a new line, the helper line under it tells the delivery mode: working -> "Delivered at the session's next step", idle or finished -> "Delivered when it starts working again", managed -> "Sent directly".
- Managed sessions use the composer that already exists for them (direct prompt); the two are one control that picks the path by session kind.
- A small badge on the session in the tab row while a message is queued.
- Sound `send` on queue, `finish`-style tick when delivered; Buddy blinks once on delivery.

## Rust

- Store/hub: per-session queue, delivery bookkeeping, snapshot field `messages: { id, text, state, queuedAt, deliveredAt, via }[]` per session (last few only).
- Relay: wait-for-reply on the three events, JSON output builders per event, unit tests for each shape and for the "app absent" path (prints nothing, exits 0 within the budget).
- IPC: reply to those events always, immediately; the payload is optional.
- Command `session_message_send`, `session_message_cancel(id)`.

## Not now

Waking an idle session (peer socket or terminal automation), messages to sessions on other machines, attachments.
