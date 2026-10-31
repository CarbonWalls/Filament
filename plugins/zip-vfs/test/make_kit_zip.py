#!/usr/bin/env python3
"""Create the zip-vfs test fixture at /root/filament/demo/kit.zip.

The fixture deliberately covers every branch of the plugin's zip reader:

  * deflated (method 8) files, including a large, highly repetitive file that
    forces dynamic-Huffman blocks with long back-references (sliding window),
  * a stored (method 0) file, served verbatim with no inflation,
  * an explicit directory entry ("assets/") *and* an implied one ("src/util/"
    exists both as a dir entry and as the parent of files) so the plugin's
    de-duplication is observable,
  * two hostile entries ("../evil.txt", "/abs.txt") that must never be listed
    or readable.
"""
import os
import random
import zipfile

OUT = os.environ.get("KIT_ZIP", "/root/filament/demo/kit.zip")
os.makedirs(os.path.dirname(OUT), exist_ok=True)

random.seed(1337)

REPETITIVE = ("the quick brown fox jumps over the lazy dog " * 4600).encode()  # ~200 KB
PSEUDO_RANDOM = bytes(random.randrange(32, 127) for _ in range(64 * 1024))
BLOB = bytes(random.randrange(256) for _ in range(8 * 1024))
# 200 KB of incompressible data: zlib emits multiple *stored* blocks, each
# preceded by a byte-alignment boundary — the classic place for an off-by-a-few
# -bits inflater bug.
BIG_RANDOM = bytes(random.randrange(256) for _ in range(200 * 1024))
# Compressible prefix + incompressible tail: usually a dynamic block followed by
# stored blocks in the same deflate stream.
MIXED = (b"filament" * 6000) + bytes(random.randrange(256) for _ in range(40 * 1024))
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000002000000020806000000f478"
    "d41f0000001649444154789c6360f8cfc0f01f84199861004600a1d2038b1e"
    "58d3a20000000049454e44ae426082"
)

FILES = {
    "readme.md": b"# kit\n\nA nested archive used by the zip-vfs plugin tests.\n",
    "src/main.rs": b"mod lib;\nfn main() { println!(\"hi\"); }\n",
    "src/lib.rs": b"pub mod util;\npub const VERSION: &str = \"1.0\";\n",
    "src/util/mod.rs": b"pub mod helper;\n",
    "src/util/helper.rs": b"pub fn help() -> &'static str { \"help\" }\n",
    "assets/logo.txt": b"FILAMENT\n",
    "assets/img/dot.png": PNG,
    "data/repetitive.txt": REPETITIVE,
    "data/pseudorandom.txt": PSEUDO_RANDOM,
    "data/blob.bin": BLOB,
    "data/bigrandom.bin": BIG_RANDOM,
    "data/mixed.bin": MIXED,
    "data/empty.txt": b"",
}


def main() -> None:
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        # Explicit directory entries (the source of the de-duplication test).
        z.writestr("assets/", b"")
        z.writestr("src/util/", b"")
        for name, data in FILES.items():
            z.writestr(name, data)
        # Method 0: stored, no compression.
        z.writestr("data/stored.bin", BLOB, compress_type=zipfile.ZIP_STORED)
        # Hostile names that a naive implementation would happily serve.
        z.writestr("../evil.txt", b"you should never see this\n")
        z.writestr("/abs.txt", b"nor this\n")

    with zipfile.ZipFile(OUT) as z:
        bad = z.testzip()
        assert bad is None, f"corrupt fixture entry: {bad}"
    print(f"wrote {OUT} ({os.path.getsize(OUT)} bytes, {len(FILES) + 5} entries)")

    make_encrypted_flag_zip(os.path.join(os.path.dirname(OUT), "kit-encrypted.zip"))




def make_encrypted_flag_zip(path: str) -> None:
    """A tiny zip whose single entry has the encryption bit set.

    Real encrypted archives cannot be produced by the stdlib, so we set the
    general-purpose flag bit 0 (encryption) in both the local and the central
    header. The plugin must refuse it with a clear message rather than
    inflating ciphertext and reporting a crc32 mismatch.
    """
    import struct

    buf = bytearray()
    name = b"secret.txt"
    payload = b"not really encrypted\n"
    import binascii

    crc = binascii.crc32(payload) & 0xFFFFFFFF
    # local file header
    buf += struct.pack("<IHHHHHIIIHH", 0x04034B50, 20, 0x0001, 0, 0, 0, crc, len(payload), len(payload), len(name), 0)
    buf += name + payload
    body = buf[:]
    # central directory
    cd = struct.pack(
        "<IHHHHHHIIIHHHHHII",
        0x02014B50, 20, 20, 0x0001, 0, 0, 0, crc, len(payload), len(payload),
        len(name), 0, 0, 0, 0, 0, 0,
    ) + name
    end = struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, 1, 1, len(cd), len(body), 0)
    with open(path, "wb") as fh:
        fh.write(body + cd + end)
    print(f"wrote {path} ({os.path.getsize(path)} bytes, encryption flag set)")


if __name__ == "__main__":
    main()
