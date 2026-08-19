export function playShutterSound() {
  const AudioContext = window.AudioContext || window.webkitAudioContext
  if (!AudioContext) return

  const ctx = new AudioContext()
  const now = ctx.currentTime

  const makeTick = (start, volume, frequency) => {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(frequency, start)

    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.003)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.025)

    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(start)
    osc.stop(start + 0.03)
  }

  makeTick(now, 0.025, 820)
  makeTick(now + 0.045, 0.014, 520)
  setTimeout(() => ctx.close(), 130)
}
