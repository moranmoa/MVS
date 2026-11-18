//! G-51: the server's icon (`ServerIcon = 23`) and description
//! (`ServerDescription = 24`), control records the owner or an admin signs.
//! Every state test runs the reference `resolve` and the incremental
//! `Resolver` over many delivery orders and requires them to agree.

mod common;
mod rng;

use authority::image::{still_size, ImageType, MAX_PNG_CHUNKS};
use authority::{
    resolve, server_description_ok, Action, Icon, Record, RecordId, Resolver, Role, State, ICON_SIDE_MAX,
    MAX_SERVER_DESCRIPTION,
};
use common::{actor, founded, rec, server};
use records::{Draft, Kind, Scope, MAX_SERVER_ICON_BYTES};
use rng::{SliceRandom, StdRng};

const ORDERS: u64 = 200;

fn all_orders(records: &[Record]) -> State {
    let expected = resolve(server(), records);
    let mut rng = StdRng::seed_from_u64(51);
    let mut arriving = records.to_vec();
    for round in 0..=ORDERS {
        if round > 0 {
            arriving.shuffle(&mut rng);
        }
        assert_eq!(resolve(server(), &arriving), expected, "resolve depends on order");
        let mut resolver = Resolver::new(server());
        for record in &arriving {
            resolver.insert(record.clone());
        }
        assert_eq!(resolver.state(), &expected, "incremental disagrees with resolve");
    }
    expected
}

// ---- minimal pictures (headers only: never decoded) ----

fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut out = (data.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    out.extend_from_slice(&[0; 4]);
    out
}

fn png_with(w: u32, h: u32, extra: &[(&[u8; 4], Vec<u8>)], tail: &[u8]) -> Vec<u8> {
    let mut b = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut ihdr = w.to_be_bytes().to_vec();
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    b.extend(png_chunk(b"IHDR", &ihdr));
    for (kind, data) in extra {
        b.extend(png_chunk(kind, data));
    }
    b.extend(png_chunk(b"IDAT", &[0; 16]));
    b.extend(png_chunk(b"IEND", &[]));
    b.extend_from_slice(tail);
    b
}

fn png(w: u32, h: u32) -> Vec<u8> {
    png_with(w, h, &[], &[])
}

fn riff(chunks: &[(&[u8; 4], Vec<u8>)]) -> Vec<u8> {
    let mut body = b"WEBP".to_vec();
    for (kind, data) in chunks {
        body.extend_from_slice(*kind);
        body.extend_from_slice(&(data.len() as u32).to_le_bytes());
        body.extend_from_slice(data);
        if data.len() % 2 == 1 {
            body.push(0);
        }
    }
    let mut out = b"RIFF".to_vec();
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend(body);
    out
}

fn vp8l(w: u32, h: u32) -> Vec<u8> {
    let bits = (w - 1) | ((h - 1) << 14);
    let mut data = vec![0x2f];
    data.extend_from_slice(&bits.to_le_bytes());
    data.extend_from_slice(&[0; 6]);
    data
}

fn vp8x(w: u32, h: u32, flags: u8) -> Vec<u8> {
    let mut data = vec![flags, 0, 0, 0];
    data.extend_from_slice(&(w - 1).to_le_bytes()[..3]);
    data.extend_from_slice(&(h - 1).to_le_bytes()[..3]);
    data
}

fn webp(w: u32, h: u32) -> Vec<u8> {
    riff(&[(b"VP8L", vp8l(w, h))])
}

