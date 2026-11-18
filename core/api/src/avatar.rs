//! Profile picture and colour for other members (`docs/design/profile-avatar.md`,
//! #354). The picture travels in the profile post, so it is small and
//! checked strictly, on send and on every received post (untrusted). The core
//! never decodes pixels: it reads only the size, the type, the header's
//! declared dimensions and the chunk list.

use authority::image::ImageType;
use base64::Engine;

/// Bytes of image at most (design: 48×48 WebP, usually 1–2 KB).
pub const AVATAR_SMALL_MAX: usize = 2_560;
/// Declared width and height at most (Security Lead A1: no decompression bombs).
pub const AVATAR_SIDE_MAX: u32 = 64;
const WEBP_PREFIX: &str = "data:image/webp;base64,";
const PNG_PREFIX: &str = "data:image/png;base64,";
#[cfg(test)]
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

/// A picture another member may see: a WebP or PNG data URL of at most
/// [`AVATAR_SMALL_MAX`] bytes, still (no animation), at most
/// [`AVATAR_SIDE_MAX`] on each side, with the right magic bytes.
pub fn valid_avatar(url: &str) -> bool {
    let (data, webp) = match (url.strip_prefix(WEBP_PREFIX), url.strip_prefix(PNG_PREFIX)) {
        (Some(data), _) => (data, true),
        (_, Some(data)) => (data, false),
        _ => return false,
    };
    // Size before decoding (Tech Lead): base64 of the cap, rounded up.
    if data.len() > AVATAR_SMALL_MAX.div_ceil(3) * 4 {
        return false;
    }
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) else { return false };
    if bytes.len() > AVATAR_SMALL_MAX {
        return false;
    }
    // One validator with the server icon (G-51, Security Lead R2 on #547).
    let kind = if webp { ImageType::Webp } else { ImageType::Png };
    authority::image::still_size(&bytes, kind, AVATAR_SIDE_MAX).is_some()
}

