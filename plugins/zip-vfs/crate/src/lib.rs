//! zip-vfs — a Filament backend plugin (WASM) that mounts `.zip` archives as
//! folders, so `/home/me/kit.zip!/src` behaves like a directory.
//!
//! Zero dependencies, zero network: a hand-written ZIP central-directory
//! parser plus a from-scratch RFC 1951 (raw DEFLATE) inflater.
//!
//! ## ABI (see `src/wasmhost.rs` in the daemon)
//! * exports: `memory`, `alloc(len: i32) -> i32`, `handle(ptr: i32, len: i32) -> i32`
//! * imports: `env.host(ptr: i32, len: i32) -> i32`
//! * `handle` receives the raw UTF-8 request; the buffer it *returns* is a
//!   4-byte little-endian length header followed by the body.
//! * `env.host` returns a buffer in the same headered form.
//!
//! ## Protocol
//! ```text
//! list\t<archive>\t<inner_dir>   ->  ok\n<name>\t<kind>\t<size>\n…
//! read\t<archive>\t<inner_file>  ->  ok\n<raw inflated bytes>
//! ```
//! Errors are `err\n<message>\n`.

use std::collections::BTreeMap;

extern "C" {
    /// Host call. Request body is a line record; response is headered.
    fn host(ptr: i32, len: i32) -> i32;
}

/// Refuse to inflate more than this per entry (zip-bomb guard).
const MAX_ENTRY: usize = 64 * 1024 * 1024;
/// Refuse to accept an archive larger than this.
const MAX_ARCHIVE: usize = 512 * 1024 * 1024;
/// ZIP64 end-of-central-directory record.
const ZIP64_EOCD: u32 = 0x0606_4b50;
const ZIP64_LOCATOR: u32 = 0x0706_4b50;
const EOCD: u32 = 0x0605_4b50;
const CENTRAL: u32 = 0x0201_4b50;
const LOCAL: u32 = 0x0403_4b50;

// ---------------------------------------------------------------- ABI glue

/// Allocate `len` bytes of guest linear memory. The buffer is intentionally
/// leaked: a plugin instance is short-lived and the host owns no free list.
#[no_mangle]
pub extern "C" fn alloc(len: i32) -> i32 {
    if len <= 0 {
        return 0;
    }
    let mut v: Vec<u8> = Vec::with_capacity(len as usize);
    let p = v.as_mut_ptr() as i32;
    std::mem::forget(v);
    p
}

/// Plugin entry point. Returns a pointer to a `[u32 len][body]` buffer.
#[no_mangle]
pub extern "C" fn handle(ptr: i32, len: i32) -> i32 {
    let req: &[u8] = if ptr <= 0 || len < 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) }
    };
    let resp = dispatch(req);
    publish(&resp)
}

fn publish(body: &[u8]) -> i32 {
    let mut out = Vec::with_capacity(body.len() + 4);
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(body);
    let p = out.as_ptr() as i32;
    std::mem::forget(out);
    p
}

fn host_call(req: &[u8]) -> Vec<u8> {
    let ptr = unsafe { host(req.as_ptr() as i32, req.len() as i32) };
    if ptr <= 0 {
        return Vec::new();
    }
    unsafe {
        let p = ptr as *const u8;
        let len = u32::from_le_bytes([*p, *p.add(1), *p.add(2), *p.add(3)]) as usize;
        std::slice::from_raw_parts(p.add(4), len).to_vec()
    }
}

fn dispatch(req: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(req);
    let mut lines = text.split('\n');
    let head = lines.next().unwrap_or("").trim_end_matches('\r');
    let mut parts = head.splitn(3, '\t');
    let op = parts.next().unwrap_or("").trim();
    let archive = parts.next().unwrap_or("").trim_end_matches('\r');
    let tail = parts.next().unwrap_or("").trim_end_matches('\r');

    match op {
        "list" => match zip_list(archive, tail) {
            Ok(body) => body,
            Err(e) => format!("err\n{e}\n").into_bytes(),
        },
        "read" => match zip_read(archive, tail) {
            Ok(bytes) => {
                let mut out = Vec::with_capacity(bytes.len() + 4);
                out.extend_from_slice(b"ok\n");
                out.extend_from_slice(&bytes);
                out
            }
            Err(e) => format!("err\n{e}\n").into_bytes(),
        },
        other => format!("err\nunknown op '{other}'\n").into_bytes(),
    }
}

