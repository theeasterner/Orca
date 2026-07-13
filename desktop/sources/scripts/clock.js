'use strict'

/* global Blob */

function Clock (client) {
  // Free-running timer: the worker's own setInterval ticks independently of
  // the main thread, so main-thread work (client.run, drawing, messaging)
  // can never shift the underlying tempo. Swing is layered on top of this
  // fixed grid rather than baked into its period - see armTimer() below.
  const workerScript = 'onmessage = (e) => { setInterval(() => { postMessage(true) }, e.data)}'
  const worker = window.URL.createObjectURL(new Blob([workerScript], { type: 'text/javascript' }))

  this.isPaused = true
  this.timer = null
  this.isPuppet = false

  this.speed = { value: 120, target: 120 }
  this.swing = { value: 50 } // 50 = straight, 50-80 range, persists independent of grid resets

  this.start = function () {
    const memory = parseInt(window.localStorage.getItem('bpm'))
    const target = memory >= 60 ? memory : 120
    this.setSpeed(target, target, true)

    const swingMemory = parseInt(window.localStorage.getItem('swing'))
    this.setSwing(!isNaN(swingMemory) ? swingMemory : 50)

    this.play()
  }

  this.touch = function () {
    this.stop()
    client.run()
  }

  this.run = function () {
    if (this.speed.target === this.speed.value) { return }
    this.setSpeed(this.speed.value + (this.speed.value < this.speed.target ? 1 : -1), null, true)
  }

  this.setSpeed = (value, target = null, setTimer = false) => {
    if (this.speed.value === value && this.speed.target === target && this.timer) { return }
    if (value) { this.speed.value = clamp(value, 60, 300) }
    if (target) { this.speed.target = clamp(target, 60, 300) }
    if (setTimer === true) { this.setTimer(this.speed.value) }
  }

  this.modSpeed = function (mod = 0, animate = false) {
    if (animate === true) {
      this.setSpeed(null, this.speed.target + mod)
    } else {
      this.setSpeed(this.speed.value + mod, this.speed.value + mod, true)
      client.update()
    }
  }

  this.setSwing = function (value) {
    if (isNaN(value)) { return }
    this.swing.value = clamp(value, 50, 80)
    window.localStorage.setItem('swing', this.swing.value)
  }

  this.modSwing = function (mod = 0) {
    this.setSwing(this.swing.value + mod)
    client.update()
  }

  // Controls

  this.togglePlay = function (msg = false) {
    if (this.isPaused === true) {
      this.play(msg)
    } else {
      this.stop(msg)
    }
    client.update()
  }

  this.play = function (msg = false, midiStart = false) {
    console.log('Clock', 'Play', msg, midiStart)
    if (this.isPaused === false && !midiStart) { return }
    this.isPaused = false
    if (this.isPuppet === true) {
      console.warn('Clock', 'External Midi control')
      if (!pulse.frame || midiStart) { // no frames counted while paused (starting from no clock, unlikely) or triggered by MIDI clock START
        this.setFrame(0) // make sure frame aligns with pulse count for an accurate beat
        pulse.frame = 0
        pulse.count = 11 // by MIDI standard next pulse is the beat
      } else if (pulse.frame > 0) {
        this.setFrame(client.orca.f + pulse.frame)
        pulse.frame = 0
      }
    } else {
      if (msg === true) { client.io.midi.sendClockStart() }
      this.setSpeed(this.speed.target, this.speed.target, true)
    }
  }

  this.stop = function (msg = false) {
    console.log('Clock', 'Stop')
    if (this.isPaused === true) { return }
    this.isPaused = true
    if (this.isPuppet === true) {
      console.warn('Clock', 'External Midi control')
      clearTimeout(this.swingTimeout)
    } else {
      if (msg === true || client.io.midi.isClock) { client.io.midi.sendClockStop() }
      this.clearTimer()
    }
    client.io.midi.allNotesOff()
    client.io.midi.silence()
  }

  // External Clock

  const pulse = {
    count: 0,        // 0-11, position within the current 8th-note (12-pulse, 24ppqn) pair
    last: null,      // timestamp of the last received pulse, for the silence watchdog and interval measurement
    lastInterval: null, // ms between the two most recent real pulses, for the small fractional extrapolation below
    timer: null,     // silence watchdog interval
    frame: 0         // frames elapsed while paused, to catch up on resume
  }

  // Continuous position, in pulses, of the swung (off-beat) frame within
  // the 12-pulse 8th-note pair. 6.0 = straight (swing 50, the pair's exact
  // midpoint); rises toward the next anchor pulse (12) as swing increases.
  // Clamped 50-80 keeps this strictly between 6.0 and 9.6, so it always
  // falls between the two flanking anchor pulses.
  this.swingPulsePosition = function () {
    return (this.swing.value / 100) * 12
  }

  this.tap = function () {
    const now = performance.now()
    if (pulse.last !== null) {
      const delta = now - pulse.last
      if (delta > 0 && delta < 1000) { pulse.lastInterval = delta } // ignore absurd gaps (e.g. resuming after a long pause)
    }
    pulse.last = now
    pulse.count = (pulse.count + 1) % 12

    if (!this.isPuppet) {
      console.log('Clock', 'Puppeteering starts..')
      this.isPuppet = true
      this.clearTimer() // no separate timer runs in puppet mode - frames fire directly off real pulses below
      pulse.lastInterval = null
      pulse.timer = setInterval(() => {
        if (performance.now() - pulse.last < 2000) { return }
        this.untap()
      }, 2000)
    }

    // Anchor (8th note, every 12th real pulse) is always pulse-exact. The
    // swung (16th note) target position is a real number (e.g. 7.08) - we
    // wait for its floor pulse to really arrive (never extrapolating ahead
    // of real data), then extrapolate only the small remaining fraction
    // using the most recently measured real pulse interval. That look-ahead
    // is always well under one full pulse interval, and gets re-grounded by
    // the next real pulse regardless, so any estimation error is small and
    // bounded rather than accumulating.
    const isAnchor = pulse.count === 0
    const target = this.swingPulsePosition()
    const floorPulse = Math.floor(target)
    if (!isAnchor && pulse.count !== floorPulse) { return }

    if (this.isPaused) {
      pulse.frame++
      return
    }

    const fire = () => {
      if (pulse.frame > 0) {
        this.setFrame(client.orca.f + pulse.frame)
        pulse.frame = 0
      }
      client.run()
    }

    if (isAnchor) {
      fire()
      return
    }

    const fraction = target - floorPulse
    if (fraction <= 0) {
      fire()
    } else {
      const interval = pulse.lastInterval || (this.frameLength(this.speed.value) / 6)
      clearTimeout(this.swingTimeout)
      this.swingTimeout = setTimeout(fire, fraction * interval)
    }
  }

  this.untap = function () {
    console.log('Clock', 'Puppeteering stops..')
    clearInterval(pulse.timer)
    clearTimeout(this.swingTimeout)
    this.isPuppet = false
    pulse.frame = 0
    pulse.last = null
    pulse.lastInterval = null
    if (!this.isPaused) {
      this.setTimer(this.speed.value)
    }
  }

  // Timer

  // Duration, in ms, of one straight 16th note at the given bpm.
  this.frameLength = function (bpm) {
    return (60000 / parseInt(bpm)) / 4
  }

  // Computes how much *extra* time to wait, on top of the fixed straight
  // interval tick, before running a swung frame. Since swing is clamped to
  // 50-80, this is always >= 0 - a forward wait layered on top of a tick
  // that has already fired, never a request to preempt it. At swing=50
  // this is exactly 0 (identical to straight timing); at swing=80 it's
  // 0.6x a straight frame, safely under the 1.0x gap to the next interval
  // tick, so a swung frame always finishes well before the next one fires.
  this.swingExtraDelay = function () {
    const ratio = this.swing.value / 100
    return this.armedFrameLength * (2 * ratio - 1)
  }

  // Arms (or re-arms) the master (bpm-driven) timer. The worker's interval
  // always ticks at the fixed, straight frame length for the current bpm.
  // Each tick corresponds to one nominal frame slot on that fixed grid.
  // (Puppet mode doesn't use this at all - see tap() above, which fires
  // frames directly off real incoming pulses instead.)
  //
  // Convention: odd frames (1, 3, 5...) are anchors - they run immediately,
  // exactly on the free-running tick, so they're as drift-free as the
  // original unswung implementation. Even frames (0, 2, 4...) are swung -
  // their client.run() is pushed later within their own slot by
  // swingExtraDelay(), landing between the two flanking anchor ticks at
  // `swing`% of the way across. Because that extra wait is always well
  // under one full tick, it never overruns into the next interval tick,
  // so the underlying grid never needs to be preempted or rescheduled.
  this.armTimer = function () {
    this.clearTimer()
    this.armedFrameLength = this.frameLength(this.speed.value)
    this.timer = new Worker(worker)
    this.timer.onmessage = (event) => {
      const upcoming = client.orca.f + 1
      const fire = () => {
        client.io.midi.sendClock()
        client.run()
      }
      if (upcoming % 2 !== 0) {
        fire()
      } else {
        this.swingTimeout = setTimeout(fire, this.swingExtraDelay())
      }
    }
    this.timer.postMessage(this.armedFrameLength)
  }

  this.setTimer = function (bpm) {
    if (bpm < 60) { console.warn('Clock', 'Error ' + bpm); return }
    window.localStorage.setItem('bpm', bpm)
    this.armTimer()
  }

  this.clearTimer = function () {
    if (this.timer) {
      this.timer.terminate()
    }
    this.timer = null
    clearTimeout(this.swingTimeout)
    this.swingTimeout = null
  }

  this.setFrame = function (f) {
    if (isNaN(f)) { return }
    client.orca.f = clamp(f, 0, 9999999)
  }

  // UI

  this.swingToString = function () {
    return `${this.swing.value}`
  }

  this.toString = function () {
    const diff = this.speed.target - this.speed.value
    const _offset = Math.abs(diff) > 5 ? (diff > 0 ? `+${diff}` : diff) : ''
    const _message = this.isPuppet === true ? 'midi' : `${this.speed.value}${_offset}`
    const _beat = diff === 0 && client.orca.f % 4 === 0 ? '*' : ''
    return `${_message}${_beat}`
  }

  function clamp (v, min, max) { return v < min ? min : v > max ? max : v }
}
