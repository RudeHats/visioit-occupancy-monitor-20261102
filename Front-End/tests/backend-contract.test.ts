import { execFileSync } from "node:child_process"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { wsMessageSchema } from "../lib/monitoring/ws"

describe("actual Python backend WebSocket contract", () => {
  it("accepts live backend hello, inference, metrics and state changes", () => {
    const root = path.resolve(process.cwd(), "..")
    const output = execFileSync(path.join(root, ".venv", "Scripts", "python.exe"), ["-c", `
import json,time
import app
rt=app.Runtime(app.Settings(),app.SimulatedBlobAdapter())
rt.upsert_seat('seat-1','Test',app.DEMO_POLY)
rt.load_model()
rt.camera.start(app.SourceSpec('synthetic'))
time.sleep(.2)
messages=[]
rt.hub.publish=lambda msg,key=None: messages.append(msg)
rt._tick(0,0,0)
messages.append({'type':'hello','ts':app._iso(),'data':{'contract_version':app.CONTRACT_VERSION,'backend_version':app.BACKEND_VERSION,'simulated':rt.simulated,'snapshot':{'seats':rt.seat_status(),'settings':app.dataclasses.asdict(rt.s),'health':rt.health()}}})
messages.append({'type':'metrics','ts':app._iso(),'data':rt.metrics()})
rt.camera.stop()
print(json.dumps(messages))
`], { cwd: root, encoding: "utf8", timeout: 15000 })
    const messages = JSON.parse(output) as { type: string }[]
    expect(messages.some((m) => m.type === "inference")).toBe(true)
    for (const message of messages) {
      const parsed = wsMessageSchema.safeParse(message)
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
    }
  })
})