// ------------------------------------------------------------ host bridging

/// Ask the host for the archive bytes (capability `fs:read`).
fn fetch_archive(archive: &str) -> Result<Vec<u8>, String> {
    if archive.is_empty() {
        return Err("missing archive path".into());
    }
    let req = format!("read_file\n{archive}\n");
    let resp = host_call(req.as_bytes());
    if resp.is_empty() {
        return Err("host call returned nothing".into());
    }
    if let Some(rest) = resp.strip_prefix(&b"ok\n"[..]) {
        if rest.len() > MAX_ARCHIVE {
            return Err(format!("archive too large ({} bytes)", rest.len()));
        }
        Ok(rest.to_vec())
    } else {
        Err(host_error(&resp))
    }
}

fn host_error(resp: &[u8]) -> String {
    if let Some(rest) = resp.strip_prefix(&b"err\n"[..]) {
        String::from_utf8_lossy(rest).trim().to_string()
    } else {
        "host call failed".into()
    }
}

// -------------------------------------------------------------- zip model

struct ZipEntry {
    name: String,
    flags: u16,
    method: u16,
    comp_size: u64,
    uncomp_size: u64,
    crc: u32,
    local_off: u64,
    is_dir: bool,
}

fn u16le(d: &[u8], off: usize) -> Result<u16, String> {
    match d.get(off..off + 2) {
        Some(s) => Ok(u16::from_le_bytes([s[0], s[1]])),
        None => Err("truncated zip".into()),
    }
}

fn u32le(d: &[u8], off: usize) -> Result<u32, String> {
    match d.get(off..off + 4) {
        Some(s) => Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]])),
        None => Err("truncated zip".into()),
    }
}

fn u64le(d: &[u8], off: usize) -> Result<u64, String> {
    match d.get(off..off + 8) {
        Some(s) => Ok(u64::from_le_bytes([
            s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7],
        ])),
        None => Err("truncated zip".into()),
    }
}

/// Locate the end-of-central-directory record (searching backwards, since a
/// trailing archive comment may follow it) and return (count, cd_offset,
/// cd_size), following the ZIP64 locator when the 32-bit fields are saturated.
fn find_central_directory(d: &[u8]) -> Result<(u64, u64, u64), String> {
    if d.len() < 22 {
        return Err("not a zip archive (too small)".into());
    }
    let search_start = d.len().saturating_sub(22 + 0xffff);
    let mut eocd_pos = None;
    let mut i = d.len() - 22;
    loop {
        if u32le(d, i).map(|s| s == EOCD).unwrap_or(false) {
            eocd_pos = Some(i);
            break;
        }
        if i == search_start {
            break;
        }
        i -= 1;
    }
    let eocd = eocd_pos.ok_or_else(|| "not a zip archive (no end-of-central-directory)".to_string())?;

    let mut count = u16le(d, eocd + 10)? as u64;
    let mut cd_size = u32le(d, eocd + 12)? as u64;
    let mut cd_off = u32le(d, eocd + 16)? as u64;

    let needs_zip64 = count == 0xffff || cd_size == 0xffff_ffff || cd_off == 0xffff_ffff;
    if needs_zip64 && eocd >= 20 {
        let loc_sig = u32le(d, eocd - 20)?;
        if loc_sig == ZIP64_LOCATOR {
            let z64_off = u64le(d, eocd - 20 + 8)?;
            let z64 = z64_off as usize;
            if u32le(d, z64).map(|s| s == ZIP64_EOCD).unwrap_or(false) {
                count = u64le(d, z64 + 32)?;
                cd_size = u64le(d, z64 + 40)?;
                cd_off = u64le(d, z64 + 48)?;
            }
        }
    }
    Ok((count, cd_off, cd_size))
}

