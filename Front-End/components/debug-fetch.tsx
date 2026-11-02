"use client"

import { useEffect, useState } from "react"

export function DebugFetch() {
  const [result, setResult] = useState("loading...")

  useEffect(() => {
    fetch("http://127.0.0.1:8000/api/v1/health")
      .then(res => res.json())
      .then(data => setResult("OK: " + JSON.stringify(data)))
      .catch(err => setResult("ERROR: " + err.message))
  }, [])

  return (
    <div style={{ position: "fixed", bottom: 10, left: 10, zIndex: 9999, background: "black", color: "white", padding: 10, fontSize: 12 }}>
      Debug: {result}
    </div>
  )
}