#[test]
fn icons_are_still_png_or_webp_up_to_128_px() {
    assert_eq!(still_size(&png(128, 64), ImageType::Png, ICON_SIDE_MAX), Some((128, 64)));
    assert_eq!(still_size(&webp(1, 128), ImageType::Webp, ICON_SIDE_MAX), Some((1, 128)));
    let with_vp8x = riff(&[(b"VP8X", vp8x(100, 100, 0)), (b"VP8L", vp8l(100, 100))]);
    assert_eq!(still_size(&with_vp8x, ImageType::Webp, ICON_SIDE_MAX), Some((100, 100)));

    let many_chunks: Vec<(&[u8; 4], Vec<u8>)> = (0..MAX_PNG_CHUNKS).map(|_| (b"tEXt", vec![b'a'])).collect();
    let refused: [(&str, Vec<u8>, ImageType); 13] = [
        ("129 px", png(129, 10), ImageType::Png),
        ("0 px", png(0, 10), ImageType::Png),
        ("APNG", png_with(10, 10, &[(b"acTL", vec![0; 8])], &[]), ImageType::Png),
        ("bytes after IEND", png_with(10, 10, &[], b"junk"), ImageType::Png),
        ("too many chunks", png_with(10, 10, &many_chunks, &[]), ImageType::Png),
        ("a PNG called WebP", png(10, 10), ImageType::Webp),
        ("a WebP called PNG", webp(10, 10), ImageType::Png),
        ("an animated WebP", riff(&[(b"VP8X", vp8x(10, 10, 0x02)), (b"VP8L", vp8l(10, 10))]), ImageType::Webp),
        ("ANIM", riff(&[(b"ANIM", vec![0; 6]), (b"VP8L", vp8l(10, 10))]), ImageType::Webp),
        ("two image chunks", riff(&[(b"VP8L", vp8l(10, 10)), (b"VP8L", vp8l(10, 10))]), ImageType::Webp),
        ("VP8X disagrees", riff(&[(b"VP8X", vp8x(10, 10, 0)), (b"VP8L", vp8l(20, 20))]), ImageType::Webp),
        ("a small VP8X, a huge image", riff(&[(b"VP8X", vp8x(10, 10, 0)), (b"VP8L", vp8l(1000, 1000))]), ImageType::Webp),
        ("trailing bytes", [webp(10, 10), vec![0, 0]].concat(), ImageType::Webp),
    ];
    for (what, bytes, kind) in refused {
        assert_eq!(still_size(&bytes, kind, ICON_SIDE_MAX), None, "{what}");
    }
}

fn icon(author: u8, seq: u64, deps: Vec<RecordId>, image: Option<(ImageType, Vec<u8>)>) -> Record {
    let icon = image.map(|(kind, bytes)| Icon { kind, bytes });
    rec(author, seq, deps, Action::ServerIcon { icon })
}

fn describe(author: u8, seq: u64, deps: Vec<RecordId>, text: &str) -> Record {
    rec(author, seq, deps, Action::ServerDescription { text: text.into() })
}

/// The owner (0) with an admin (1), a moderator (2) and a member (3).
fn staffed() -> (Vec<Record>, RecordId) {
    let (mut records, heads) = founded(&[1, 2, 3]);
    let admin = rec(0, 2, heads, Action::Grant { target: actor(1), role: Role::Admin });
    let moderator = rec(0, 3, vec![admin.id()], Action::Grant { target: actor(2), role: Role::Moderator });
    let head = moderator.id();
    records.extend([admin, moderator]);
    (records, head)
}

#[test]
fn the_owner_or_an_admin_sets_them_the_latest_counts_and_empty_clears() {
    let (mut records, head) = staffed();
    let by_owner = icon(0, 10, vec![head], Some((ImageType::Png, png(64, 64))));
    let by_admin = describe(1, 1, vec![head], "Welcome!\n\nBe kind.");
    let by_moderator = describe(2, 1, vec![head], "moderator");
    let by_member = icon(3, 1, vec![head], Some((ImageType::Webp, webp(8, 8))));
    records.extend([by_owner.clone(), by_admin.clone(), by_moderator.clone(), by_member.clone()]);
    let state = all_orders(&records);
    assert!(state.accepted.contains(&by_owner.id()) && state.accepted.contains(&by_admin.id()));
    assert!(!state.accepted.contains(&by_moderator.id()) && !state.accepted.contains(&by_member.id()));
    assert_eq!(state.server_icon, Some(Icon { kind: ImageType::Png, bytes: png(64, 64) }));
    assert_eq!(state.server_description.as_deref(), Some("Welcome!\n\nBe kind."));

    // A rename leaves them alone; concurrent icons: the later in linear order.
    let rename = rec(0, 11, vec![by_owner.id(), by_admin.id()], Action::ServerEdit { name: "New".into() });
    let one = icon(0, 12, vec![rename.id()], Some((ImageType::Webp, webp(10, 10))));
    let two = icon(1, 2, vec![rename.id()], Some((ImageType::Webp, webp(20, 20))));
    records.extend([rename, one.clone(), two.clone()]);
    let state = all_orders(&records);
    assert_eq!(state.server_name.as_deref(), Some("New"));
    assert_eq!(state.server_description.as_deref(), Some("Welcome!\n\nBe kind."));
    let latest = if one.id() > two.id() { webp(10, 10) } else { webp(20, 20) };
    assert_eq!(state.server_icon.map(|i| i.bytes), Some(latest));

    // Clearing both.
    let no_icon = icon(1, 3, vec![one.id(), two.id()], None);
    let no_text = describe(1, 4, vec![no_icon.id()], "");
    records.extend([no_icon, no_text]);
    let state = all_orders(&records);
    assert_eq!((state.server_icon, state.server_description), (None, None));
}