/// Parse the central directory. Entries with hostile names are dropped here,
/// so every later stage only ever sees validated names.
fn parse_central(d: &[u8]) -> Result<Vec<ZipEntry>, String> {
    let (count, cd_off, _cd_size) = find_central_directory(d)?;
    let mut off = cd_off as usize;
    let mut out = Vec::new();
    let mut seen = 0u64;

    while seen < count {
        if u32le(d, off).map(|s| s != CENTRAL).unwrap_or(true) {
            break; // no more (or malformed) central entries
        }
        let flags = u16le(d, off + 8)?;
        let method = u16le(d, off + 10)?;
        let crc = u32le(d, off + 16)?;
        let mut comp_size = u32le(d, off + 20)? as u64;
        let mut uncomp_size = u32le(d, off + 24)? as u64;
        let name_len = u16le(d, off + 28)? as usize;
        let extra_len = u16le(d, off + 30)? as usize;
        let comment_len = u16le(d, off + 32)? as usize;
        let mut local_off = u32le(d, off + 42)? as u64;

        let name_start = off + 46;
        let name_end = name_start
            .checked_add(name_len)
            .ok_or_else(|| "bad zip entry name length".to_string())?;
        let raw_name = d
            .get(name_start..name_end)
            .ok_or_else(|| "truncated zip entry name".to_string())?;
        let name = String::from_utf8_lossy(raw_name).to_string();

        // ZIP64 extended information, if any field is saturated.
        if comp_size == 0xffff_ffff || uncomp_size == 0xffff_ffff || local_off == 0xffff_ffff {
            let extra = d
                .get(name_end..name_end + extra_len)
                .ok_or_else(|| "truncated zip extra field".to_string())?;
            let mut e = 0usize;
            while e + 4 <= extra.len() {
                let id = u16::from_le_bytes([extra[e], extra[e + 1]]);
                let sz = u16::from_le_bytes([extra[e + 2], extra[e + 3]]) as usize;
                let body_start = e + 4;
                let body_end = (body_start + sz).min(extra.len());
                if id == 0x0001 {
                    let body = &extra[body_start..body_end];
                    let mut c = 0usize;
                    let take = |need: bool, c: &mut usize| -> Option<u64> {
                        if !need || *c + 8 > body.len() {
                            return None;
                        }
                        let v = u64::from_le_bytes(body[*c..*c + 8].try_into().ok()?);
                        *c += 8;
                        Some(v)
                    };
                    if let Some(v) = take(uncomp_size == 0xffff_ffff, &mut c) {
                        uncomp_size = v;
                    }
                    if let Some(v) = take(comp_size == 0xffff_ffff, &mut c) {
                        comp_size = v;
                    }
                    if let Some(v) = take(local_off == 0xffff_ffff, &mut c) {
                        local_off = v;
                    }
                    break;
                }
                e = body_end;
            }
        }

        let is_dir = name.ends_with('/') || (comp_size == 0 && uncomp_size == 0 && name.ends_with('\\'));

        if safe_name(&name).is_some() {
            out.push(ZipEntry {
                name,
                flags,
                method,
                comp_size,
                uncomp_size,
                crc,
                local_off,
                is_dir,
            });
        }

        off = name_end + extra_len + comment_len;
        seen += 1;
    }
    Ok(out)
}

/// Reject traversal (`..`), absolute (`/…`) and control-character names.
fn safe_name(name: &str) -> Option<&str> {
    if name.is_empty() || name.contains('\0') {
        return None;
    }
    if name.starts_with('/') || name.starts_with('\\') {
        return None;
    }
    for part in name.split(['/', '\\']) {
        if part == ".." {
            return None;
        }
    }
    Some(name)
}

/// Resolve an entry's payload slice via its local file header.
fn local_payload<'a>(d: &'a [u8], e: &ZipEntry) -> Result<&'a [u8], String> {
    let lo = e.local_off as usize;
    if u32le(d, lo).map(|s| s != LOCAL).unwrap_or(true) {
        return Err("bad local file header".into());
    }
    let name_len = u16le(d, lo + 26)? as usize;
    let extra_len = u16le(d, lo + 28)? as usize;
    let start = lo
        .checked_add(30 + name_len + extra_len)
        .ok_or_else(|| "bad local header offsets".to_string())?;
    let end = start
        .checked_add(e.comp_size as usize)
        .ok_or_else(|| "bad entry size".to_string())?;
    d.get(start..end)
        .ok_or_else(|| "truncated entry data".to_string())
}

// ------------------------------------------------------------- list / read

