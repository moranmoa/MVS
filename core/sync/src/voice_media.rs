//! G-81 voice media (`/mvs/voice-media/1`): Opus frames between the members
//! of one call, over a long-lived substream per call peer (#509 §2.3, C2).
//!
//! Our own behaviour and handler, not libp2p-stream: that crate opens on a
//! random connection to the peer and dials by itself, so neither "move to
//! the direct connection" (A5), "a fresh circuit before the cut" (A3), nor
//! "relay-only: our circuits only" could be enforced (TL on #509).
//!
//! - **Outbound:** [`VoiceMedia::open`] opens on exactly the
//!   [`ConnectionId`] the node's path logic chose (`NotifyHandler::One`).
//!   The behaviour never dials; a closed connection fails the open.
//! - **Inbound:** every negotiated substream goes to the node unread
//!   ([`Event::Inbound`]), which gates it (a bound identity, a current
//!   member, a participant of my current call) before reading a byte, and
//!   drops it otherwise. A handler holds at most [`MAX_HELD_INBOUND`]
//!   undecided ones; more are dropped.
//! - **Framing:** `call_id[16] ‖ seq u32 ‖ ts u32 ‖ len u16 ‖ opus[len]`,
//!   big-endian, `len ≤` [`MAX_OPUS`] (0: a DTX gap). Read with a fixed
//!   buffer; anything bigger or short closes the substream.
//! - **Keep-alive:** none of its own. An open substream keeps its connection
//!   alive (libp2p counts active streams); the node drops a substream idle
//!   for [`IDLE`], and its old one after a migration, so a parked relayed
//!   connection (#206) isn't held open by voice.
//! - **Sending:** each substream has a [`SendQueue`] of at most
//!   [`QUEUE_FRAMES`] frames; when full, the oldest frame is dropped (late
//!   audio is useless), counted, never logged.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use futures::{AsyncReadExt, AsyncWriteExt};
use libp2p::core::upgrade::ReadyUpgrade;
use libp2p::core::{transport::PortUse, Endpoint};
use libp2p::swarm::handler::{ConnectionEvent, DialUpgradeError, FullyNegotiatedInbound, FullyNegotiatedOutbound};
use libp2p::swarm::{
    ConnectionDenied, ConnectionHandler, ConnectionHandlerEvent, ConnectionId, FromSwarm, NetworkBehaviour,
    NotifyHandler, Stream, SubstreamProtocol, THandler, THandlerInEvent, THandlerOutEvent, ToSwarm,
};
use libp2p::{Multiaddr, PeerId, StreamProtocol};

pub(crate) const VOICE_MEDIA_PROTOCOL: StreamProtocol = StreamProtocol::new("/mvs/voice-media/1");
/// Largest Opus payload per frame, in bytes (#509 §2.3).
pub const MAX_OPUS: usize = 400;
/// The frame header: call ID, sequence, timestamp, payload length.
pub const HEADER: usize = 16 + 4 + 4 + 2;
/// Frames waiting to be written on one substream; past it, the oldest goes.
pub(crate) const QUEUE_FRAMES: usize = 16;
/// Inbound substreams a connection holds while the node decides.
pub(crate) const MAX_HELD_INBOUND: usize = 2;
/// A substream with no frame for this long is dropped (an abandoned call).
pub(crate) const IDLE: Duration = Duration::from_secs(30);

/// One voice frame.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VoiceFrame {
    pub call_id: [u8; 16],
    pub seq: u32,
    /// Sample count at 48 kHz (#509 §2.3), compared modulo 2³².
    pub ts: u32,
    /// Opus, at most [`MAX_OPUS`] bytes; empty for a DTX gap.
    pub opus: Vec<u8>,
}

impl VoiceFrame {
    /// The wire form, or `None` over [`MAX_OPUS`].
    pub fn encode(&self) -> Option<Vec<u8>> {
        if self.opus.len() > MAX_OPUS {
            return None;
        }
        let mut out = Vec::with_capacity(HEADER + self.opus.len());
        out.extend_from_slice(&self.call_id);
        out.extend_from_slice(&self.seq.to_be_bytes());
        out.extend_from_slice(&self.ts.to_be_bytes());
        out.extend_from_slice(&(self.opus.len() as u16).to_be_bytes());
        out.extend_from_slice(&self.opus);
        Some(out)
    }
}