/// G-51: a server icon from the UI's data URL, checked in the Security
/// Lead's order (R2 on #547): the prefix names the type; a length cap on
/// the base64 text before decoding; strict base64; then the shared
/// validator, which checks the magic bytes against that type and the size
/// against [`authority::ICON_SIDE_MAX`]. `None` for anything else.
pub fn icon_from_data_url(url: &str) -> Option<authority::Icon> {
    let (data, kind) = match (url.strip_prefix(WEBP_PREFIX), url.strip_prefix(PNG_PREFIX)) {
        (Some(data), _) => (data, ImageType::Webp),
        (_, Some(data)) => (data, ImageType::Png),
        _ => return None,
    };
    if data.len() > records::MAX_SERVER_ICON_BYTES.div_ceil(3) * 4 {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
    if bytes.len() > records::MAX_SERVER_ICON_BYTES {
        return None;
    }
    authority::image::still_size(&bytes, kind, authority::ICON_SIDE_MAX)?;
    Some(authority::Icon { kind, bytes })
}

/// G-51: a server icon as the data URL `ServerSummary.iconDataUrl` carries.
pub fn icon_data_url(icon: &authority::Icon) -> String {
    let prefix = match icon.kind {
        ImageType::Webp => WEBP_PREFIX,
        ImageType::Png => PNG_PREFIX,
    };
    format!("{prefix}{}", base64::engine::general_purpose::STANDARD.encode(&icon.bytes))
}

/// `#rrggbb`.
pub fn valid_color(color: &str) -> bool {
    color.len() == 7
        && color.starts_with('#')
        && color[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn url(prefix: &str, bytes: &[u8]) -> String {
        format!("{prefix}{}", base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut out = (data.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        out.extend_from_slice(&[0; 4]); // CRC: not checked
        out
    }

    /// A minimal PNG header and chunk list (no real pixels: never decoded).
    pub(crate) fn png(w: u32, h: u32, animated: bool) -> String {
        let mut b = PNG_SIGNATURE.to_vec();
        let mut ihdr = w.to_be_bytes().to_vec();
        ihdr.extend_from_slice(&h.to_be_bytes());
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
        b.extend(chunk(b"IHDR", &ihdr));
        if animated {
            b.extend(chunk(b"acTL", &[0, 0, 0, 2, 0, 0, 0, 0]));
        }
        b.extend(chunk(b"IDAT", &[0; 16]));
        b.extend(chunk(b"IEND", &[]));
        url(PNG_PREFIX, &b)
    }

    fn riff(chunks: &[(&[u8; 4], Vec<u8>)]) -> String {
        let mut body = b"WEBP".to_vec();
        for (kind, data) in chunks {
            body.extend_from_slice(*kind);
            body.extend_from_slice(&(data.len() as u32).to_le_bytes());
            body.extend_from_slice(data);
            if data.len() % 2 == 1 {
                body.push(0);
            }
        }
        let mut b = b"RIFF".to_vec();
        b.extend_from_slice(&(body.len() as u32).to_le_bytes());
        b.extend(body);
        url(WEBP_PREFIX, &b)
    }

    pub(crate) fn webp(w: u16, h: u16) -> String {
        let mut vp8 = vec![0, 0, 0, 0x9d, 0x01, 0x2a];
        vp8.extend_from_slice(&w.to_le_bytes());
        vp8.extend_from_slice(&h.to_le_bytes());
        vp8.extend_from_slice(&[0; 8]);
        riff(&[(b"VP8 ", vp8)])
    }

    /// Security Lead A1/A2, Tech Lead: sizes, dimensions, animation, types.
    #[test]
    fn avatars_are_checked_strictly() {
        assert!(valid_avatar(&webp(48, 48)));
        assert!(valid_avatar(&png(48, 48, false)));
        assert!(valid_avatar(&png(64, 64, false)));
        // A decompression bomb and an image one pixel too big.
        assert!(!valid_avatar(&png(10_000, 10_000, false)));
        assert!(!valid_avatar(&png(65, 65, false)));
        assert!(!valid_avatar(&webp(65, 64)));
        // Animation: APNG, an animated WebP (VP8X flag, ANIM/ANMF chunks).
        assert!(!valid_avatar(&png(48, 48, true)));
        let mut vp8x = vec![0x02, 0, 0, 0];
        vp8x.extend_from_slice(&[47, 0, 0, 47, 0, 0]);
        assert!(!valid_avatar(&riff(&[(b"VP8X", vp8x)])));
        assert!(!valid_avatar(&riff(&[(b"ANIM", vec![0; 6]), (b"ANMF", vec![0; 16])])));
        let still = vec![0, 0, 0, 0, 47, 0, 0, 47, 0, 0];
        // VP8X alone: no image chunk, refused. VP8X 48×48 with its VP8: fine.
        assert!(!valid_avatar(&riff(&[(b"VP8X", still.clone())])));
        let vp8 = |side: u16| {
            let mut d = vec![0, 0, 0, 0x9d, 0x01, 0x2a];
            d.extend_from_slice(&side.to_le_bytes());
            d.extend_from_slice(&side.to_le_bytes());
            d.extend_from_slice(&[0; 8]);
            d
        };
        let lossless = |w: u32, h: u32| {
            let mut d = vec![0x2f];
            d.extend_from_slice(&((w - 1) | ((h - 1) << 14)).to_le_bytes());
            d
        };
        assert!(valid_avatar(&riff(&[(b"VP8X", still.clone()), (b"VP8 ", vp8(48))])));
        // Security Lead (#359): a 48×48 VP8X can't vouch for a 16,383×16,383
        // VP8L after it; sizes must agree; one image chunk only.
        assert!(!valid_avatar(&riff(&[(b"VP8X", still.clone()), (b"VP8L", lossless(16_383, 16_383))])));
        assert!(!valid_avatar(&riff(&[(b"VP8X", still.clone()), (b"VP8 ", vp8(32))])));
        assert!(!valid_avatar(&riff(&[(b"VP8 ", vp8(48)), (b"VP8 ", vp8(48))])));
        assert!(!valid_avatar(&riff(&[(b"VP8 ", vp8(48)), (b"VP8L", lossless(48, 48))])));
        // VP8L (lossless): 48×48.
        let bits: u32 = 47 | (47 << 14);
        let mut vp8l = vec![0x2f];
        vp8l.extend_from_slice(&bits.to_le_bytes());
        assert!(valid_avatar(&riff(&[(b"VP8L", vp8l)])));
        // Too large, before decoding; bad base64; the wrong magic; SVG.
        let big = format!("{WEBP_PREFIX}{}", "A".repeat(4_000));
        assert!(!valid_avatar(&big));
        assert!(!valid_avatar(&format!("{PNG_PREFIX}!!!!")));
        assert!(!valid_avatar(&webp(48, 48).replace(WEBP_PREFIX, PNG_PREFIX)));
        assert!(!valid_avatar("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="));
        // Colours.
        assert!(valid_color("#3b82f6") && valid_color("#ABCDEF"));
        assert!(!valid_color("3b82f6") && !valid_color("#3b82f") && !valid_color("#3b82fg") && !valid_color(""));
    }
}
