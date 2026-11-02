import { test, expect } from "@playwright/test"

test("root layout connects, live RTSP frames render, and inference reaches the browser", async ({ page }) => {
  const messages = new Set<string>()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
    try { messages.add(JSON.parse(payload.toString()).type) } catch { /* non-JSON frame */ }
  }))
  await page.goto("/live")
  const image = page.locator('img[src*="/backend/api/v1/stream/"]').first()
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
  await expect(page.getByText("Backend is not connected", { exact: true })).toHaveCount(0)
  await expect.poll(() => messages.has("inference") && messages.has("metrics")).toBe(true)
  await page.reload()
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
  expect(errors).toEqual([])
})

test("a rejected saved camera configuration does not label the reachable backend offline", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("visioit.monitoring.settings.v2", JSON.stringify({
    source: "rtsp", sourceUrl: "rtsp://invalid.example/live", usbIndex: 0,
    vacancyDurationSeconds: 180, confidenceThreshold: .78, alertCooldownSeconds: 300,
    soundEnabled: false, soundVolume: 62,
  })))
  await page.route("**/backend/api/v1/sources/select", (route) => route.fulfill({ status: 422,
    contentType: "application/json", body: JSON.stringify({ error: { code: "SOURCE_INVALID", message: "Invalid test source" } }) }))
  await page.goto("/system")
  await expect(page.getByText("Backend connected", { exact: true })).toBeVisible()
  await expect(page.getByText("yolo26n", { exact: true })).toBeVisible()
})

test("connection recovers after health requests temporarily fail", async ({ page }) => {
  let unavailable = false
  await page.route("**/backend/api/v1/health", (route) => unavailable ? route.abort("connectionfailed") : route.continue())
  await page.goto("/system")
  await expect(page.getByText("Backend connected", { exact: true })).toBeVisible()
  unavailable = true
  await expect(page.getByText("Backend unreachable; retrying", { exact: true })).toBeVisible()
  unavailable = false
  await expect(page.getByText("Backend unreachable; retrying", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Backend connected", { exact: true })).toBeVisible()
})

test("RTSP settings save through the form and survive a full page reload", async ({ page }) => {
  const url = process.env.E2E_RTSP_URL ?? "rtsp://192.168.137.134:8554/"
  await page.goto("/settings")
  await expect(page.getByRole("button", { name: "Save settings", exact: true })).toBeVisible()
  await page.getByRole("combobox", { name: "Source type" }).click()
  await page.getByRole("option", { name: "RTSP stream", exact: true }).click()
  await page.getByLabel("RTSP address", { exact: true }).fill(url)
  await page.getByRole("button", { name: "Save settings", exact: true }).click()
  await expect(page.getByText("Settings saved. Camera connection status is shown in the preview.", { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByLabel("RTSP address", { exact: true })).toHaveValue(url)
  const image = page.getByAltText("Live preview from selected camera source")
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)
  await page.getByRole("link", { name: "Live monitoring", exact: true }).click()
  await expect(page.getByAltText("Live camera frame from the occupancy backend")).toBeVisible()
})