fn zip_list(archive: &str, inner: &str) -> Result<Vec<u8>, String> {
    let data = fetch_archive(archive)?;
    let entries = parse_central(&data)?;

    let inner = inner.trim_matches('/');
    let prefix = if inner.is_empty() {
        String::new()
    } else {
        format!("{inner}/")
    };

    // name -> (kind, size); a BTreeMap gives stable, sorted output and
    // de-duplicates implied directories for free.
    let mut children: BTreeMap<String, (u8, u64)> = BTreeMap::new();

    for e in &entries {
        let Some(name) = safe_name(&e.name) else { continue };
        let name = name.replace('\\', "/");
        if !prefix.is_empty() && !name.starts_with(prefix.as_str()) {
            continue;
        }
        let rel = &name[prefix.len()..];
        let rel = rel.trim_matches('/');
        if rel.is_empty() {
            continue; // the inner dir itself
        }
        match rel.find('/') {
            Some(idx) => {
                // Deeper path: the first segment is a directory.
                children.entry(rel[..idx].to_string()).or_insert((1, 0));
            }
            None => {
                let (kind, size) = if e.is_dir { (1u8, 0u64) } else { (0u8, e.uncomp_size) };
                let slot = children.entry(rel.to_string()).or_insert((kind, size));
                if kind == 0 {
                    *slot = (0, size);
                }
            }
        }
    }

    let mut body = String::from("ok\n");
    for (name, (kind, size)) in children {
        body.push_str(&name);
        body.push('\t');
        body.push_str(&kind.to_string());
        body.push('\t');
        body.push_str(&size.to_string());
        body.push('\n');
    }
    Ok(body.into_bytes())
}

fn zip_read(archive: &str, inner: &str) -> Result<Vec<u8>, String> {
    let data = fetch_archive(archive)?;
    let entries = parse_central(&data)?;
    let want = inner.trim_matches('/');
    if want.is_empty() {
        return Err("empty entry path".into());
    }

    let mut found: Option<&ZipEntry> = None;
    for e in &entries {
        if e.is_dir {
            continue;
        }
        if let Some(name) = safe_name(&e.name) {
            if name.replace('\\', "/") == want {
                found = Some(e);
                break;
            }
        }
    }
    let e = found.ok_or_else(|| format!("entry not found: {want}"))?;

    // Bit 0 of the general-purpose flags means the entry is encrypted
    // (traditional ZipCrypto or AES); inflating the ciphertext would only
    // produce a confusing crc32/size error, so say what is actually wrong.
    if e.flags & 0x0001 != 0 {
        return Err("encrypted entries are not supported".into());
    }

    if e.uncomp_size as usize > MAX_ENTRY {
        return Err(format!("entry too large ({} bytes)", e.uncomp_size));
    }
    let raw = local_payload(&data, e)?;

    let bytes = match e.method {
        0 => raw.to_vec(),
        8 => inflate(raw, MAX_ENTRY)?,
        m => return Err(format!("unsupported compression method {m}")),
    };

    if e.uncomp_size != 0 && bytes.len() as u64 != e.uncomp_size {
        return Err(format!(
            "size mismatch: expected {}, inflated {}",
            e.uncomp_size,
            bytes.len()
        ));
    }
    if e.crc != 0 && crc32(&bytes) != e.crc {
        return Err("crc32 mismatch (corrupt archive or bad deflate)".into());
    }
    Ok(bytes)
}

// ------------------------------------------------------- RFC 1951 inflate

/// Canonical Huffman decoding table, in the style of Mark Adler's `puff`.
struct Huffman {
    count: [u16; 16],
    symbol: Vec<u16>,
}

impl Huffman {
    fn from_lengths(lengths: &[u8]) -> Result<Huffman, String> {
        let mut count = [0u16; 16];
        for &l in lengths {
            if l > 15 {
                return Err("invalid huffman code length".into());
            }
            count[l as usize] += 1;
        }
        count[0] = 0;

        // Detect an over-subscribed (impossible) code. An *incomplete* code is
        // tolerated: the fixed-distance table is legitimately incomplete.
        let mut left: i32 = 1;
        for len in 1..16 {
            left <<= 1;
            left -= count[len] as i32;
            if left < 0 {
                return Err("over-subscribed huffman code".into());
            }
        }

        let mut offs = [0u16; 16];
        for len in 1..15 {
            offs[len + 1] = offs[len] + count[len];
        }
        let mut symbol = vec![0u16; lengths.len()];
        for (i, &l) in lengths.iter().enumerate() {
            if l != 0 {
                symbol[offs[l as usize] as usize] = i as u16;
                offs[l as usize] += 1;
            }
        }
        Ok(Huffman { count, symbol })
    }

