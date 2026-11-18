//! G-81 voice media, the api side (#509 §2.3, part c): the `voiceFrame`
//! fast path the sidecar's reader thread uses, and the gate it checks.
//!
//! - `{"cmd":"voiceFrame","args":{"callId","seq","ts","data"}}`, no `id`,
//!   no reply (with an `id` it still gets none: a caller's bug). `callId`
//!   is 32 lowercase hex, `seq` and `ts` are u32, `data` is standard base64
//!   of at most [`sync::MAX_VOICE_OPUS`] bytes (0: a DTX gap).
//! - Checked in the reader, never by `handle_value`: the encoded length
//!   before decoding (SL 2), then the header fields strictly. Anything
//!   else is dropped silently, counted, never logged.
//! - The gate (dev-identity 2, SL 3): frames pass only while a call is
//!   active under that call ID, the keys aren't locked, and I'm not signed
//!   out. It's cleared synchronously on leave, lock, a relay-only switch
//!   and sign-out, before any queued frame is handed on. Stale frames (a
//!   frame overtaking `leaveCall`) are a no-op, never an error.
//! - Routes are the node's: this never chooses one (SL 4).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use serde_json::Value;

use crate::voice::VoiceNet;

/// Base64 of [`sync::MAX_VOICE_OPUS`] bytes, padded: the longest `data`.
const MAX_DATA_B64: usize = sync::MAX_VOICE_OPUS.div_ceil(3) * 4;

/// The fast path's shared state: the call frames may go to now, and the
/// network they go to.
#[derive(Default)]
pub(crate) struct MediaGate {
    call: Mutex<Option<[u8; 16]>>,
    net: Mutex<Option<Arc<dyn VoiceNet>>>,
    dropped: AtomicU64,
}

impl MediaGate {
    pub fn set_net(&self, net: Arc<dyn VoiceNet>) {
        *self.net.lock().expect("not poisoned") = Some(net);
    }

    /// The call frames may go to now; `None` closes the gate at once.
    pub fn set_call(&self, call: Option<[u8; 16]>) {
        *self.call.lock().expect("not poisoned") = call;
    }

    /// Frames dropped by the fast path (malformed, or the gate closed).
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

/// The sidecar reader's handle (`Core::voice_frames`): cheap to clone,
/// `'static`, never takes the core's lock.
#[derive(Clone)]
pub struct VoiceFrames(pub(crate) Arc<MediaGate>);

impl VoiceFrames {
    /// One `voiceFrame`'s `args`: handed to the network, or dropped.
    pub fn take(&self, args: Option<&Value>) {
        let gate = &self.0;
        let frame = args.and_then(parse);
        let open = *gate.call.lock().expect("not poisoned");
        match frame {
            Some(frame) if open == Some(frame.call_id) => {
                let net = gate.net.lock().expect("not poisoned").clone();
                match net {
                    Some(net) => net.media_frame(frame),
                    None => {
                        gate.dropped.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
            _ => {
                gate.dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

/// `args` as a frame, strictly: exactly the four fields, the call ID 32
/// lowercase hex, `seq` and `ts` within u32, `data` standard base64 of at
/// most [`sync::MAX_VOICE_OPUS`] bytes, its length checked first.
fn parse(args: &Value) -> Option<sync::VoiceFrame> {
    let args = args.as_object()?;
    if args.len() != 4 {
        return None;
    }
    let call = args.get("callId")?.as_str()?;
    if call.len() != 32 || !call.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return None;
    }
    let call_id: [u8; 16] = hex::decode(call).ok()?.try_into().ok()?;
    let seq = u32::try_from(args.get("seq")?.as_u64()?).ok()?;
    let ts = u32::try_from(args.get("ts")?.as_u64()?).ok()?;
    let data = args.get("data")?.as_str()?;
    if data.len() > MAX_DATA_B64 {
        return None;
    }
    let opus = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
    if opus.len() > sync::MAX_VOICE_OPUS {
        return None;
    }
    Some(sync::VoiceFrame { call_id, seq, ts, opus })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[derive(Default)]
    struct Net(Mutex<Vec<sync::VoiceFrame>>);

    impl VoiceNet for Net {
        fn send(&self, _: records::PublicKey, _: Vec<u8>) {}
        fn media_frame(&self, frame: sync::VoiceFrame) {
            self.0.lock().unwrap().push(frame);
        }
    }

    fn args(call: &str, data: &str) -> Value {
        json!({ "callId": call, "seq": 7, "ts": 960, "data": data })
    }

    #[test]
    fn only_well_formed_frames_of_the_open_call_go_through() {
        let net = Arc::new(Net::default());
        let gate = Arc::new(MediaGate::default());
        gate.set_net(net.clone());
        let frames = VoiceFrames(gate.clone());
        let call = "0a".repeat(16);
        let opus = base64::engine::general_purpose::STANDARD.encode([1u8; 400]);

        // No call yet: dropped.
        frames.take(Some(&args(&call, &opus)));
        assert!(net.0.lock().unwrap().is_empty());
        gate.set_call(Some([0x0a; 16]));
        frames.take(Some(&args(&call, &opus)));
        frames.take(Some(&args(&call, ""))); // a DTX gap
        assert_eq!(net.0.lock().unwrap().len(), 2);
        assert_eq!(net.0.lock().unwrap()[0].opus.len(), 400);

        let too_big = base64::engine::general_purpose::STANDARD.encode([1u8; 401]);
        let bad = [
            args(&"0b".repeat(16), &opus),         // another call
            args(&"0A".repeat(16), &opus),         // not lowercase
            args(&"0a".repeat(15), &opus),         // short
            args(&call, &too_big),                 // over 400 B
            args(&call, "not base64!"),            // not base64
            json!({ "callId": call, "seq": 4_294_967_296u64, "ts": 0, "data": "" }), // seq over u32
            json!({ "callId": call, "seq": 1, "ts": 0, "data": "", "extra": 1 }),     // extra field
            json!([1, 2]),
        ];
        for args in &bad {
            frames.take(Some(args));
        }
        frames.take(None);
        assert_eq!(net.0.lock().unwrap().len(), 2);
        assert_eq!(gate.dropped(), 1 + bad.len() as u64 + 1);

        // Closed (leave, lock, sign-out): dropped at once.
        gate.set_call(None);
        frames.take(Some(&args(&call, &opus)));
        assert_eq!(net.0.lock().unwrap().len(), 2);
    }
}
