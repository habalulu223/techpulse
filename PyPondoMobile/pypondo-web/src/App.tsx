import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'
import { discoverServers, type DiscoveredServer } from './discovery'
import { isNativeScannerAvailable, scanQr } from './scanner'

type ServerInfo = {
  ok: boolean
  server_hostname?: string
  server_ip?: string
  server_port?: number
}

type ScannedEquipment = {
  equipment_id: number
  equipment_code: string
  equipment_name: string
  category?: string | null
  status?: string | null
}

type ScannerStatus = 'idle' | 'starting' | 'active' | 'error'

type BarcodeDetection = { rawValue?: string }
type BarcodeDetectorInstance = {
  detect: (source: CanvasImageSource) => Promise<BarcodeDetection[]>
}
type BarcodeDetectorConstructor = new (options?: { formats?: string[] }) => BarcodeDetectorInstance

declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorConstructor
  }
}

const SERVER_CONFIG_KEY = 'pypondo.mobile.config.v2'

function normalizeServerAddress(value: string) {
  const trimmed = value.trim()
  if (!trimmed) throw new Error('No system address was provided.')

  const hasScheme = /^https?:\/\//i.test(trimmed)
  const url = new URL(hasScheme ? trimmed : 'http://' + trimmed)
  if (!hasScheme && !url.port) url.port = '5000'
  url.pathname = ''
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function addressFromDiscoveredServer(server: DiscoveredServer) {
  if (/^https?:\/\//i.test(server.address)) return server.address
  const host = server.ip || server.address
  const formattedHost = host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host
  return 'http://' + formattedHost + ':' + server.port
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(url, { ...init, signal: init?.signal || controller.signal })
    const raw = await response.text()
    let data: Record<string, unknown> = {}
    try {
      data = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    } catch {
      throw new Error('The system returned an unreadable response.')
    }

    if (!response.ok) {
      throw new Error(typeof data.error === 'string' ? data.error : 'The system request failed.')
    }
    return data as T
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('The system is taking too long to respond. Try again.')
    }
    throw error
  } finally {
    window.clearTimeout(timeoutId)
  }
}