/// Reads one frame: `Ok(None)` at a clean end between frames; an error for
/// a short read or a length over [`MAX_OPUS`] (the caller closes).
pub(crate) async fn read_frame<R: futures::AsyncRead + Unpin>(io: &mut R) -> io::Result<Option<VoiceFrame>> {
    let mut header = [0u8; HEADER];
    let mut got = 0;
    while got < HEADER {
        let n = io.read(&mut header[got..]).await?;
        if n == 0 {
            return if got == 0 { Ok(None) } else { Err(io::ErrorKind::UnexpectedEof.into()) };
        }
        got += n;
    }
    let len = u16::from_be_bytes([header[24], header[25]]) as usize;
    if len > MAX_OPUS {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "voice frame too large"));
    }
    let mut opus = [0u8; MAX_OPUS];
    io.read_exact(&mut opus[..len]).await?;
    Ok(Some(VoiceFrame {
        call_id: header[..16].try_into().expect("16 bytes"),
        seq: u32::from_be_bytes(header[16..20].try_into().expect("4 bytes")),
        ts: u32::from_be_bytes(header[20..24].try_into().expect("4 bytes")),
        opus: opus[..len].to_vec(),
    }))
}

/// A substream's frames to write: bounded, the oldest dropped when full.
#[derive(Clone, Default)]
pub(crate) struct SendQueue {
    inner: Arc<(Mutex<QueueState>, tokio::sync::Notify)>,
}

#[derive(Default)]
struct QueueState {
    frames: VecDeque<Vec<u8>>,
    closed: bool,
}

/// Frames dropped from full send queues, all substreams together.
pub(crate) static DROPPED: AtomicU64 = AtomicU64::new(0);

impl SendQueue {
    pub fn push(&self, frame: Vec<u8>) {
        let mut state = self.inner.0.lock().expect("not poisoned");
        if state.closed {
            return;
        }
        if state.frames.len() >= QUEUE_FRAMES {
            state.frames.pop_front();
            DROPPED.fetch_add(1, Ordering::Relaxed);
        }
        state.frames.push_back(frame);
        drop(state);
        self.inner.1.notify_one();
    }

    /// Ends the writer once what's queued is written (or at once, if its
    /// substream already failed).
    pub fn close(&self) {
        self.inner.0.lock().expect("not poisoned").closed = true;
        self.inner.1.notify_one();
    }

    async fn next(&self) -> Option<Vec<u8>> {
        loop {
            {
                let mut state = self.inner.0.lock().expect("not poisoned");
                if let Some(frame) = state.frames.pop_front() {
                    return Some(frame);
                }
                if state.closed {
                    return None;
                }
            }
            self.inner.1.notified().await;
        }
    }
}

/// Writes `queue` to `stream` until the queue closes or a write fails;
/// then the substream is closed (dropped).
pub(crate) async fn write_loop(mut stream: Stream, queue: SendQueue) {
    while let Some(frame) = queue.next().await {
        if stream.write_all(&frame).await.is_err() || stream.flush().await.is_err() {
            queue.close();
            return;
        }
    }
    let _ = stream.close().await;
}

/// What the behaviour reports to the node.
#[derive(Debug)]
pub(crate) enum Event {
    /// A negotiated inbound substream, unread: gate it or drop it.
    Inbound { peer: PeerId, connection: ConnectionId, stream: Stream },
    /// [`VoiceMedia::open`] `id` succeeded on `connection`.
    Opened { peer: PeerId, connection: ConnectionId, id: u64, stream: Stream },
    /// It didn't (protocol refused, or the connection closed).
    OpenFailed { peer: PeerId, connection: ConnectionId, id: u64 },
}

