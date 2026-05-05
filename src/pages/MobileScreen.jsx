import { useEffect, useMemo, useState } from 'react'

const PRESETS = {
  iphone: { label: 'iPhone', width: 390, height: 844 },
  large:  { label: 'Large',  width: 430, height: 932 },
}

export default function MobileScreen() {
  const [preset, setPreset] = useState('iphone')
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))
  const frame = PRESETS[preset]
  const targetPath = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('path') || '/'
  }, [])
  const frameWidth = frame.width + 20
  const frameHeight = frame.height + 20
  const scale = Math.min(
    1,
    (viewport.width - 32) / frameWidth,
    (viewport.height - 76) / frameHeight,
  )

  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return (
    <div className="h-screen overflow-hidden bg-slate-200 p-3 text-gray-900">
      <div className="mx-auto flex h-full w-fit flex-col items-center gap-2">
        <div className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 shadow-sm">
          {Object.entries(PRESETS).map(([key, value]) => (
            <button
              key={key}
              onClick={() => setPreset(key)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                preset === key ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-100'
              }`}
            >
              {value.label} {value.width}x{value.height}
            </button>
          ))}
        </div>

        <div style={{ width: frameWidth * scale, height: frameHeight * scale }}>
          <div
            className="overflow-hidden rounded-[2rem] border-[10px] border-zinc-950 bg-white shadow-2xl"
            style={{
              width: frameWidth,
              height: frameHeight,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
            }}
          >
            <iframe
              title="Mobile app preview"
              src={targetPath}
              className="block border-0"
              style={{ width: frame.width, height: frame.height }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