    fn decode(&self, br: &mut BitReader) -> Result<u16, String> {
        let mut code: i32 = 0;
        let mut first: i32 = 0;
        let mut index: i32 = 0;
        for len in 1..16 {
            code |= br.bits(1)? as i32;
            let count = self.count[len] as i32;
            if code - first < count {
                return Ok(self.symbol[(index + (code - first)) as usize]);
            }
            index += count;
            first += count;
            first <<= 1;
            code <<= 1;
        }
        Err("invalid huffman code".into())
    }
}

/// LSB-first bit reader over the raw deflate stream.
struct BitReader<'a> {
    data: &'a [u8],
    pos: usize,
    bitbuf: u32,
    bitcnt: u32,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        BitReader {
            data,
            pos: 0,
            bitbuf: 0,
            bitcnt: 0,
        }
    }

    fn need(&mut self, n: u32) -> Result<(), String> {
        while self.bitcnt < n {
            match self.data.get(self.pos) {
                Some(&b) => {
                    self.bitbuf |= (b as u32) << self.bitcnt;
                    self.pos += 1;
                    self.bitcnt += 8;
                }
                None => return Err("unexpected end of deflate stream".into()),
            }
        }
        Ok(())
    }

    fn bits(&mut self, n: u32) -> Result<u32, String> {
        if n == 0 {
            return Ok(0);
        }
        self.need(n)?;
        let v = self.bitbuf & ((1u32 << n) - 1);
        self.bitbuf >>= n;
        self.bitcnt -= n;
        Ok(v)
    }

    /// Discard bits up to the next byte boundary (for stored blocks).
    fn align(&mut self) {
        let r = self.bitcnt % 8;
        self.bitbuf >>= r;
        self.bitcnt -= r;
    }

    fn read_bytes(&mut self, n: usize) -> Result<Vec<u8>, String> {
        self.align();
        let mut out = Vec::with_capacity(n);
        while out.len() < n && self.bitcnt >= 8 {
            out.push((self.bitbuf & 0xff) as u8);
            self.bitbuf >>= 8;
            self.bitcnt -= 8;
        }
        while out.len() < n {
            match self.data.get(self.pos) {
                Some(&b) => {
                    out.push(b);
                    self.pos += 1;
                }
                None => return Err("unexpected end of deflate stream".into()),
            }
        }
        Ok(out)
    }
}

const LEN_BASE: [u16; 29] = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
    163, 195, 227, 258,
];
const LEN_EXTRA: [u32; 29] = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE: [u16; 30] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
    2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA: [u32; 30] = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13,
];
const CODE_LENGTH_ORDER: [usize; 19] = [
    16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];

fn fixed_tables() -> (Huffman, Huffman) {
    let mut lit = [0u8; 288];
    for (i, slot) in lit.iter_mut().enumerate() {
        *slot = match i {
            0..=143 => 8,
            144..=255 => 9,
            256..=279 => 7,
            _ => 8,
        };
    }
    let dist = [5u8; 30];
    (
        Huffman::from_lengths(&lit).expect("fixed literal table"),
        Huffman::from_lengths(&dist).expect("fixed distance table"),
    )
}

