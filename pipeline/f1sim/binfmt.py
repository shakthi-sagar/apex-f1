"""SimBin: a tiny typed-array container (think "GLB for race data").

Layout (little endian):
    magic   4 bytes  b"F1SB"
    version u32      1
    hlen    u32      byte length of the JSON header (padded to 8)
    header  JSON     {"meta": {...}, "arrays": {name: {dtype, shape, offset, length}}}
    body    bytes    arrays, each 8-byte aligned, offsets relative to body start

The browser maps each array with a zero-copy TypedArray view.
Files are gzip-compressed and uploaded with Content-Encoding: gzip.
"""

from __future__ import annotations

import gzip
import json
import struct
from typing import Any

import numpy as np

MAGIC = b"F1SB"
VERSION = 1
_DTYPES = {
    np.dtype("float32"): "f32",
    np.dtype("float64"): "f64",
    np.dtype("int8"): "i8",
    np.dtype("uint8"): "u8",
    np.dtype("int16"): "i16",
    np.dtype("uint16"): "u16",
    np.dtype("int32"): "i32",
    np.dtype("uint32"): "u32",
}


def _pad8(n: int) -> int:
    return (n + 7) & ~7


def pack(arrays: dict[str, np.ndarray], meta: dict[str, Any] | None = None) -> bytes:
    index: dict[str, Any] = {}
    chunks: list[bytes] = []
    offset = 0
    for name, arr in arrays.items():
        arr = np.ascontiguousarray(arr)
        dt = arr.dtype.newbyteorder("<") if arr.dtype.byteorder == ">" else arr.dtype
        if np.dtype(dt) not in _DTYPES:
            raise TypeError(f"unsupported dtype {arr.dtype} for {name}")
        raw = arr.astype(dt, copy=False).tobytes()
        index[name] = {
            "dtype": _DTYPES[np.dtype(dt)],
            "shape": list(arr.shape),
            "offset": offset,
            "length": int(arr.size),
        }
        chunks.append(raw + b"\0" * (_pad8(len(raw)) - len(raw)))
        offset += _pad8(len(raw))
    header = json.dumps({"meta": meta or {}, "arrays": index}, separators=(",", ":")).encode()
    header += b" " * (_pad8(len(header)) - len(header))
    return MAGIC + struct.pack("<II", VERSION, len(header)) + header + b"".join(chunks)


def unpack(buf: bytes) -> tuple[dict[str, Any], dict[str, np.ndarray]]:
    if buf[:2] == b"\x1f\x8b":
        buf = gzip.decompress(buf)
    assert buf[:4] == MAGIC, "not a SimBin file"
    _, hlen = struct.unpack_from("<II", buf, 4)
    header = json.loads(buf[12 : 12 + hlen])
    body = 12 + hlen
    rev = {v: k for k, v in _DTYPES.items()}
    out = {}
    for name, a in header["arrays"].items():
        dt = rev[a["dtype"]]
        out[name] = np.frombuffer(buf, dtype=dt, count=a["length"], offset=body + a["offset"]).reshape(a["shape"])
    return header["meta"], out


def gz(data: bytes) -> bytes:
    return gzip.compress(data, compresslevel=9, mtime=0)  # mtime=0 -> deterministic output


def gz_json(obj: Any) -> bytes:
    return gz(json.dumps(obj, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode())