#[test]
fn a_demotion_voids_concurrent_ones() {
    let (mut records, head) = staffed();
    let concurrent = describe(1, 1, vec![head], "backdated");
    let demoted = rec(0, 10, vec![head], Action::revoke(actor(1)));
    let after = icon(1, 2, vec![demoted.id()], Some((ImageType::Png, png(8, 8))));
    records.extend([concurrent.clone(), demoted.clone(), after.clone()]);
    let state = all_orders(&records);
    assert!(state.accepted.contains(&demoted.id()));
    assert!(!state.accepted.contains(&concurrent.id()));
    assert!(!state.accepted.contains(&after.id()));
    assert_eq!((state.server_icon, state.server_description), (None, None));
}

#[test]
fn descriptions_are_up_to_five_plain_lines() {
    let full = "ש".repeat(MAX_SERVER_DESCRIPTION);
    for ok in ["Welcome", "ברוכים הבאים\nשורה שנייה", "a\n\nb", "1\n2\n3\n4\n5", full.as_str()] {
        assert!(server_description_ok(ok), "{ok:?}");
    }
    let long = "ש".repeat(MAX_SERVER_DESCRIPTION + 1);
    for bad in [
        "", " lead", "trail\n", "\nfirst blank", "a\n\n\nb", "1\n2\n3\n4\n5\n6", "a\r\nb", "a\u{2028}b", "a\u{2029}b",
        "a\u{202E}b", "a\u{200B}b", "a\tb", "trailing \nspace", "a\n \nb", long.as_str(),
    ] {
        assert!(!server_description_ok(bad), "{bad:?}");
    }
}

/// A body that fails any rule doesn't parse, so it's never accepted.
#[test]
fn malformed_bodies_do_not_parse() {
    let draft = |kind, body: Vec<u8>| {
        Draft { server: server(), scope: Scope::Control, seq: 9, deps: vec![], auth_deps: vec![], ts: 0, kind, body }
            .sign(&common::key(0))
            .unwrap()
    };
    let parses = |kind, body: Vec<u8>| Action::from_record(&draft(kind, body)).is_some();
    let good = png(16, 16);
    assert!(parses(Kind::ServerIcon, [vec![0, 1], good.clone()].concat()));
    assert!(parses(Kind::ServerIcon, vec![0, 0]), "clears");
    assert!(parses(Kind::ServerDescription, b"\0text".to_vec()));
    assert!(parses(Kind::ServerDescription, vec![0]), "clears");
    // Over 8 KiB doesn't even sign: `records` caps the body first.
    let too_big = png_with(16, 16, &[(b"tEXt", vec![b'a'; MAX_SERVER_ICON_BYTES])], &[]);
    let oversized = Draft {
        server: server(),
        scope: Scope::Control,
        seq: 9,
        deps: vec![],
        auth_deps: vec![],
        ts: 0,
        kind: Kind::ServerIcon,
        body: [vec![0, 1], too_big].concat(),
    };
    assert!(oversized.sign(&common::key(0)).is_err());
    for (what, body) in [
        ("history byte", [vec![1, 1], good.clone()].concat()),
        ("type 3", [vec![0, 3], good.clone()].concat()),
        ("type and magic disagree", [vec![0, 2], good.clone()].concat()),
        ("type 0 with an image", [vec![0, 0], good.clone()].concat()),
        ("a type with no image", vec![0, 1]),
        ("no type byte", vec![0]),
    ] {
        assert!(!parses(Kind::ServerIcon, body), "{what}");
    }
    for (what, body) in [
        ("history byte", b"\x01text".to_vec()),
        ("bad UTF-8", vec![0, 0xff]),
        ("six lines", b"\x001\n2\n3\n4\n5\n6".to_vec()),
        ("a CR", b"\x00a\r\nb".to_vec()),
    ] {
        assert!(!parses(Kind::ServerDescription, body), "{what}");
    }
}
