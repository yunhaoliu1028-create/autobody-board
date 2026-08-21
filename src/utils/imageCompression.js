const DEFAULT_OPTIONS = {
  maxBytes: 300 * 1024,
  maxDimension: 1920,
  minDimension: 960,
  qualities: [0.84, 0.78, 0.72, 0.66, 0.6],
}

function scaledSize(width, height, maxDimension) {
  if (width <= maxDimension && height <= maxDimension) return { width, height }
  if (width > height) {
    return { width: maxDimension, height: Math.round(height * maxDimension / width) }
  }
  return { width: Math.round(width * maxDimension / height), height: maxDimension }
}

function canvasBlob(canvas, quality) {
  return new Promise(resolve => {
    canvas.toBlob(blob => resolve(blob), 'image/jpeg', quality)
  })
}

async function compressDrawable(source, naturalWidth, naturalHeight, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  let dimension = opts.maxDimension
  let bestBlob = null

  while (dimension >= opts.minDimension) {
    const size = scaledSize(naturalWidth, naturalHeight, dimension)
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    canvas.getContext('2d').drawImage(source, 0, 0, size.width, size.height)

    for (const quality of opts.qualities) {
      const blob = await canvasBlob(canvas, quality)
      if (!blob) continue
      if (!bestBlob || blob.size < bestBlob.size) bestBlob = blob
      if (blob.size <= opts.maxBytes) return blob
    }

    dimension = Math.floor(dimension * 0.82)
  }

  return bestBlob
}

export function compressImageFile(file, options) {
  return new Promise(resolve => {
    if (!file?.type?.startsWith('image/')) return resolve(null)
    const img = new Image()
    const objUrl = URL.createObjectURL(file)
    img.onload = async () => {
      URL.revokeObjectURL(objUrl)
      const blob = await compressDrawable(img, img.width, img.height, options)
      resolve(blob || file)
    }
    img.onerror = () => {
      URL.revokeObjectURL(objUrl)
      resolve(file)
    }
    img.src = objUrl
  })
}

export function compressVideoFrame(video, options) {
  if (!video?.videoWidth || !video?.videoHeight) return Promise.resolve(null)
  return compressDrawable(video, video.videoWidth, video.videoHeight, options)
}