#[derive(Default)]
pub(crate) struct VoiceMedia {
    connections: HashMap<ConnectionId, PeerId>,
    queued: VecDeque<ToSwarm<Event, HandlerIn>>,
    next_id: u64,
}

impl VoiceMedia {
    /// Opens a voice substream on exactly `connection` to `peer`. `None`
    /// when that connection isn't open: the node picks another path; this
    /// never dials.
    pub fn open(&mut self, peer: PeerId, connection: ConnectionId) -> Option<u64> {
        if self.connections.get(&connection) != Some(&peer) {
            return None;
        }
        self.next_id += 1;
        let id = self.next_id;
        self.queued.push_back(ToSwarm::NotifyHandler {
            peer_id: peer,
            handler: NotifyHandler::One(connection),
            event: HandlerIn::Open(id),
        });
        Some(id)
    }
}

impl NetworkBehaviour for VoiceMedia {
    type ConnectionHandler = Handler;
    type ToSwarm = Event;

    fn handle_established_inbound_connection(
        &mut self,
        _: ConnectionId,
        _: PeerId,
        _: &Multiaddr,
        _: &Multiaddr,
    ) -> Result<THandler<Self>, ConnectionDenied> {
        Ok(Handler::default())
    }

    fn handle_established_outbound_connection(
        &mut self,
        _: ConnectionId,
        _: PeerId,
        _: &Multiaddr,
        _: Endpoint,
        _: PortUse,
    ) -> Result<THandler<Self>, ConnectionDenied> {
        Ok(Handler::default())
    }

    fn on_swarm_event(&mut self, event: FromSwarm) {
        match event {
            FromSwarm::ConnectionEstablished(e) => {
                self.connections.insert(e.connection_id, e.peer_id);
            }
            FromSwarm::ConnectionClosed(e) => {
                self.connections.remove(&e.connection_id);
            }
            _ => {}
        }
    }

    fn on_connection_handler_event(&mut self, peer: PeerId, connection: ConnectionId, event: THandlerOutEvent<Self>) {
        let event = match event {
            HandlerOut::Inbound(stream) => Event::Inbound { peer, connection, stream },
            HandlerOut::Opened(id, stream) => Event::Opened { peer, connection, id, stream },
            HandlerOut::OpenFailed(id) => Event::OpenFailed { peer, connection, id },
        };
        self.queued.push_back(ToSwarm::GenerateEvent(event));
    }

    fn poll(&mut self, _: &mut Context<'_>) -> Poll<ToSwarm<Self::ToSwarm, THandlerInEvent<Self>>> {
        match self.queued.pop_front() {
            Some(event) => Poll::Ready(event),
            None => Poll::Pending,
        }
    }
}

#[derive(Debug)]
pub(crate) enum HandlerIn {
    Open(u64),
}

#[derive(Debug)]
pub(crate) enum HandlerOut {
    Inbound(Stream),
    Opened(u64, Stream),
    OpenFailed(u64),
}

/// One connection's voice substreams: opens what the behaviour asks for,
/// hands every negotiated one up unread.
#[derive(Default)]
pub(crate) struct Handler {
    opening: VecDeque<u64>,
    out: VecDeque<HandlerOut>,
}

impl ConnectionHandler for Handler {
    type FromBehaviour = HandlerIn;
    type ToBehaviour = HandlerOut;
    type InboundProtocol = ReadyUpgrade<StreamProtocol>;
    type OutboundProtocol = ReadyUpgrade<StreamProtocol>;
    type InboundOpenInfo = ();
    type OutboundOpenInfo = u64;

    fn listen_protocol(&self) -> SubstreamProtocol<Self::InboundProtocol, ()> {
        SubstreamProtocol::new(ReadyUpgrade::new(VOICE_MEDIA_PROTOCOL), ())
    }

    fn on_behaviour_event(&mut self, event: HandlerIn) {
        match event {
            HandlerIn::Open(id) => self.opening.push_back(id),
        }
    }

    /// Never on its own: an open voice substream keeps the connection.
    fn connection_keep_alive(&self) -> bool {
        false
    }