function App() {
  const [baseUrl, setBaseUrl] = useState('')
  const [systemStatus, setSystemStatus] = useState<'searching' | 'ready' | 'offline'>('searching')
  const [systemName, setSystemName] = useState('Finding the system')
  const [equipment, setEquipment] = useState<ScannedEquipment | null>(null)
  const [qrValue, setQrValue] = useState('')
  const [fullName, setFullName] = useState('')
  const [program, setProgram] = useState('')
  const [yearLevel, setYearLevel] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isSubmitted, setIsSubmitted] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'success' | 'error' | 'info'; message: string } | null>(null)
  const [manualCode, setManualCode] = useState('')
  const [manualEntryOpen, setManualEntryOpen] = useState(false)
  const [scannerOpen, setScannerOpen] = useState(false)
  const [scannerStatus, setScannerStatus] = useState<ScannerStatus>('idle')
  const [scannerMessage, setScannerMessage] = useState('Center the equipment QR code in the frame.')
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const scannerStreamRef = useRef<MediaStream | null>(null)
  const detectorRef = useRef<BarcodeDetectorInstance | null>(null)
  const scannerTimerRef = useRef<number | null>(null)
  const scannerActiveRef = useRef(false)
  const scannerBusyRef = useRef(false)
  const systemLookupRef = useRef<Promise<string | null> | null>(null)

  useEffect(() => {
    void findSystem()
    return () => stopWebScanner()
  }, [])

  async function trySystemAtAddress(address: string) {
    const candidate = normalizeServerAddress(address)
    const info = await readJson<ServerInfo>(candidate + '/api/server-info')
    if (!info.ok) throw new Error('This address is not a TechPulse system.')

    window.localStorage.setItem(SERVER_CONFIG_KEY, JSON.stringify({ serverAddress: candidate }))
    setBaseUrl(candidate)
    setSystemName(info.server_hostname || 'TechPulse system')
    setSystemStatus('ready')
    return candidate
  }

  async function findSystem(force = false): Promise<string | null> {
    if (baseUrl && !force) return baseUrl
    if (systemLookupRef.current) return systemLookupRef.current

    if (force) setBaseUrl('')
    setSystemStatus('searching')
    setSystemName('Finding the system')

    const lookup = (async () => {
      const candidates: string[] = []
      const origin = window.location.origin
      const isHttpOrigin = /^https?:\/\//i.test(origin)
      const isViteDevServer = window.location.port === '5173' || window.location.port === '4173'
      if (isHttpOrigin && !isViteDevServer && !isNativeScannerAvailable()) {
        try {
          return await trySystemAtAddress(origin)
        } catch {
          // This may be a static web host. Continue with local system discovery.
        }
      }

      try {
        const discovered = await discoverServers({
          includeGateway: true,
          includeSubnet: true,
          includeStored: true,
          subnetScanCount: 30,
        })
        discovered.forEach((server) => candidates.push(addressFromDiscoveredServer(server)))
      } catch {
        // A reachable system may still have been found by the direct origin check.
      }

      const checked = new Set<string>()
      for (const candidate of candidates) {
        try {
          const normalized = normalizeServerAddress(candidate)
          if (checked.has(normalized)) continue
          checked.add(normalized)
          return await trySystemAtAddress(normalized)
        } catch {
          // Continue through the discovered addresses until one responds.
        }
      }

      setSystemStatus('offline')
      setSystemName('System not found')
      return null
    })()

    systemLookupRef.current = lookup
    try {
      return await lookup
    } finally {
      systemLookupRef.current = null
    }
  }

  async function handleScannedQr(rawValue: string) {
    const value = rawValue.trim()
    if (!value) return

    setEquipment(null)
    setIsSubmitted(false)
    setQrValue(value)
    setFullName('')
    setProgram('')
    setYearLevel('')
    setNotice({ kind: 'info', message: 'Looking up the equipment…' })

    try {
      const system = await findSystem()
      if (!system) {
        throw new Error('Could not find the system. Make sure your phone is on the same network, then retry.')
      }

      const result = await readJson<{ ok: boolean; equipment: ScannedEquipment }>(
        system + '/api/equipment/scan?qr=' + encodeURIComponent(value),
      )
      setEquipment(result.equipment)
      setNotice({ kind: 'success', message: 'Equipment found. Enter your student details to save this scan.' })
      setManualCode('')
    } catch (error) {
      setNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Could not load this equipment QR code.',
      })
    }
  }

  async function startEquipmentScanner() {
    setNotice(null)
    if (isNativeScannerAvailable()) {
      setScannerStatus('starting')
      try {
        const value = await scanQr('Scan an equipment QR code')
        setScannerStatus('idle')
        if (value) await handleScannedQr(value)
      } catch (error) {
        setScannerStatus('error')
        setNotice({
          kind: 'error',
          message: error instanceof Error ? error.message : 'The camera could not read the QR code.',
        })
      }
      return
    }

    if (!navigator.mediaDevices?.getUserMedia || !window.BarcodeDetector) {
      setManualEntryOpen(true)
      setNotice({ kind: 'error', message: 'Camera scanning is unavailable here. Enter the code from the equipment QR label below.' })
      return
    }
    setScannerStatus('starting')
    setScannerMessage('Opening your camera…')
    setScannerOpen(true)
  }

  function stopWebScanner() {
    scannerActiveRef.current = false
    scannerBusyRef.current = false
    if (scannerTimerRef.current !== null) {
      window.clearTimeout(scannerTimerRef.current)
      scannerTimerRef.current = null
    }
    if (scannerStreamRef.current) {
      scannerStreamRef.current.getTracks().forEach((track) => track.stop())
      scannerStreamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.pause()
      videoRef.current.srcObject = null
    }
  }

  function closeScanner() {
    stopWebScanner()
    setScannerOpen(false)
    setScannerStatus('idle')
  }

  function scheduleVideoScan() {
    if (!scannerActiveRef.current) return
    scannerTimerRef.current = window.setTimeout(() => {
      void detectVideoFrame()
    }, 250)
  }

  async function detectVideoFrame() {
    const video = videoRef.current
    if (!scannerActiveRef.current || scannerBusyRef.current || !video || video.readyState < 2 || !detectorRef.current) {
      scheduleVideoScan()
      return
    }

    scannerBusyRef.current = true
    try {
      const detections = await detectorRef.current.detect(video)
      const value = detections.find((entry) => entry.rawValue?.trim())?.rawValue
      if (value) {
        scannerActiveRef.current = false
        closeScanner()
        await handleScannedQr(value)
        return
      }
    } catch {
      setScannerMessage('Keep the QR code steady and in focus.')
    } finally {
      scannerBusyRef.current = false
    }
    scheduleVideoScan()
  }

  useEffect(() => {
    if (!scannerOpen || isNativeScannerAvailable()) return

    let cancelled = false
    async function openCamera() {
      try {
        const Detector = window.BarcodeDetector
        if (!Detector || !navigator.mediaDevices?.getUserMedia) {
          throw new Error('This browser does not support camera scanning.')
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' } },
        })
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        scannerStreamRef.current = stream
        detectorRef.current = new Detector({ formats: ['qr_code'] })
        if (!videoRef.current) throw new Error('The camera preview could not be opened.')
        videoRef.current.srcObject = stream
        await videoRef.current.play()
        scannerActiveRef.current = true
        setScannerStatus('active')
        setScannerMessage('Center the equipment QR code in the frame.')
        scheduleVideoScan()
      } catch (error) {
        if (cancelled) return
        closeScanner()
        setNotice({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Could not open the camera. Enter the QR code manually.',
        })
        setManualEntryOpen(true)
      }
    }
    void openCamera()

    return () => {
      cancelled = true
      stopWebScanner()
    }
  }, [scannerOpen])

  async function submitStudentDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!equipment || !qrValue) return

    setIsSubmitting(true)
    setNotice(null)
    try {
      const system = await findSystem()
      if (!system) throw new Error('The system is offline. Retry the system search and submit again.')

      const body = new URLSearchParams({
        qr: qrValue,
        full_name: fullName.trim(),
        program: program.trim(),
        year_level: yearLevel.trim(),
      })
      const result = await readJson<{ ok: boolean; message: string }>(
        system + '/api/equipment/scan-submissions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: body.toString(),
        },
      )
      setIsSubmitted(true)
      setNotice({ kind: 'success', message: result.message || 'Your details were saved to the system.' })
    } catch (error) {
      setNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Could not save your details.',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  async function submitManualCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await handleScannedQr(manualCode)
  }

  function scanAnother() {
    setEquipment(null)
    setQrValue('')
    setFullName('')
    setProgram('')
    setYearLevel('')
    setIsSubmitted(false)
    setNotice(null)
  }

  const statusCopy = systemStatus === 'ready'
    ? systemName
    : systemStatus === 'offline'
      ? 'System unavailable'
      : 'Finding system'

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">TP</div>
        <div className="brand-copy">
          <span className="brand-name">TECHPULSE</span>
          <span className="brand-subtitle">Equipment scanner</span>
        </div>
        <div className={'system-status ' + systemStatus} aria-live="polite">
          <span className="status-dot" />
          <span>{statusCopy}</span>
        </div>
      </header>

      <main className="page-content">
        <section className="intro-card">
          <div className="intro-copy">
            <p className="eyebrow">QUICK EQUIPMENT SCAN</p>
            <h1>Scan equipment</h1>
            <p className="intro-text">Scan the equipment label, then enter your student details to save the record.</p>
            <button className="primary-button scan-button" type="button" onClick={() => void startEquipmentScanner()}>
              <span className="scan-icon" aria-hidden="true"><i /><i /><i /><i /></span>
              {scannerStatus === 'starting' ? 'Opening scanner…' : 'Scan equipment QR'}
            </button>
            <button
              className="text-button retry-button"
              type="button"
              disabled={systemStatus === 'searching'}
              onClick={() => void findSystem(true)}
            >
              {systemStatus === 'searching' ? 'Finding system automatically…' : 'Retry system search'}
            </button>
          </div>
          <div className="scanner-art" aria-hidden="true">
            <div className="scanner-art-square"><span /><span /><span /><span /><b /></div>
            <div className="scanner-art-glow" />
          </div>
        </section>

        {notice && (
          <div className={'notice ' + notice.kind} role="status">
            <span className="notice-mark" aria-hidden="true">{notice.kind === 'success' ? '✓' : notice.kind === 'error' ? '!' : '·'}</span>
            <span>{notice.message}</span>
          </div>
        )}

        {equipment && (
          <section className="equipment-card" aria-live="polite">
            <div className="equipment-heading">
              <div>
                <p className="eyebrow">SCANNED EQUIPMENT</p>
                <h2>{equipment.equipment_name}</h2>
              </div>
              {equipment.status && <span className="equipment-status">{equipment.status}</span>}
            </div>
            <div className="equipment-meta">
              <span>{equipment.equipment_code}</span>
              {equipment.category && <span>{equipment.category}</span>}
            </div>
          </section>
        )}

        {equipment && (
          <section className="form-card">
            {isSubmitted ? (
              <div className="success-state">
                <div className="success-icon" aria-hidden="true">✓</div>
                <p className="eyebrow">RECORD SAVED</p>
                <h2>Thank you, {fullName.split(' ')[0] || 'student'}.</h2>
                <p>Your details are now saved in the TechPulse system with this equipment scan.</p>
                <button className="primary-button" type="button" onClick={scanAnother}>Scan another item</button>
              </div>
            ) : (
              <>
                <div className="form-heading">
                  <p className="eyebrow">STUDENT DETAILS</p>
                  <h2>Complete your record</h2>
                  <p>All fields are required.</p>
                </div>
                <form className="student-form" onSubmit={(event) => void submitStudentDetails(event)}>
                  <label className="field">
                    <span>Full name</span>
                    <input
                      autoComplete="name"
                      maxLength={200}
                      onChange={(event) => setFullName(event.target.value)}
                      placeholder="Enter your full name"
                      required
                      value={fullName}
                    />
                  </label>
                  <label className="field">
                    <span>Program</span>
                    <input
                      autoComplete="organization-title"
                      maxLength={160}
                      onChange={(event) => setProgram(event.target.value)}
                      placeholder="Enter your program"
                      required
                      value={program}
                    />
                  </label>
                  <label className="field">
                    <span>Year</span>
                    <input
                      maxLength={40}
                      onChange={(event) => setYearLevel(event.target.value)}
                      placeholder="e.g. 2nd year"
                      required
                      value={yearLevel}
                    />
                  </label>
                  <button className="primary-button submit-button" disabled={isSubmitting} type="submit">
                    {isSubmitting ? 'Saving to system…' : 'Submit details'}
                    {!isSubmitting && <span aria-hidden="true">→</span>}
                  </button>
                </form>
              </>
            )}
          </section>
        )}

        <details className="manual-entry" open={manualEntryOpen} onToggle={(event) => setManualEntryOpen(event.currentTarget.open)}>
          <summary>Camera not working? Enter the QR code</summary>
          <form onSubmit={(event) => void submitManualCode(event)}>
            <input
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(event) => setManualCode(event.target.value)}
              placeholder="Equipment QR code"
              required
              value={manualCode}
            />
            <button className="secondary-button" type="submit">Find equipment</button>
          </form>
        </details>

        <footer className="page-footer">
          <span className="footer-lock" aria-hidden="true">●</span>
          Submitted details are saved to the system’s mobile scan records.
        </footer>
      </main>

      {scannerOpen && (
        <div className="scanner-backdrop" role="presentation" onClick={(event) => {
          if (event.target === event.currentTarget) closeScanner()
        }}>
          <section className="scanner-modal" role="dialog" aria-modal="true" aria-labelledby="scanner-title">
            <div className="scanner-modal-head">
              <div>
                <p className="eyebrow">CAMERA SCANNER</p>
                <h2 id="scanner-title">Scan equipment QR</h2>
              </div>
              <button className="close-button" type="button" onClick={closeScanner} aria-label="Close scanner">×</button>
            </div>
            <div className="camera-frame">
              <video ref={videoRef} autoPlay muted playsInline />
              <div className="camera-target" aria-hidden="true" />
              {scannerStatus !== 'active' && <div className="camera-message">{scannerMessage}</div>}
            </div>
            <p className="camera-help">{scannerMessage}</p>
          </section>
        </div>
      )}
    </div>
  )
}

export default App
