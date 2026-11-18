# Design note: channel topic (G-14)

Status: approved by the Tech Lead with Amendment 1 (below); the security lead reviews the wire format. Author: dev-updater. The core PR follows this note; the UI (dev-ui) comes later.

## What it is
- A channel has an optional **topic**: one short line of text shown under the channel name.
- The owner or an admin sets it, changes it or clears it.
- Every member who can see the channel sees the same topic, decided by the control log like a channel's name.

## The record
A new control-log kind, following the G-26 reactions pattern (a kind, a size cap, an authority rule and a cap gate):

| | |
| --- | --- |
| Kind | `ChannelTopic = 22`, control scope only |
| Body | `channel [u8; 32]` ‖ `history u8` (reserved for D30, must be 0) ‖ topic, UTF-8 |
| Topic | 0 to **256 code points** (`MAX_CHANNEL_TOPIC`) and at most **1024 bytes** (`MAX_CHANNEL_TOPIC_BYTES`); empty clears it |
| `max_body` | 32 + 1 + 1024 = 1057 bytes |
| Text rule | `channel_topic_ok`: valid UTF-8, the strict `display_text_ok` rule (no bidi controls, other controls or zero-width characters), no leading or trailing whitespace. Not even a line break: it is one line. |

- **One encoding per topic:** a body that fails any rule doesn't parse (`Action::from_record` returns `None`). The record stays in the graph but is never accepted, as for every control kind today.
- **Plaintext inside the server:** like channel names, control records are readable by every member who holds the server's sync secret. A topic is no more private than a channel name, and the UI should say so.
- **Why not a field of `ChannelEdit`:** its body has no room. Its name runs to the end of the body, and older peers would refuse the whole edit, rename included.
- **Why not a tagged `Post`:** G-11's channel-order post needs no cap gate. But a post isn't privileged, so a revoked admin's concurrent post would still count. A kind in the authority gets the revoke and kick voiding (the "backdating" rule) for free.

## The authority rule
- **Who:** the author is the owner or an admin at the record (`author_role >= Role::Admin`), as for `ServerEdit`. This is wider than `ChannelEdit` (owner only); the board item asks for owners and admins.
- **Which channel:** the channel must be live (created, not deleted) at the record.
- **Privileged:** a revoke or kick voids the author's concurrent topics, like other privileged actions.
- **Which topic wins:** the latest accepted `ChannelTopic` in linear order, per channel. Deleting the channel drops its topic.
- `resolve` and the incremental `Resolver` both handle it; the existing equivalence tests cover the new kind.

## Older peers: the cap gate
- An older peer refuses an unknown kind on decode. A control record it can't decode would hold back every later record that depends on it, so the gate is strict.
- New cap **`channel-topic-v1`**, added to `CAPS`, so a new core posts it in its profile (`post_caps`), as with `reactions-v1`.
- `setChannelTopic` returns `update-needed` while any member's latest profile lacks the cap (`cap_gate`). `getUpdateNeeded(serverId, "channel-topic-v1")` lists who.
- **Residual, the same as `server-lifecycle-v1`:** someone joining later on an older version can't decode topics already in the log until they update. The join flow already tells them to update.

## API
- **Command:** `setChannelTopic(channelId, topic)` → the updated `Channel`.
  - `topic` is trimmed; an empty string clears it.
  - `bad-request` if it fails `channel_topic_ok` (256 code points, 1024 bytes, one line, strict text).
  - `not-found` for an unknown or deleted channel; `not-allowed` unless I am the owner or an admin; `update-needed` while the gate is shut.
  - Setting the same topic again signs nothing.
- **Channel JSON:** `Channel.topic?: string`, absent when there is none. An 18+ channel is listed only to members with an 18+ claim, and its topic with it. That withholding is display-only: the topic is plaintext in the control log, which every member can read, so the UI must not imply it is hidden.
- **Event:** the existing `channel.updated` with the channel JSON, for both my change and one that arrives by sync. No new event name.
- The mock (`ui/`) and the `commands.js` allow-list come with dev-ui's PR. This PR is core-only and fixes the contract above.

## Tests
- `records`: the kind, its scope and `max_body`.
- `authority`:
  - accepted from the owner and an admin, refused from a moderator or member;
  - refused for an unknown or deleted channel;
  - the latest in linear order wins, and an empty topic clears it;
  - a revoke voids a concurrent topic;
  - malformed bodies don't parse (history byte, bad UTF-8, controls, bidi, line break, 1025 bytes);
  - `resolve` equals the incremental `Resolver`.
- `api`: the command's errors, the gate, the JSON field, 18+ withholding, and `channel.updated` across two cores.

## Amendment 1 (Tech Lead review)
1. **Length:** at most 256 code points (counted like `MAX_CHANNEL_NAME`) and at most 1024 bytes. `max_body` stays 1057.
2. **18+:** hiding an 18+ channel's topic is display-only. The topic is plaintext in the control log, so the UI must not suggest it is private.
3. **Voiding:** a demotion (a revoke: the only way to demote) voids the author's concurrent topics, as a kick does. The authority tests cover both.
4. **Cap name:** `getUpdateNeeded(serverId, "channel-topic-v1")` works; an unknown name is still `bad-request`.
5. **No side effects:** a topic change is never unread, never a mention and never a notification. Only `channel.updated` fires.
6. **CONFORMANCE:** the same PR documents the kind, the gate residual and the plaintext. The mock waits for dev-ui.
