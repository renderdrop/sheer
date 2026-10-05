//! A file the engine child reads through its parent (ADR-053 §1.5). The child never opens a path: PDFium reads a [`RemoteFile`],
//! which asks the parent for ranges of the handle that passed intake (`ReadAt`, answered by `FileTable::read_at` on the parent's
//! reader thread) and keeps the blocks it got in a small cache, so that PDFium's many short reads cost few round trips.
//!
//! The source of the bytes is a trait so that the unit tests need no process: they read a real file through it. This module opens
//! no file itself.

use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Seek, SeekFrom};
use std::sync::Arc;

use super::files::FileToken;
use crate::limits;

/// Where a [`RemoteFile`] gets its bytes: the parent, over the pipe.
pub trait ReadSource: Send + Sync {
    /// Up to `len` bytes of file `token` at `offset` (`len` is at most `limits::READ_AT_MAX`), fewer at the end of the file.
    fn read_at(&self, token: FileToken, offset: u64, len: u32) -> io::Result<Vec<u8>>;

    /// The length of the file.
    fn len(&self, token: FileToken) -> io::Result<u64>;
}

const BLOCK: u64 = limits::REMOTE_BLOCK_BYTES as u64;
// A block is one `ReadAt`: it must fit the cap of one.
const _: () = assert!(limits::REMOTE_BLOCK_BYTES <= limits::READ_AT_MAX);

/// `Read + Seek` over a file the parent holds. Holds at most [`limits::REMOTE_BLOCKS`] blocks of [`limits::REMOTE_BLOCK_BYTES`].
pub struct RemoteFile {
    source: Arc<dyn ReadSource>,
    token: FileToken,
    len: u64,
    position: u64,
    blocks: HashMap<u64, Vec<u8>>,
    /// Block numbers, oldest first: the next one to go.
    order: VecDeque<u64>,
}

impl RemoteFile {
    /// Asks the source for the length of the file; that is the one round trip of opening.
    pub fn open(source: Arc<dyn ReadSource>, token: FileToken) -> io::Result<Self> {
        let len = source.len(token)?;
        Ok(Self {
            source,
            token,
            len,
            position: 0,
            blocks: HashMap::new(),
            order: VecDeque::new(),
        })
    }

    /// How many blocks are cached.
    pub fn cached_blocks(&self) -> usize {
        self.blocks.len()
    }

    fn block(&mut self, number: u64) -> io::Result<&[u8]> {
        if !self.blocks.contains_key(&number) {
            let offset = number
                .checked_mul(BLOCK)
                .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
            let len =
                u32::try_from(BLOCK).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
            let mut bytes = self.source.read_at(self.token, offset, len)?;
            // The parent is trusted more than the child, but a short or long answer is still only data: never more than asked.
            bytes.truncate(limits::REMOTE_BLOCK_BYTES);
            while self.blocks.len() >= limits::REMOTE_BLOCKS {
                match self.order.pop_front() {
                    Some(oldest) => {
                        self.blocks.remove(&oldest);
                    }
                    None => break,
                }
            }
            self.order.push_back(number);
            self.blocks.insert(number, bytes);
        }
        self.blocks
            .get(&number)
            .map(Vec::as_slice)
            .ok_or_else(|| io::Error::from(io::ErrorKind::Other))
    }
}

impl Read for RemoteFile {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        // The buffer is filled across block borders: PDFium's file callback (pdfium-render) calls `read` once and takes a short
        // count for the whole block, so a read that ends at a border would leave the rest of its buffer unread (a JPEG that is
        // grey from there on). Short only at the end of the file.
        let mut filled = 0;
        while filled < buffer.len() && self.position < self.len {
            let number = self.position / BLOCK;
            let within = usize::try_from(self.position % BLOCK)
                .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
            let block = match self.block(number) {
                Ok(block) => block,
                // What was copied is real: report it, and the failure comes again with the next read (nothing was cached for it).
                Err(_) if filled > 0 => break,
                Err(error) => return Err(error),
            };
            let Some(available) = block.get(within..).filter(|rest| !rest.is_empty()) else {
                // The file ended earlier than its length said (it shrank): the end of the file.
                break;
            };
            let n = available.len().min(buffer.len() - filled);
            buffer[filled..filled + n].copy_from_slice(&available[..n]);
            filled += n;
            self.position += n as u64;
        }
        Ok(filled)
    }
}

