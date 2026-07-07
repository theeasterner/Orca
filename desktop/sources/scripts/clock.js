'use strict'

/* global Blob */

function Clock (client) {
  // One-shot timer: worker fires a single postMessage after e.data ms, then
  // waits to be re-armed. This lets each tick have its own duration, which
  // straight timing (setInterval) can't do, but swing needs.
  const workerScript = 'onmessage = (e) => { setTimeout(() => { postMessage(true) }, e.data) }'
  const worker = window.URL.createObjectURL(new Blob([workerScript], { type: 'text/javascript' }))

  this.isPaused = true
  this.timer = null
  this.isPuppet = false

  this.speed = { value: 120, target: 120 }
  this.swing = { value: 50 } // 50 = straight, 1-99 range, persists independent of grid resets

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
    this.swing.value = clamp(value, 1, 99)
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
        pulse.count = 5 // by MIDI standard next pulse is the beat
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
    } else {
      if (msg === true || client.io.midi.isClock) { client.io.midi.sendClockStop() }
      this.clearTimer()
    }
    client.io.midi.allNotesOff()
    client.io.midi.silence()
  }

  // External Clock

  const pulse = {
    count: 0,
    last: null,
    timer: null,
    frame: 0 // paused frame counter
  }

  this.tap = function () {
    pulse.count = (pulse.count + 1) % 6
    pulse.last = performance.now()
    if (!this.isPuppet) {
      console.log('Clock', 'Puppeteering starts..')
      this.isPuppet = true
      this.clearTimer()
      pulse.timer = setInterval(() => {
        if (performance.now() - pulse.last < 2000) { return }
        this.untap()
      }, 2000)
    }
    if (pulse.count == 0) {
      if (this.isPaused) { pulse.frame++ } else {
        if (pulse.frame > 0) {
          this.setFrame(client.orca.f + pulse.frame)
          pulse.frame = 0
        }
        client.run()
      }
    }
  }

  this.untap = function () {
    console.log('Clock', 'Puppeteering stops..')
    clearInterval(pulse.timer)
    this.isPuppet = false
    pulse.frame = 0
    pulse.last = null
    if (!this.isPaused) {
      this.setTimer(this.speed.value)
    }
  }

  // Timer

  // Duration, in ms, of one straight 16th note at the given bpm.
  this.frameLength = function (bpm) {
    return (60000 / parseInt(bpm)) / 4
  }

  // Computes the delay for the *next* tick, based on the frame that is
  // about to run (client.orca.f + 1), so that swing can give alternating
  // frames different durations while keeping the average tempo constant.
  //
  // Convention: odd frames (1, 3, 5...) sit on the fixed reference grid,
  // spaced exactly 2x a straight 16th apart. Even frames (0, 2, 4...) are
  // the ones swing pushes later, landing between the two flanking odd
  // frames at `swing`% of the way across. At swing=50 this is exactly
  // halfway, i.e. identical to straight timing.
  this.nextDelay = function () {
    const pair = this.frameLength(this.speed.value) * 2
    const ratio = this.swing.value / 100
    const upcoming = client.orca.f + 1
    return upcoming % 2 !== 0 ? pair * (1 - ratio) : pair * ratio
  }

  this.setTimer = function (bpm) {
    if (bpm < 60) { console.warn('Clock', 'Error ' + bpm); return }
    this.clearTimer()
    window.localStorage.setItem('bpm', bpm)
    this.timer = new Worker(worker)
    this.timer.onmessage = (event) => {
      client.io.midi.sendClock()
      client.run()
      this.timer.postMessage(this.nextDelay())
    }
    this.timer.postMessage(this.nextDelay())
  }

  this.clearTimer = function () {
    if (this.timer) {
      this.timer.terminate()
    }
    this.timer = null
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
