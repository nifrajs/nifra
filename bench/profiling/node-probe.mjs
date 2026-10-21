import { Session } from "node:inspector/promises"
import { PerformanceObserver } from "node:perf_hooks"

// Loaded only into diagnostic children, never into the framework or normal benchmarks.
let active
const inspector = new Session()
const gc = { count: 0, durationMs: 0 }
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gc.count++
    gc.durationMs += entry.duration
  }
})

process.on("message", async (message) => {
  if (message?.type !== "profile") return
  try {
    if (message.action === "snapshot") {
      if (active) throw new Error("cannot snapshot during profiling")
      global.gc()
      await new Promise((resolve) => setImmediate(resolve))
      global.gc()
      process.send({
        type: "profile",
        id: message.id,
        result: { ...process.memoryUsage(), peakRss: process.resourceUsage().maxRSS * 1024 },
      })
      return
    }
    if (message.action === "start") {
      if (active) throw new Error("profiling window already active")
      global.gc()
      await new Promise((resolve) => setImmediate(resolve))
      gc.count = 0
      gc.durationMs = 0
      observer.observe({ entryTypes: ["gc"] })
      const mode = message.mode
      if (mode !== "metrics") inspector.connect()
      if (mode === "heap") {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 16384,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        })
      } else if (mode === "cpu") {
        await inspector.post("Profiler.enable")
        await inspector.post("Profiler.setSamplingInterval", { interval: 100 })
        await inspector.post("Profiler.start")
      }
      active = { mode, memory: process.memoryUsage(), cpu: process.cpuUsage() }
      process.send({ type: "profile", id: message.id, result: { started: true } })
      return
    }
    if (!active) throw new Error("no active profiling window")
    const cpu = process.cpuUsage(active.cpu)
    const memory = process.memoryUsage()
    await new Promise((resolve) => setImmediate(resolve))
    observer.disconnect()
    let profile
    if (active.mode === "cpu") profile = (await inspector.post("Profiler.stop")).profile
    if (active.mode === "heap")
      profile = (await inspector.post("HeapProfiler.stopSampling")).profile
    if (active.mode !== "metrics") inspector.disconnect()
    // This estimates retained JS heap only. It is deliberately outside the CPU window.
    global.gc()
    const afterGC = process.memoryUsage()
    const result = { cpu, memoryBefore: active.memory, memory, afterGC, gc: { ...gc }, profile }
    active = undefined
    process.send({ type: "profile", id: message.id, result })
  } catch (error) {
    process.send({ type: "profile", id: message.id, error: error.message })
  }
})
