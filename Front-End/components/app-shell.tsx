"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect } from "react"
import {
  Armchair,
  Camera,
  Cpu,
  History,
  LayoutDashboard,
  Radio,
  RefreshCw,
  Settings2,
  Volume2,
  VolumeX,
  WifiOff,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { SimulationBadge } from "@/components/monitoring/simulation-badge"
import { enableAlertAudio } from "@/lib/monitoring/alert-audio"
import { mockEnabled, useMonitoringStore } from "@/lib/monitoring/store"
import { api, seatFromBackend } from "@/lib/monitoring/api"

const navigation = [
  { href: "/", label: "Overview", shortLabel: "Home", icon: LayoutDashboard },
  { href: "/live", label: "Live monitoring", shortLabel: "Live", icon: Camera },
  { href: "/events", label: "Events", shortLabel: "Events", icon: History },
  { href: "/settings", label: "Settings", shortLabel: "Setup", icon: Settings2 },
  { href: "/system", label: "Model & system", shortLabel: "System", icon: Cpu },
]

const routeTitles: Record<string, string> = {
  "/": "Overview",
  "/live": "Live monitoring",
  "/events": "Events",
  "/settings": "Settings",
  "/system": "Model & system",
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const soundUnlocked = useMonitoringStore((state) => state.soundUnlocked)
  const soundBlocked = useMonitoringStore((state) => state.soundBlocked)
  const muted = useMonitoringStore((state) => state.muted)
  const setSoundUnlocked = useMonitoringStore((state) => state.setSoundUnlocked)
  const setSoundBlocked = useMonitoringStore((state) => state.setSoundBlocked)
  const toggleMuted = useMonitoringStore((state) => state.toggleMuted)
  const soundEnabled = useMonitoringStore((state) => state.settings.soundEnabled)
  const events = useMonitoringStore((state) => state.events)
  const pendingEventCount = events.filter((event) => !event.acknowledged).length
  const connectionStatus = useMonitoringStore((state) => state.connection.status)
  const health = useMonitoringStore((state) => state.health)
  const title = routeTitles[pathname] ?? "Occupancy workspace"

  // Auto-connect to backend on mount (when not in mock mode)
  useEffect(() => {
    if (mockEnabled) return
    if (connectionStatus === "connected" || connectionStatus === "reconnecting") return

    const timer = setTimeout(() => {
      fetch("http://127.0.0.1:8000/api/v1/health")
        .then(res => res.json())
        .then(data => {
          const store = useMonitoringStore.getState()
          store.setConnection("connected")
          store.setHealth(data)
          // Fetch seats
          fetch("http://127.0.0.1:8000/api/v1/seats")
            .then(r => r.json())
            .then(seats => store.setSeats(seats.map(seatFromBackend)))
            .catch(() => {})
          // Start polling for updates
          setInterval(async () => {
            try {
              const s = await api.seats()
              store.setSeats(s.map(seatFromBackend))
              const h = await api.health()
              store.setHealth(h)
            } catch {
              // silently fail
            }
          }, 2000)
        })
        .catch(err => {
          const store = useMonitoringStore.getState()
          store.setConnection("offline", err.message)
        })
    }, 500)

    return () => {
      clearTimeout(timer)
    }
  }, [connectionStatus])

  const handleSoundAction = async () => {
    if (!soundUnlocked) {
      const enabled = await enableAlertAudio()
      setSoundUnlocked(enabled)
      setSoundBlocked(!enabled)
      return
    }

    toggleMuted()
  }

  const soundLabel = soundBlocked
    ? "Browser audio is blocked"
    : !soundUnlocked
      ? "Unlock browser audio"
      : !soundEnabled
        ? "Alert sounds are disabled in Settings"
        : muted
          ? "Unmute alert sound"
          : "Mute alert sound"
  const SoundIcon = soundUnlocked && soundEnabled && !muted ? Volume2 : VolumeX

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <Link href="/" className="brand-lockup" aria-label="Seatline overview">
          <span className="brand-mark" aria-hidden="true">
            <Armchair size={18} strokeWidth={1.75} />
          </span>
          <span>
            <span className="brand-name">Seatline</span>
            <span className="brand-caption">OCCUPANCY INTELLIGENCE</span>
          </span>
        </Link>

        <div className="site-switcher" role="group" aria-label="Preview site">
          <span className="site-switcher-copy">
            <span className="site-switcher-label">PREVIEW SITE</span>
            <span className="site-switcher-name">North Terminal · Level 2</span>
          </span>
        </div>

        <div className="nav-section-label">Workspace</div>
        <nav className="sidebar-nav" aria-label="Workspace">
          {navigation.map((item) => (
            <NavLink
              key={item.href}
              {...item}
              pathname={pathname}
              pendingCount={mockEnabled ? pendingEventCount : null}
            />
          ))}
        </nav>

        <div className="sidebar-spacer" />

        <section className="sidebar-health" aria-label="System connection summary">
          <div className="sidebar-health-heading">
            <span className="nav-section-label sidebar-section-label">SYSTEM STATUS</span>
            {mockEnabled && <SimulationBadge />}
          </div>
          <HealthSummaryRow icon={Camera} label="Camera feeds" value={connectionStatus === "connected" ? (health?.camera.state ?? "Live") : connectionStatus === "reconnecting" ? "Degraded" : "Offline"} />
          <HealthSummaryRow icon={Cpu} label="Inference" value={connectionStatus === "connected" ? (health?.model.state ?? "Live") : connectionStatus === "reconnecting" ? "Degraded" : "Offline"} />
          <HealthSummaryRow icon={Radio} label="Event stream" value={connectionStatus === "connected" ? "Live" : connectionStatus === "reconnecting" ? "Reconnecting" : "Offline"} />
          {!mockEnabled && connectionStatus !== "connected" && connectionStatus !== "reconnecting" && (
            <p className="simulated-footnote">Waiting for the occupancy backend at http://127.0.0.1:8000.</p>
          )}
        </section>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <div className="topbar-left">
            <div className="topbar-context">
              <span className="topbar-context-secondary">SITE</span>
              <strong>North Terminal</strong>
              <span className="topbar-separator" aria-hidden="true" />
              <span className="topbar-context-secondary">LEVEL 2</span>
            </div>
          </div>
          <div className="topbar-right">
            <ConnectionPill status={connectionStatus === "reconnecting" ? "reconnecting" : connectionStatus === "connected" ? "connected" : "offline"} />
            {mockEnabled && <SimulationBadge />}
            <span className="topbar-separator" aria-hidden="true" />
            <span className="topbar-time" aria-label={`Current page: ${title}`}>{title.toUpperCase()}</span>
            <div className="topbar-actions">
              <Button
                className="icon-action"
                size="icon"
                variant="ghost"
                type="button"
                disabled={soundUnlocked && !soundEnabled}
                aria-label={soundLabel}
                title={soundLabel}
                onClick={() => void handleSoundAction()}
              >
                <SoundIcon size={16} strokeWidth={1.75} data-icon="inline-start" aria-hidden="true" />
              </Button>
              <Link className="icon-action" href="/settings" aria-label="Open settings" title="Settings">
                <Settings2 size={16} strokeWidth={1.75} aria-hidden="true" />
              </Link>
            </div>
          </div>
        </header>

        <main className="page-container" id="main-content">
          {children}
        </main>
      </div>

      <nav className="mobile-nav" aria-label="Mobile workspace navigation">
        {navigation.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              className="mobile-nav-link"
              href={item.href}
              data-active={active}
              aria-current={active ? "page" : undefined}
            >
              <Icon size={17} strokeWidth={1.75} aria-hidden="true" />
              <span className="mobile-nav-label">{item.shortLabel}</span>
            </Link>
          )
        })}
      </nav>
    </div>
  )
}

