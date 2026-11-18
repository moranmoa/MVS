//! Still PNG and WebP pictures, checked without decoding pixels: the one
//! validator for the profile picture (`core/api` avatar) and the server icon
//! (G-51, Security Lead R2 on #547). Only the headers and the chunk list are
//! read; nothing else is trusted.

/// The two picture types allowed anywhere: never SVG, GIF or JPEG.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ImageType {
    Png = 1,
    Webp = 2,
}

impl ImageType {
    /// The wire byte (1 PNG, 2 WebP).
    pub fn byte(self) -> u8 {
        self as u8
    }

    pub fn from_byte(byte: u8) -> Option<ImageType> {
        match byte {
            1 => Some(ImageType::Png),
            2 => Some(ImageType::Webp),
            _ => None,
        }
    }

    /// The data-URL MIME type.
    pub fn mime(self) -> &'static str {
        match self {
            ImageType::Png => "image/png",
            ImageType::Webp => "image/webp",
        }
    }
}

/// Most chunks a PNG may have (Security Lead R2).
pub const MAX_PNG_CHUNKS: usize = 64;

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

/// The size of a still picture of type `kind` with each side within
/// `1..=side_max`, or `None`. Strict:
/// - **PNG:** the signature, IHDR first, at most [`MAX_PNG_CHUNKS`] chunks,
///   IEND last with nothing after it, and no `acTL` (no APNG).
/// - **WebP:** RIFF/WEBP; exactly one `VP8 ` or `VP8L`, whose own size must
///   agree with a `VP8X` if there is one; no animation flag, `ANIM` or
///   `ANMF`; the chunks run exactly to the end.
///
/// The magic bytes must be those of `kind`.
pub fn still_size(bytes: &[u8], kind: ImageType, side_max: u32) -> Option<(u32, u32)> {
    let (w, h) = match kind {
        ImageType::Png => png_size(bytes)?,
        ImageType::Webp => webp_size(bytes, side_max)?,
    };
    ((1..=side_max).contains(&w) && (1..=side_max).contains(&h)).then_some((w, h))
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn le32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn png_size(b: &[u8]) -> Option<(u32, u32)> {
    if b.get(..8)? != PNG_SIGNATURE || b.get(12..16)? != b"IHDR" {
        return None;
    }
    let size = (be32(b, 16)?, be32(b, 20)?);
    // Walk the chunks: length, type, data, CRC.
    let mut at = 8;
    let mut chunks = 0;
    while at + 8 <= b.len() {
        chunks += 1;
        if chunks > MAX_PNG_CHUNKS {
            return None;
        }
        let len = be32(b, at)? as usize;
        let kind = b.get(at + 4..at + 8)?;
        let end = at.checked_add(12)?.checked_add(len)?;
        if kind == b"acTL" || end > b.len() {
            return None;
        }
        if kind == b"IEND" {
            // IEND is last: nothing may follow it.
            return (end == b.len()).then_some(size);
        }
        at = end;
    }
    None
}

fn webp_size(b: &[u8], side_max: u32) -> Option<(u32, u32)> {
    if b.get(..4)? != b"RIFF" || b.get(8..12)? != b"WEBP" {
        return None;
    }
    let mut size: Option<(u32, u32)> = None;
    let mut images = 0;
    let mut declare = |w: u32, h: u32| -> Option<()> {
        let fits = (1..=side_max).contains(&w) && (1..=side_max).contains(&h);
        if !fits || size.is_some_and(|s| s != (w, h)) {
            return None;
        }
        size = Some((w, h));
        Some(())
    };
    let mut at = 12;
    while at < b.len() {
        let kind = b.get(at..at + 4)?;
        let len = le32(b, at + 4)? as usize;
        let data = b.get(at + 8..(at + 8).checked_add(len)?)?;
        match kind {
            b"ANIM" | b"ANMF" => return None,
            b"VP8X" => {
                if data.first()? & 0x02 != 0 {
                    return None; // the animation flag
                }
                let w = u32::from_le_bytes([*data.get(4)?, *data.get(5)?, *data.get(6)?, 0]) + 1;
                let h = u32::from_le_bytes([*data.get(7)?, *data.get(8)?, *data.get(9)?, 0]) + 1;
                declare(w, h)?;
            }
            b"VP8 " => {
                // Frame tag (3), start code 9d 01 2a, then 14-bit w and h.
                if data.get(3..6)? != [0x9d, 0x01, 0x2a] {
                    return None;
                }
                let w = u32::from(u16::from_le_bytes([*data.get(6)?, *data.get(7)?]) & 0x3fff);
                let h = u32::from(u16::from_le_bytes([*data.get(8)?, *data.get(9)?]) & 0x3fff);
                declare(w, h)?;
                images += 1;
            }
            b"VP8L" => {
                if *data.first()? != 0x2f {
                    return None;
                }
                let bits = le32(data, 1)?;
                declare((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)?;
                images += 1;
            }
            _ => {}
        }
        // Chunks are padded to an even length.
        at = at.checked_add(8)?.checked_add(len)?.checked_add(len & 1)?;
    }
    // Exactly one image chunk, and the chunks end exactly at the end.
    (images == 1 && at == b.len()).then_some(size?)
}
