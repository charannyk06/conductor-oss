use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const IPC_TYPE_SPAWN: u8 = 1;
pub const IPC_TYPE_WRITE: u8 = 2;
pub const IPC_TYPE_RESIZE: u8 = 3;
pub const IPC_TYPE_KILL: u8 = 4;
pub const IPC_TYPE_DISPOSE: u8 = 5;
pub const IPC_TYPE_SIGNAL: u8 = 6;

pub const IPC_TYPE_READY: u8 = 101;
pub const IPC_TYPE_SPAWNED: u8 = 102;
pub const IPC_TYPE_DATA: u8 = 103;
pub const IPC_TYPE_EXIT: u8 = 104;
pub const IPC_TYPE_ERROR: u8 = 105;

#[derive(Serialize, Deserialize, Debug)]
pub struct SpawnPayload {
    pub shell: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub env: HashMap<String, String>,
}

pub async fn write_frame<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    frame_type: u8,
    payload: &[u8],
) -> std::io::Result<()> {
    let mut header = [0u8; 5];
    header[0] = frame_type;
    header[1..5].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    writer.write_all(&header).await?;
    if !payload.is_empty() {
        writer.write_all(payload).await?;
    }
    writer.flush().await?;
    Ok(())
}

pub async fn read_frame<R: AsyncReadExt + Unpin>(reader: &mut R) -> std::io::Result<(u8, Vec<u8>)> {
    let mut header = [0u8; 5];
    reader.read_exact(&mut header).await?;
    let frame_type = header[0];
    let mut len_bytes = [0u8; 4];
    len_bytes.copy_from_slice(&header[1..5]);
    let len = u32::from_le_bytes(len_bytes) as usize;

    // Hard limit: 4MB per frame. Terminal output should never approach this —
    // typical frames are a few KB. This protects against malformed length headers.
    if len > 4 * 1024 * 1024 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Frame size exceeds maximum limit ({len} bytes > 4MB)"),
        ));
    }

    let mut payload = vec![0u8; len];
    if len > 0 {
        reader.read_exact(&mut payload).await?;
    }
    Ok((frame_type, payload))
}
