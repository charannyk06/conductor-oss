#[cfg(unix)]
use anyhow::{anyhow, Result};
#[cfg(unix)]
use tokio::io::AsyncWriteExt;

const DETACHED_STREAM_FRAME_HEADER_BYTES: usize = 13;
const DETACHED_STREAM_FRAME_MAX_BYTES: usize = 64 * 1024 * 1024;

#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub(super) enum DetachedPtyStreamFrameKind {
    Data = 1,
    Exit = 2,
    Error = 3,
}

#[cfg(unix)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct DetachedPtyStreamFrame {
    pub(super) kind: DetachedPtyStreamFrameKind,
    pub(super) offset: u64,
    pub(super) payload: Vec<u8>,
}

#[cfg(unix)]
pub(super) struct DetachedPtyStreamFrameDecoder {
    header: [u8; DETACHED_STREAM_FRAME_HEADER_BYTES],
    header_offset: usize,
    frame_kind: Option<DetachedPtyStreamFrameKind>,
    frame_offset: u64,
    payload: Option<Vec<u8>>,
    payload_offset: usize,
}

#[cfg(unix)]
impl Default for DetachedPtyStreamFrameDecoder {
    fn default() -> Self {
        Self {
            header: [0; DETACHED_STREAM_FRAME_HEADER_BYTES],
            header_offset: 0,
            frame_kind: None,
            frame_offset: 0,
            payload: None,
            payload_offset: 0,
        }
    }
}

#[cfg(unix)]
impl DetachedPtyStreamFrameDecoder {
    pub(super) fn push(&mut self, chunk: &[u8]) -> Result<Vec<DetachedPtyStreamFrame>> {
        let mut frames = Vec::new();
        let mut offset = 0;
        while offset < chunk.len() {
            if self.payload.is_none() {
                let needed = DETACHED_STREAM_FRAME_HEADER_BYTES - self.header_offset;
                let available = chunk.len() - offset;
                let to_copy = needed.min(available);
                self.header[self.header_offset..self.header_offset + to_copy]
                    .copy_from_slice(&chunk[offset..offset + to_copy]);
                self.header_offset += to_copy;
                offset += to_copy;

                if self.header_offset < DETACHED_STREAM_FRAME_HEADER_BYTES {
                    continue;
                }

                let frame_kind = decode_detached_stream_frame_kind(self.header[0])?;
                let frame_offset = u64::from_be_bytes(self.header[1..9].try_into().unwrap());
                let payload_len =
                    u32::from_be_bytes(self.header[9..13].try_into().unwrap()) as usize;
                if payload_len > DETACHED_STREAM_FRAME_MAX_BYTES {
                    return Err(anyhow!(
                        "Detached PTY stream frame too large: {payload_len} bytes"
                    ));
                }

                self.frame_kind = Some(frame_kind);
                self.frame_offset = frame_offset;
                self.header_offset = 0;
                if payload_len == 0 {
                    frames.push(DetachedPtyStreamFrame {
                        kind: frame_kind,
                        offset: frame_offset,
                        payload: Vec::new(),
                    });
                    self.frame_kind = None;
                } else {
                    self.payload = Some(vec![0; payload_len]);
                    self.payload_offset = 0;
                }
            } else {
                let payload = self.payload.as_mut().expect("payload should exist");
                let needed = payload.len() - self.payload_offset;
                let available = chunk.len() - offset;
                let to_copy = needed.min(available);
                payload[self.payload_offset..self.payload_offset + to_copy]
                    .copy_from_slice(&chunk[offset..offset + to_copy]);
                self.payload_offset += to_copy;
                offset += to_copy;

                if self.payload_offset < payload.len() {
                    continue;
                }

                frames.push(DetachedPtyStreamFrame {
                    kind: self.frame_kind.take().expect("frame kind should exist"),
                    offset: self.frame_offset,
                    payload: self.payload.take().expect("payload should exist"),
                });
                self.payload_offset = 0;
            }
        }

        Ok(frames)
    }
}

#[cfg(unix)]
pub(super) async fn write_detached_stream_frame<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    kind: DetachedPtyStreamFrameKind,
    offset: u64,
    payload: &[u8],
) -> Result<()> {
    if payload.len() > u32::MAX as usize {
        return Err(anyhow!(
            "Detached PTY stream payload is too large: {} bytes",
            payload.len()
        ));
    }
    writer.write_all(&[kind as u8]).await?;
    writer.write_all(&offset.to_be_bytes()).await?;
    writer
        .write_all(&(payload.len() as u32).to_be_bytes())
        .await?;
    if !payload.is_empty() {
        writer.write_all(payload).await?;
    }
    Ok(())
}

#[cfg(unix)]
pub(super) fn decode_detached_stream_frame_kind(value: u8) -> Result<DetachedPtyStreamFrameKind> {
    match value {
        1 => Ok(DetachedPtyStreamFrameKind::Data),
        2 => Ok(DetachedPtyStreamFrameKind::Exit),
        3 => Ok(DetachedPtyStreamFrameKind::Error),
        _ => Err(anyhow!(
            "Unsupported detached PTY stream frame kind: {value}"
        )),
    }
}

#[cfg(unix)]
pub(super) fn decode_detached_exit_payload(payload: &[u8]) -> Result<i32> {
    if payload.len() != std::mem::size_of::<i32>() {
        return Err(anyhow!(
            "Detached PTY exit payload had invalid length: {}",
            payload.len()
        ));
    }
    Ok(i32::from_be_bytes(payload.try_into().unwrap()))
}
