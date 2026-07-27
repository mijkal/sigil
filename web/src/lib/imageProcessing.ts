// Downscale + re-encode an uploaded image to a small square before it ever leaves
// the browser, so stored blobs are tiny (fast sync, no memory/render cost) and
// consistent regardless of what the user picked. Cover-crops to a centered square.

export async function downscaleToSquare(
  file: Blob,
  size = 256,
  type: 'image/webp' | 'image/png' = 'image/webp',
  quality = 0.86,
): Promise<Blob> {
  const bitmap = await loadBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d unavailable');
  ctx.imageSmoothingQuality = 'high';
  // cover-crop: scale the shorter side to `size`, center the longer side.
  const s = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - s) / 2;
  const sy = (bitmap.height - s) / 2;
  ctx.drawImage(bitmap, sx, sy, s, s, 0, 0, size, size);
  if ('close' in bitmap && typeof (bitmap as ImageBitmap).close === 'function') {
    (bitmap as ImageBitmap).close();
  }
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, type, quality));
  if (!blob) throw new Error('encode failed');
  // Safari lacks WebP encode in some versions — fall back to PNG.
  if (type === 'image/webp' && blob.type !== 'image/webp') {
    return downscaleToSquare(file, size, 'image/png');
  }
  return blob;
}

async function loadBitmap(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file); } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('image decode failed'));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}