    fn poll(
        &mut self,
        _: &mut Context<'_>,
    ) -> Poll<ConnectionHandlerEvent<Self::OutboundProtocol, u64, Self::ToBehaviour>> {
        if let Some(out) = self.out.pop_front() {
            return Poll::Ready(ConnectionHandlerEvent::NotifyBehaviour(out));
        }
        if let Some(id) = self.opening.pop_front() {
            return Poll::Ready(ConnectionHandlerEvent::OutboundSubstreamRequest {
                protocol: SubstreamProtocol::new(ReadyUpgrade::new(VOICE_MEDIA_PROTOCOL), id),
            });
        }
        Poll::Pending
    }

    fn on_connection_event(
        &mut self,
        event: ConnectionEvent<Self::InboundProtocol, Self::OutboundProtocol, (), u64>,
    ) {
        match event {
            ConnectionEvent::FullyNegotiatedInbound(FullyNegotiatedInbound { protocol: stream, .. }) => {
                // Undecided ones are bounded: a peer opening many is cut.
                let held = self.out.iter().filter(|o| matches!(o, HandlerOut::Inbound(_))).count();
                if held < MAX_HELD_INBOUND {
                    self.out.push_back(HandlerOut::Inbound(stream));
                }
            }
            ConnectionEvent::FullyNegotiatedOutbound(FullyNegotiatedOutbound { protocol: stream, info: id }) => {
                self.out.push_back(HandlerOut::Opened(id, stream));
            }
            ConnectionEvent::DialUpgradeError(DialUpgradeError { info: id, .. }) => {
                self.out.push_back(HandlerOut::OpenFailed(id));
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(len: usize) -> VoiceFrame {
        VoiceFrame { call_id: [7; 16], seq: 0x0102_0304, ts: 48_000, opus: vec![9; len] }
    }

    #[test]
    fn frames_round_trip_and_oversize_is_refused() {
        for len in [0, 1, 160, MAX_OPUS] {
            let wire = frame(len).encode().unwrap();
            assert_eq!(wire.len(), HEADER + len);
            let mut io = futures::io::Cursor::new(wire);
            let got = futures::executor::block_on(read_frame(&mut io)).unwrap();
            assert_eq!(got, Some(frame(len)));
            assert_eq!(futures::executor::block_on(read_frame(&mut io)).unwrap(), None);
        }
        assert!(frame(MAX_OPUS + 1).encode().is_none());
        // A header claiming more than MAX_OPUS closes, unread.
        let mut wire = frame(0).encode().unwrap();
        wire[24..26].copy_from_slice(&((MAX_OPUS + 1) as u16).to_be_bytes());
        let mut io = futures::io::Cursor::new(wire);
        assert!(futures::executor::block_on(read_frame(&mut io)).is_err());
        // A short frame too.
        let wire = frame(10).encode().unwrap();
        let mut io = futures::io::Cursor::new(wire[..HEADER + 5].to_vec());
        assert!(futures::executor::block_on(read_frame(&mut io)).is_err());
    }

    #[test]
    fn a_full_send_queue_drops_the_oldest() {
        let queue = SendQueue::default();
        for n in 0..(QUEUE_FRAMES + 3) {
            queue.push(vec![n as u8]);
        }
        let first = futures::executor::block_on(queue.next()).unwrap();
        assert_eq!(first, vec![3]);
        queue.close();
        let rest = std::iter::from_fn(|| futures::executor::block_on(queue.next())).count();
        assert_eq!(rest, QUEUE_FRAMES - 1);
    }

    #[test]
    fn open_only_on_a_known_connection() {
        let mut media = VoiceMedia::default();
        let peer = PeerId::random();
        assert_eq!(media.open(peer, ConnectionId::new_unchecked(1)), None);
        media.connections.insert(ConnectionId::new_unchecked(1), peer);
        assert!(media.open(peer, ConnectionId::new_unchecked(1)).is_some());
        // Another peer's connection: never.
        assert_eq!(media.open(PeerId::random(), ConnectionId::new_unchecked(1)), None);
    }
}
