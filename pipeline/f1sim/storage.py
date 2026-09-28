"""Artifact storage: local directory mirror + Cloudflare R2 (S3 API).

Keys are relative to the public prefix, e.g. "races/2024/21/manifest.json",
served at https://cdn.shadster.dev/f1-sim/<key>.
Credentials come from the environment (never from the repo):
  R2_ENDPOINT_URL, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, R2_BUCKET, R2_PREFIX
"""

from __future__ import annotations

import logging
import os

log = logging.getLogger(__name__)

IMMUTABLE = "public, max-age=31536000, immutable"
SHORT = "public, max-age=30, must-revalidate"


class Store:
    def __init__(self, local_root: str | None = None, upload: bool = True):
        self.local_root = local_root
        self.bucket = os.environ.get("R2_BUCKET", "mobbin-archive")
        self.prefix = os.environ.get("R2_PREFIX", "f1-sim").strip("/")
        self._s3 = None
        self.upload = upload and bool(os.environ.get("R2_ENDPOINT_URL")) and bool(os.environ.get("AWS_ACCESS_KEY_ID"))
        self.uploaded: list[tuple[str, int]] = []

    @property
    def s3(self):
        if self._s3 is None:
            import boto3
            from botocore.config import Config

            self._s3 = boto3.client("s3", endpoint_url=os.environ["R2_ENDPOINT_URL"],
                                    region_name=os.environ.get("AWS_DEFAULT_REGION", "auto"),
                                    config=Config(retries={"max_attempts": 6, "mode": "adaptive"}))
        return self._s3

    def _key(self, key: str) -> str:
        return f"{self.prefix}/{key}" if self.prefix else key

    def put(self, key: str, data: bytes, content_type: str, gzip: bool = False, cache: str = IMMUTABLE) -> None:
        if self.local_root:
            p = os.path.join(self.local_root, key)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "wb") as f:
                f.write(data)
        if self.upload:
            extra = {"ContentType": content_type, "CacheControl": cache}
            if gzip:
                extra["ContentEncoding"] = "gzip"
            self.s3.put_object(Bucket=self.bucket, Key=self._key(key), Body=data, **extra)
            self.uploaded.append((key, len(data)))
            log.info("uploaded %s (%.1f KB)", key, len(data) / 1024)

    def get(self, key: str) -> bytes | None:
        if self.local_root:
            p = os.path.join(self.local_root, key)
            if os.path.exists(p):
                with open(p, "rb") as f:
                    return f.read()
        if self.upload:
            try:
                return self.s3.get_object(Bucket=self.bucket, Key=self._key(key))["Body"].read()
            except self.s3.exceptions.NoSuchKey:
                return None
            except Exception as e:  # pragma: no cover
                if "NoSuchKey" in str(e) or "404" in str(e):
                    return None
                raise
        return None

    def exists(self, key: str) -> bool:
        if self.local_root and os.path.exists(os.path.join(self.local_root, key)):
            return True
        if self.upload:
            try:
                self.s3.head_object(Bucket=self.bucket, Key=self._key(key))
                return True
            except Exception:
                return False
        return False