impl Seek for RemoteFile {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let target = match to {
            SeekFrom::Start(offset) => Some(offset),
            SeekFrom::End(delta) => self.len.checked_add_signed(delta),
            SeekFrom::Current(delta) => self.position.checked_add_signed(delta),
        };
        let target = target.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "seek before the start of the file",
            )
        })?;
        self.position = target;
        Ok(target)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    /// A file in memory that counts the reads it served.
    struct Memory {
        bytes: Vec<u8>,
        reads: AtomicUsize,
    }

    impl ReadSource for Memory {
        fn read_at(&self, _: FileToken, offset: u64, len: u32) -> io::Result<Vec<u8>> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            let start = usize::try_from(offset)
                .unwrap_or(usize::MAX)
                .min(self.bytes.len());
            let end = (start + len as usize).min(self.bytes.len());
            Ok(self.bytes[start..end].to_vec())
        }

        fn len(&self, _: FileToken) -> io::Result<u64> {
            Ok(self.bytes.len() as u64)
        }
    }

    fn token() -> FileToken {
        serde_json::from_value(serde_json::json!(1)).unwrap()
    }

    fn remote(size: usize) -> (RemoteFile, Arc<Memory>) {
        let bytes: Vec<u8> = (0..size).map(|n| (n % 251) as u8).collect();
        let source = Arc::new(Memory {
            bytes,
            reads: AtomicUsize::new(0),
        });
        let file = RemoteFile::open(Arc::clone(&source) as Arc<dyn ReadSource>, token()).unwrap();
        (file, source)
    }

    #[test]
    fn reads_the_whole_file_across_blocks() {
        let size = limits::REMOTE_BLOCK_BYTES * 2 + 1000;
        let (mut file, source) = remote(size);
        let mut all = Vec::new();
        file.read_to_end(&mut all).unwrap();
        assert_eq!(all, source.bytes);
        assert_eq!(source.reads.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn short_reads_in_one_block_cost_one_round_trip() {
        let (mut file, source) = remote(5000);
        let mut small = [0u8; 10];
        for _ in 0..50 {
            file.read_exact(&mut small).unwrap();
        }
        file.seek(SeekFrom::Start(0)).unwrap();
        file.read_exact(&mut small).unwrap();
        assert_eq!(source.reads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn seeks_from_every_origin_and_refuses_before_the_start() {
        let (mut file, _) = remote(1000);
        assert_eq!(file.seek(SeekFrom::End(-10)).unwrap(), 990);
        assert_eq!(file.seek(SeekFrom::Current(5)).unwrap(), 995);
        let mut rest = Vec::new();
        file.read_to_end(&mut rest).unwrap();
        assert_eq!(rest.len(), 5);
        assert!(file.seek(SeekFrom::Current(-2000)).is_err());
        assert_eq!(file.seek(SeekFrom::Start(5000)).unwrap(), 5000);
        assert_eq!(file.read(&mut [0u8; 4]).unwrap(), 0);
    }

    #[test]
    fn one_read_across_a_block_border_is_not_short() {
        let (mut file, source) = remote(limits::REMOTE_BLOCK_BYTES * 3);
        let start = limits::REMOTE_BLOCK_BYTES - 10;
        file.seek(SeekFrom::Start(start as u64)).unwrap();
        // A single `read`, like PDFium's file callback: it must return everything asked for.
        let mut buffer = vec![0u8; limits::REMOTE_BLOCK_BYTES + 100];
        assert_eq!(file.read(&mut buffer).unwrap(), buffer.len());
        assert_eq!(buffer, source.bytes[start..start + buffer.len()]);
    }

    /// Serves the first block and fails every other read.
    struct Flaky(Memory);

    impl ReadSource for Flaky {
        fn read_at(&self, token: FileToken, offset: u64, len: u32) -> io::Result<Vec<u8>> {
            if offset == 0 {
                self.0.read_at(token, offset, len)
            } else {
                Err(io::Error::from(io::ErrorKind::BrokenPipe))
            }
        }

        fn len(&self, token: FileToken) -> io::Result<u64> {
            self.0.len(token)
        }
    }

    #[test]
    fn a_read_that_fails_after_a_partial_copy_returns_what_it_copied() {
        let size = limits::REMOTE_BLOCK_BYTES * 2;
        let bytes: Vec<u8> = (0..size).map(|n| (n % 251) as u8).collect();
        let source = Arc::new(Flaky(Memory {
            bytes: bytes.clone(),
            reads: AtomicUsize::new(0),
        }));
        let mut file = RemoteFile::open(source, token()).unwrap();
        file.seek(SeekFrom::Start((limits::REMOTE_BLOCK_BYTES - 10) as u64))
            .unwrap();
        let mut buffer = [0u8; 100];
        assert_eq!(file.read(&mut buffer).unwrap(), 10);
        assert_eq!(
            buffer[..10],
            bytes[limits::REMOTE_BLOCK_BYTES - 10..limits::REMOTE_BLOCK_BYTES]
        );
        // The next read, which starts at the failing block, is the error.
        assert!(file.read(&mut buffer).is_err());
    }

    #[test]
    fn the_cache_is_bounded() {
        let size = limits::REMOTE_BLOCK_BYTES * (limits::REMOTE_BLOCKS + 8);
        let (mut file, _) = remote(size);
        let mut byte = [0u8; 1];
        for block in 0..(limits::REMOTE_BLOCKS + 8) {
            file.seek(SeekFrom::Start((block * limits::REMOTE_BLOCK_BYTES) as u64))
                .unwrap();
            file.read_exact(&mut byte).unwrap();
        }
        assert_eq!(file.cached_blocks(), limits::REMOTE_BLOCKS);
    }
}