fn dynamic_tables(br: &mut BitReader) -> Result<(Huffman, Huffman), String> {
    let hlit = br.bits(5)? as usize + 257;
    let hdist = br.bits(5)? as usize + 1;
    let hclen = br.bits(4)? as usize + 4;

    let mut cl_lengths = [0u8; 19];
    for &idx in CODE_LENGTH_ORDER.iter().take(hclen) {
        cl_lengths[idx] = br.bits(3)? as u8;
    }
    let cl = Huffman::from_lengths(&cl_lengths)?;

    let total = hlit + hdist;
    let mut lengths = vec![0u8; total];
    let mut i = 0usize;
    while i < total {
        let sym = cl.decode(br)?;
        match sym {
            0..=15 => {
                lengths[i] = sym as u8;
                i += 1;
            }
            16 => {
                if i == 0 {
                    return Err("repeat with no previous length".into());
                }
                let prev = lengths[i - 1];
                let n = 3 + br.bits(2)? as usize;
                if i + n > total {
                    return Err("code length repeat overflows".into());
                }
                for _ in 0..n {
                    lengths[i] = prev;
                    i += 1;
                }
            }
            17 | 18 => {
                let n = if sym == 17 {
                    3 + br.bits(3)? as usize
                } else {
                    11 + br.bits(7)? as usize
                };
                if i + n > total {
                    return Err("code length repeat overflows".into());
                }
                i += n; // lengths are already zero
            }
            _ => return Err("invalid code length symbol".into()),
        }
    }

    Ok((
        Huffman::from_lengths(&lengths[..hlit])?,
        Huffman::from_lengths(&lengths[hlit..])?,
    ))
}

fn inflate_block(
    br: &mut BitReader,
    lit: &Huffman,
    dist: &Huffman,
    out: &mut Vec<u8>,
    limit: usize,
) -> Result<(), String> {
    loop {
        let sym = lit.decode(br)?;
        match sym {
            0..=255 => {
                if out.len() >= limit {
                    return Err("inflate output limit exceeded".into());
                }
                out.push(sym as u8);
            }
            256 => return Ok(()),
            _ => {
                let li = (sym - 257) as usize;
                if li >= LEN_BASE.len() {
                    return Err("invalid length code".into());
                }
                let len = LEN_BASE[li] as usize + br.bits(LEN_EXTRA[li])? as usize;

                let dsym = dist.decode(br)? as usize;
                if dsym >= DIST_BASE.len() {
                    return Err("invalid distance code".into());
                }
                let d = DIST_BASE[dsym] as usize + br.bits(DIST_EXTRA[dsym])? as usize;
                if d > out.len() {
                    return Err("distance too far back".into());
                }
                if out.len() + len > limit {
                    return Err("inflate output limit exceeded".into());
                }
                // Byte-by-byte copy: correct even when the match overlaps the
                // output being written (the classic 32 KiB sliding-window case).
                let start = out.len() - d;
                for k in 0..len {
                    let b = out[start + k];
                    out.push(b);
                }
            }
        }
    }
}

/// Raw DEFLATE (RFC 1951) inflate into a fresh `Vec<u8>`.
fn inflate(src: &[u8], limit: usize) -> Result<Vec<u8>, String> {
    let mut br = BitReader::new(src);
    let mut out: Vec<u8> = Vec::new();
    let (flit, fdist) = fixed_tables();

    loop {
        let last = br.bits(1)?;
        let btype = br.bits(2)?;
        match btype {
            0 => {
                // Stored blocks are byte-aligned: the leftover bits of the
                // current byte must be discarded *before* reading LEN/NLEN,
                // which are two little-endian byte-aligned u16s.
                br.align();
                let len = br.bits(16)? as usize;
                let nlen = br.bits(16)? as usize;
                if len != (!nlen & 0xffff) {
                    return Err("stored block length check failed".into());
                }
                if out.len() + len > limit {
                    return Err("inflate output limit exceeded".into());
                }
                let bytes = br.read_bytes(len)?;
                out.extend_from_slice(&bytes);
            }
            1 => inflate_block(&mut br, &flit, &fdist, &mut out, limit)?,
            2 => {
                let (lit, dist) = dynamic_tables(&mut br)?;
                inflate_block(&mut br, &lit, &dist, &mut out, limit)?;
            }
            _ => return Err("invalid deflate block type".into()),
        }
        if last == 1 {
            break;
        }
    }
    Ok(out)
}

/// CRC-32/ISO-HDLC, used to prove the inflater produced exactly the right
/// bytes (a wrong-but-plausible inflate would still pass a size check).
fn crc32(data: &[u8]) -> u32 {
    let mut c: u32 = 0xffff_ffff;
    for &b in data {
        c ^= b as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 {
                (c >> 1) ^ 0xedb8_8320
            } else {
                c >> 1
            };
        }
    }
    c ^ 0xffff_ffff
}