function NavLink({
  href,
  label,
  icon: Icon,
  pathname,
  pendingCount,
}: (typeof navigation)[number] & { pathname: string; pendingCount: number | null }) {
  const active = href === "/" ? pathname === "/" : pathname.startsWith(href)
  return (
    <Link className="nav-link" href={href} data-active={active} aria-current={active ? "page" : undefined}>
      <span className="nav-link-icon" aria-hidden="true">
        <Icon size={16} strokeWidth={1.75} />
      </span>
      <span className="nav-link-label">{label}</span>
      {href === "/live" && mockEnabled && <span className="status-dot is-live" aria-label="Preview feed active" />}
      {href === "/events" && <span className="nav-link-meta">{pendingCount ?? "—"}</span>}
    </Link>
  )
}

type ConnectionStatus = "connected" | "reconnecting" | "offline"

function ConnectionPill({ status }: { status: ConnectionStatus }) {
  const statusContent = {
    connected: { label: "Connected", icon: Radio },
    reconnecting: { label: "Reconnecting", icon: RefreshCw },
    offline: { label: "Offline", icon: WifiOff },
  }[status]
  const Icon = statusContent.icon

  return (
    <div className="connection-pill" data-state={status} role="status">
      <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
      <span>{statusContent.label}</span>
    </div>
  )
}

function HealthSummaryRow({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon
  label: string
  value: string
}) {
  return (
    <div className="health-row">
      <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
      <span>{label}</span>
      <span className="health-row-value">{value}</span>
    </div>
  )
}