// owned by package B
//! Dropped image files held for Create PDF from images (ADR-049 §3): opened once, judged as regular files, PNG or JPEG by their
//! magic bytes; at most `limits::MAX_IMAGE_BATCH` per batch, kept `limits::IMAGE_BATCH_TTL`. Package B fills this module in.
