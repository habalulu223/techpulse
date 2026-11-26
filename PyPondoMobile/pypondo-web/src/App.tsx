import { startTransition, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import './App.css'
import { discoverServers, formatServerAddress, getSourceDescription, type DiscoveredServer } from './discovery'
import { isNativeScannerAvailable, scanQr } from './scanner'

type ServerInfo = {
  ok: boolean
  app_version: string
  server_hostname: string
  server_ip: string
  server_port: number
  server_address?: string
  server_addresses?: string[]
  server_base_url?: string
}

type PairingPayload = {
  ok?: boolean
  app_version?: string
  pairing_mode?: string
  pairing_url?: string
  server_hostname?: string
  server_ip?: string
  server_port?: number
  server_address?: string
  server_addresses?: string[]
  server_base_url?: string
}

type LoginPayload = {
  ok: boolean
  user_id: number
  username: string
  access_token: string
  app_version: string
  error?: string
}

type MobileProfile = {
  user_id: number
  username: string
  full_name: string
  role: string
  has_profile_picture: boolean
}

type ProfilePayload = { ok: boolean; profile: MobileProfile | null }

type ScannedEquipment = {
  equipment_id: number
  equipment_code: string
  equipment_name: string
  category?: string | null
  status: string
  is_available?: boolean
  can_request?: boolean
}

type EquipmentPayload = { ok: boolean; equipment: ScannedEquipment }

type MobilePc = {
  id: number
  name: string
  is_occupied: boolean
  lan_ip?: string | null
  online?: boolean
}

type PcsPayload = {
  ok: boolean
  pcs: MobilePc[]
}

type MobileUpdate = {
  title: string
  description: string
  version: string
  update_type: string
  timestamp?: string
}

type UpdatesPayload = {
  ok: boolean
  updates: MobileUpdate[]
}

type ConnectionStatus = 'idle' | 'testing' | 'connected' | 'error'
type TabKey = 'overview' | 'pcs' | 'equipment' | 'profile' | 'updates'

type StoredConfig = {
  serverAddress: string
}

type StoredSession = {
  userId: number
  username: string
  accessToken: string
}

type ScannerStatus = 'idle' | 'starting' | 'active' | 'unsupported' | 'error'

type DetectedBarcode = {
  rawValue?: string
}

type BarcodeDetectorInstance = {
  detect: (source: CanvasImageSource | ImageBitmap) => Promise<DetectedBarcode[]>
}

type BarcodeDetectorConstructor = new (options?: { formats?: string[] }) => BarcodeDetectorInstance

declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorConstructor
  }
}

const CONFIG_STORAGE_KEY = 'pypondo.mobile.config.v2'
const SESSION_STORAGE_KEY = 'pypondo.mobile.session.v2'
// The APK is self-contained, but authentication still needs a TechPulse server.
// Keep this blank so the app never waits on a guessed hostname during startup.
const DEFAULT_SERVER_ADDRESS = ''
const DEFAULT_SERVER_PORT = 5000
const QR_PAIRING_PATH_PATTERN = /\/api\/mobile\/pairing\/?$/i

// Map an equipment/PC status string to a pill color class: green for
// available, amber for borrowed/occupied, red for maintenance or broken.
function statusPillClass(status: string): string {
  const value = String(status || '').toLowerCase()
  if (/maintenance|repair|broken|faulty/i.test(value)) return 'pill danger'
  if (/borrow|loan|occupied|in use|reserved|busy/i.test(value)) return 'pill warn'
  if (/availab|free|online|ready|active/i.test(value)) return 'pill success'
  return 'pill'
}
const QR_SCAN_INTERVAL_MS = 300
const DEFAULT_SCANNER_MESSAGE =
  'Point the camera at the pairing QR from your desktop to connect over LAN or a public route.'
const DEFAULT_PRODUCT_SCANNER_MESSAGE = 'Sign in, then point the camera at an equipment QR code to view its record.'
const TAB_META: Record<TabKey, { label: string; hint: string }> = {
  overview: {
    label: 'Overview',
    hint: 'Connection status, equipment, and rollout notes.',
  },
  pcs: {
    label: 'PCs',
    hint: 'Live station availability and LAN registration.',
  },
  equipment: { label: 'Equipment', hint: 'Scan equipment QR codes to view item information.' },
  profile: { label: 'Profile', hint: 'Account details, profile picture, and password.' },
  updates: {
    label: 'Updates',
    hint: 'Product notices and release history.',
  },
}

function buildBaseUrl(serverAddress: string) {
  const trimmed = serverAddress.trim()
  if (!trimmed) {
    throw new Error('Enter the Techpuls server address first.')
  }

  const hasScheme = /^https?:\/\//i.test(trimmed)
  const withScheme = hasScheme ? trimmed : `http://${trimmed}`
  const url = new URL(withScheme)

  if (!url.port && !hasScheme) {
    url.port = String(DEFAULT_SERVER_PORT)
  }
  url.pathname = ''
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function formatHostForUrl(host: string) {
  const trimmed = host.trim()
  if (trimmed.includes(':') && !trimmed.startsWith('[')) {
    return `[${trimmed}]`
  }
  return trimmed
}

function normalizeServerAddress(rawValue: string) {
  const trimmed = rawValue.trim()
  if (!trimmed) {
    return ''
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed)
    url.pathname = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  }

  if (trimmed.startsWith('[')) {
    return /\]:\d+$/.test(trimmed) ? trimmed : `${trimmed}:${DEFAULT_SERVER_PORT}`
  }

  const colonCount = (trimmed.match(/:/g) ?? []).length
  if (colonCount > 1) {
    return `${formatHostForUrl(trimmed)}:${DEFAULT_SERVER_PORT}`
  }

  return colonCount === 0 ? `${trimmed}:${DEFAULT_SERVER_PORT}` : trimmed
}

function resolveBaseUrlFromServerInfo(info: Partial<ServerInfo>, fallbackBaseUrl: string) {
  const fallbackUrl = new URL(fallbackBaseUrl)
  const scheme = fallbackUrl.protocol || 'http:'
  const advertisedBaseUrl = typeof info.server_base_url === 'string' ? info.server_base_url.trim() : ''

  if (advertisedBaseUrl) {
    try {
      const parsedAdvertisedUrl = new URL(advertisedBaseUrl)
      if (!parsedAdvertisedUrl.port) {
        parsedAdvertisedUrl.port = String(info.server_port || fallbackUrl.port || DEFAULT_SERVER_PORT)
      }
      parsedAdvertisedUrl.pathname = ''
      parsedAdvertisedUrl.search = ''
      parsedAdvertisedUrl.hash = ''
      return parsedAdvertisedUrl.toString().replace(/\/$/, '')
    } catch {
      // Fall through to the caller-provided origin when the advertised URL is malformed.
    }
  }

  const host = (fallbackUrl.hostname || '').trim()
  const port = Number(info.server_port || fallbackUrl.port || DEFAULT_SERVER_PORT)
  return `${scheme}//${formatHostForUrl(host)}:${port}`
}

async function resolveQrServerAddress(rawValue: string) {
  const trimmed = rawValue.trim()
  if (!trimmed) {
    throw new Error('The QR code did not contain a server address.')
  }

  try {
    const payload = JSON.parse(trimmed) as PairingPayload
    const structuredAddress =
      payload.server_address ||
      payload.server_base_url ||
      (payload.server_ip ? `${payload.server_ip}:${payload.server_port || DEFAULT_SERVER_PORT}` : '')

    if (structuredAddress) {
      return normalizeServerAddress(structuredAddress)
    }
  } catch {
    // The QR payload may be a URL or raw address instead of JSON.
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed)
    if (QR_PAIRING_PATH_PATTERN.test(url.pathname)) {
      const payload = await readJson<PairingPayload>(url.toString())
      const pairedAddress =
        payload.server_address ||
        payload.server_base_url ||
        (payload.server_ip ? `${payload.server_ip}:${payload.server_port || DEFAULT_SERVER_PORT}` : '')

      if (!pairedAddress) {
        throw new Error('The pairing QR connected, but the server did not return a usable address.')
      }

      return normalizeServerAddress(pairedAddress)
    }

    return normalizeServerAddress(trimmed)
  }

  return normalizeServerAddress(trimmed)
}

async function readJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(input, { ...init, signal: init?.signal || controller.signal })
    const raw = await response.text()
    const data = raw ? JSON.parse(raw) : {}

    if (!response.ok) {
      const message =
        typeof data?.error === 'string'
          ? data.error
          : typeof data?.message === 'string'
            ? data.message
            : `Request failed with status ${response.status}.`
      throw new Error(message)
    }

    return data as T
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('The TechPulse server did not respond within 8 seconds. Check the address and network.')
    }
    throw error
  } finally {
    window.clearTimeout(timeoutId)
  }
}

function createFormBody(values: Record<string, string | number>) {
  const body = new URLSearchParams()
  Object.entries(values).forEach(([key, value]) => {
    body.set(key, String(value))
  })
  return body.toString()
}

function formatTimestamp(value?: string) {
  if (!value) {
    return 'Just now'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat('en-PH', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function readStoredConfig(): StoredConfig | null {
  try {
    const raw = window.localStorage.getItem(CONFIG_STORAGE_KEY)
    if (!raw) {
      return null
    }
    return JSON.parse(raw) as StoredConfig
  } catch {
    return null
  }
}

function writeStoredConfig(serverAddress: string) {
  window.localStorage.setItem(
    CONFIG_STORAGE_KEY,
    JSON.stringify({
      serverAddress,
    } satisfies StoredConfig),
  )
}

function readStoredSession(): StoredSession | null {
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) {
      return null
    }
    const storedSession: unknown = JSON.parse(raw)
    if (
      typeof storedSession !== 'object' ||
      storedSession === null ||
      !('accessToken' in storedSession) ||
      typeof storedSession.accessToken !== 'string'
    ) {
      window.localStorage.removeItem(SESSION_STORAGE_KEY)
      return null
    }
    if (
      !('userId' in storedSession) ||
      typeof storedSession.userId !== 'number' ||
      !('username' in storedSession) ||
      typeof storedSession.username !== 'string'
    ) {
      window.localStorage.removeItem(SESSION_STORAGE_KEY)
      return null
    }
    return {
      accessToken: storedSession.accessToken,
      userId: storedSession.userId,
      username: storedSession.username,
    }
  } catch {
    return null
  }
}

function writeStoredSession(session: StoredSession | null) {
  if (!session) {
    window.localStorage.removeItem(SESSION_STORAGE_KEY)
    return
  }

  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
}

function App() {
  const [serverAddress, setServerAddress] = useState(() => readStoredConfig()?.serverAddress || DEFAULT_SERVER_ADDRESS)
  const [baseUrl, setBaseUrl] = useState('')
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('idle')
  const [connectionMessage, setConnectionMessage] = useState(
    'Enter the TechPulse server address or scan the pairing QR code.',
  )
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null)
  const [scannerOpen, setScannerOpen] = useState(false)
  const [scannerStatus, setScannerStatus] = useState<ScannerStatus>('idle')
  const [scannerMessage, setScannerMessage] = useState(DEFAULT_SCANNER_MESSAGE)
  const [scannerMode, setScannerMode] = useState<'server' | 'equipment'>('server')

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const scannerDetectorRef = useRef<BarcodeDetectorInstance | null>(null)
  const scannerStreamRef = useRef<MediaStream | null>(null)
  const scannerTimerRef = useRef<number | null>(null)
  const scannerBusyRef = useRef(false)
  const scannerRunningRef = useRef(false)
  const scannerModeRef = useRef<'server' | 'equipment'>('server')

  // Discovery state
  const [discoveredServers, setDiscoveredServers] = useState<DiscoveredServer[]>([])
  const [discoveringServers, setDiscoveringServers] = useState(false)
  const [discoveryProgress, setDiscoveryProgress] = useState({ found: 0, tested: 0 })
  const [showDiscoveryList, setShowDiscoveryList] = useState(false)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [creatingAccount, setCreatingAccount] = useState(false)
  const [accountFullName, setAccountFullName] = useState('')
  const [accountRole, setAccountRole] = useState<'student' | 'instructor'>('student')
  const [loginBusy, setLoginBusy] = useState(false)
  const [session, setSession] = useState<StoredSession | null>(() => readStoredSession())

  const [activeTab, setActiveTab] = useState<TabKey>('overview')
  const [refreshBusy, setRefreshBusy] = useState(false)
  const [lastSync, setLastSync] = useState('')
  const [pcs, setPcs] = useState<MobilePc[]>([])
  const [updates, setUpdates] = useState<MobileUpdate[]>([])
  const [scannedEquipment, setScannedEquipment] = useState<ScannedEquipment | null>(null)
  const [equipmentScanBusy, setEquipmentScanBusy] = useState(false)
  const [manualCode, setManualCode] = useState('')
  const [profile, setProfile] = useState<MobileProfile | null>(null)
  const [currentProfilePassword, setCurrentProfilePassword] = useState('')
  const [picturePassword, setPicturePassword] = useState('')
  const [newProfilePassword, setNewProfilePassword] = useState('')
  const [profileBusy, setProfileBusy] = useState(false)
  const [borrowPurpose, setBorrowPurpose] = useState('')
  const [expectedReturn, setExpectedReturn] = useState('')
  const [requestBusy, setRequestBusy] = useState(false)
  const [issueTitle, setIssueTitle] = useState('')
  const [issueDescription, setIssueDescription] = useState('')
  const [issueBusy, setIssueBusy] = useState(false)
  useEffect(() => {
    if (serverAddress) {
      void connectToServer(serverAddress, true)
    }
  }, [])

  useEffect(() => {
    if (!baseUrl) {
      return
    }

    void refreshData()
  }, [baseUrl, session?.userId])

  useEffect(() => {
    return () => {
      scannerRunningRef.current = false
      scannerBusyRef.current = false
      if (scannerTimerRef.current !== null) {
        window.clearTimeout(scannerTimerRef.current)
        scannerTimerRef.current = null
      }
      if (scannerStreamRef.current) {
        scannerStreamRef.current.getTracks().forEach((track) => track.stop())
        scannerStreamRef.current = null
      }
    }
  }, [])

  /** Every /api/mobile route now resolves the account from the Bearer token. */
  async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
    if (!baseUrl) {
      throw new Error('Connect to a Techpuls server first.')
    }
    const headers = new Headers(init?.headers)
    if (session?.accessToken) {
      headers.set('Authorization', `Bearer ${session.accessToken}`)
    }
    return readJson<T>(`${baseUrl}${path}`, { ...init, headers })
  }

  function stopScannerHardware() {
    scannerRunningRef.current = false
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

  function closeQrScanner() {
    stopScannerHardware()
    setScannerOpen(false)
    setScannerStatus('idle')
    setScannerMessage(scannerModeRef.current === 'equipment' ? DEFAULT_PRODUCT_SCANNER_MESSAGE : DEFAULT_SCANNER_MESSAGE)
  }

  function scheduleScannerPass() {
    if (!scannerRunningRef.current) {
      return
    }

    scannerTimerRef.current = window.setTimeout(() => {
      void detectQrFromVideo()
    }, QR_SCAN_INTERVAL_MS)
  }

  /** Looks up an equipment QR value. Returns an error message, or null on success. */
  async function lookupEquipment(rawValue: string): Promise<string | null> {
    if (!session?.accessToken) {
      return 'Sign in before scanning equipment.'
    }
    setScannedEquipment(null)
    setEquipmentScanBusy(true)
    try {
      const payload = await apiFetch<EquipmentPayload>(
        `/api/mobile/equipment/scan?qr=${encodeURIComponent(rawValue)}`,
      )
      setScannedEquipment(payload.equipment)
      setActiveTab('equipment')
      setConnectionMessage(`Loaded ${payload.equipment.equipment_name}.`)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : 'Could not load this equipment QR.'
    } finally {
      setEquipmentScanBusy(false)
    }
  }

  async function submitEquipmentCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const failure = await lookupEquipment(manualCode.trim())
    if (failure) {
      setConnectionMessage(failure)
      return
    }
    setManualCode('')
  }

  async function submitBorrowRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session || !scannedEquipment) return
    if (!borrowPurpose.trim() || !expectedReturn) {
      setConnectionMessage('Enter the borrowing purpose and expected return date.')
      return
    }
    setRequestBusy(true)
    try {
      const payload = await apiFetch<{ ok: boolean; message: string }>(
        `/api/mobile/equipment/${scannedEquipment.equipment_id}/request`,
        {
          body: createFormBody({ purpose: borrowPurpose, expected_return_date: expectedReturn }),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          method: 'POST',
        },
      )
      setConnectionMessage(payload.message)
      setBorrowPurpose('')
      setExpectedReturn('')
    } catch (error) {
      setConnectionMessage(error instanceof Error ? error.message : 'Could not send the borrow request.')
    } finally {
      setRequestBusy(false)
    }
  }

  async function submitEquipmentIssue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session || !scannedEquipment) return
    setIssueBusy(true)
    try {
      const payload = await apiFetch<{ ok: boolean; message: string }>(
        `/api/mobile/equipment/${scannedEquipment.equipment_id}/issue`,
        {
          body: createFormBody({ issue_title: issueTitle, issue_description: issueDescription }),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          method: 'POST',
        },
      )
      setConnectionMessage(payload.message)
      setIssueTitle('')
      setIssueDescription('')
    } catch (error) {
      setConnectionMessage(error instanceof Error ? error.message : 'Could not submit the issue report.')
    } finally {
      setIssueBusy(false)
    }
  }

  async function applyScannedQr(rawValue: string) {
    stopScannerHardware()
    setScannerStatus('starting')
    if (scannerModeRef.current === 'equipment') {
      setScannerMessage('Equipment QR found. Loading item information...')
      const failure = await lookupEquipment(rawValue)
      setScannerOpen(Boolean(failure))
      setScannerStatus(failure ? 'error' : 'idle')
      if (failure) {
        setScannerMessage(failure)
      }
      return
    }
    setScannerMessage('QR found. Loading the server details...')

    try {
      const resolvedAddress = await resolveQrServerAddress(rawValue)
      setServerAddress(resolvedAddress)
      setConnectionMessage(`QR found. Connecting to ${resolvedAddress}...`)
      setScannerOpen(false)
      setScannerStatus('idle')
      setScannerMessage(DEFAULT_SCANNER_MESSAGE)
      await connectToServer(resolvedAddress, false)
    } catch (error) {
      setScannerOpen(true)
      setScannerStatus('error')
      setScannerMessage(
        error instanceof Error ? error.message : 'The QR code could not be used for pairing.',
      )
    }
  }

  async function detectQrFromVideo() {
    if (!scannerRunningRef.current || !videoRef.current || !scannerDetectorRef.current) {
      return
    }

    if (videoRef.current.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || scannerBusyRef.current) {
      scheduleScannerPass()
      return
    }

    scannerBusyRef.current = true

    try {
      const detections = await scannerDetectorRef.current.detect(videoRef.current)
      const rawValue = detections.find((entry) => typeof entry.rawValue === 'string' && entry.rawValue.trim())
        ?.rawValue

      if (rawValue) {
        await applyScannedQr(rawValue)
        return
      }
    } catch (error) {
      setScannerStatus('error')
      setScannerMessage(
        error instanceof Error ? error.message : 'The camera opened, but QR detection failed.',
      )
      stopScannerHardware()
      return
    } finally {
      scannerBusyRef.current = false
    }

    scheduleScannerPass()
  }

  async function startQrScanner(mode: 'server' | 'equipment' = 'server') {
    scannerModeRef.current = mode
    setScannerMode(mode)
    setScannerMessage(mode === 'equipment' ? DEFAULT_PRODUCT_SCANNER_MESSAGE : DEFAULT_SCANNER_MESSAGE)

    if (isNativeScannerAvailable()) {
      setScannerOpen(false)
      setScannerStatus('starting')
      setScannerMessage(mode === 'equipment'
        ? 'Point the camera at an equipment QR code.'
        : 'Point the camera at the desktop pairing QR.')
      try {
        const rawValue = await scanQr(mode === 'equipment'
          ? 'Scan an equipment QR code'
          : 'Scan the Techpuls pairing QR')
        if (!rawValue) {
          setScannerStatus('idle')
          setScannerMessage(mode === 'equipment' ? DEFAULT_PRODUCT_SCANNER_MESSAGE : DEFAULT_SCANNER_MESSAGE)
          return
        }
        await applyScannedQr(rawValue)
      } catch (error) {
        setScannerStatus('error')
        setScannerMessage(
          error instanceof Error ? error.message : 'The camera could not read a QR code.',
        )
      }
      return
    }

    const BarcodeDetectorImpl = window.BarcodeDetector
    if (!navigator.mediaDevices?.getUserMedia || !BarcodeDetectorImpl) {
      setScannerOpen(true)
      setScannerStatus('unsupported')
      setScannerMessage(
        'This browser cannot live-scan QR codes. Use the pairing address controls, or type an equipment QR value on the Scan item tab.',
      )
      return
    }

    stopScannerHardware()
    setScannerOpen(true)
    setScannerStatus('starting')
    setScannerMessage(mode === 'equipment' ? 'Allow camera access, then point it at the equipment QR.' : 'Allow camera access, then point it at the desktop pairing QR.')

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          height: { ideal: 1080 },
          width: { ideal: 1920 },
        },
      })

      scannerDetectorRef.current = new BarcodeDetectorImpl({ formats: ['qr_code'] })
      scannerStreamRef.current = stream
      scannerRunningRef.current = true

      await new Promise((resolve) => window.setTimeout(resolve, 0))

      if (!videoRef.current) {
        throw new Error('The camera preview could not be prepared.')
      }

      videoRef.current.srcObject = stream
      await videoRef.current.play()

      setScannerStatus('active')
      setScannerMessage(mode === 'equipment' ? 'Scanning for equipment QR codes...' : 'Scanning for the Techpuls pairing QR...')
      scheduleScannerPass()
    } catch (error) {
      stopScannerHardware()
      setScannerStatus('error')
      setScannerMessage(
        error instanceof Error
          ? error.message
          : 'Camera access was denied or is not available on this device.',
      )
    }
  }

  async function handleScannerImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''

    if (!file) {
      return
    }

    const BarcodeDetectorImpl = window.BarcodeDetector
    if (!BarcodeDetectorImpl) {
      setScannerStatus('unsupported')
      setScannerMessage('Photo scanning is not supported on this device.')
      return
    }

    try {
      const detector = scannerDetectorRef.current || new BarcodeDetectorImpl({ formats: ['qr_code'] })
      const bitmap = await createImageBitmap(file)
      const detections = await detector.detect(bitmap)
      bitmap.close()

      const rawValue = detections.find((entry) => typeof entry.rawValue === 'string' && entry.rawValue.trim())
        ?.rawValue

      if (!rawValue) {
        setScannerStatus('error')
        setScannerMessage('No QR code was detected in that photo. Try the live camera again.')
        return
      }

      await applyScannedQr(rawValue)
    } catch (error) {
      setScannerStatus('error')
      setScannerMessage(
        error instanceof Error ? error.message : 'The selected image could not be scanned.',
      )
    }
  }

  const availablePcs = pcs.filter((pc) => !pc.is_occupied)
  const onlinePcCount = pcs.filter((pc) => pc.online).length
  const latestUpdate = updates[0] ?? null
  const serverAddressSummary = serverInfo
    ? serverInfo.server_address || `${serverInfo.server_ip}:${serverInfo.server_port}`
    : 'Waiting for address'
  const activeTabMeta = TAB_META[activeTab]
  const connectionLabel =
    connectionStatus === 'connected'
      ? 'Connected'
      : connectionStatus === 'testing'
        ? 'Checking'
        : connectionStatus === 'error'
          ? 'Offline'
          : 'Ready'

  async function connectToServer(addressOverride?: string, silent = false): Promise<boolean> {
    const candidateAddress = (addressOverride ?? serverAddress).trim()

    try {
      const nextBaseUrl = buildBaseUrl(candidateAddress)
      setConnectionStatus('testing')
      if (!silent) {
        setConnectionMessage('Checking the Techpuls server...')
      }

      const info = await readJson<ServerInfo>(`${nextBaseUrl}/api/server-info`)
      const resolvedBaseUrl = resolveBaseUrlFromServerInfo(info, nextBaseUrl)
      const resolvedAddress = normalizeServerAddress(
        info.server_address ||
          `${formatHostForUrl(info.server_ip || new URL(resolvedBaseUrl).hostname)}:${info.server_port || DEFAULT_SERVER_PORT}`,
      )

      setBaseUrl(resolvedBaseUrl)
      setServerInfo(info)
      setConnectionStatus('connected')
      setConnectionMessage(
        `Connected to ${info.server_hostname} at ${resolvedAddress}.`,
      )
      writeStoredConfig(resolvedAddress)
      setServerAddress(resolvedAddress)
      return true
    } catch (error) {
      setBaseUrl('')
      setServerInfo(null)
      setConnectionStatus('error')
      setConnectionMessage(
        error instanceof Error
          ? error.message
          : 'Could not reach the Techpuls server from this device.',
      )
      return false
    }
  }

  async function startServerDiscovery(autoLaunch = false) {
    setDiscoveringServers(true)
    setDiscoveryProgress({ found: 0, tested: 0 })
    setConnectionMessage('Searching for Techpuls servers across your network...')

    try {
      const servers = await discoverServers({
        includeGateway: true,
        includeSubnet: true,
        subnetScanCount: 30,
        onProgress: (found, tested) => {
          setDiscoveryProgress({ found, tested })
        },
      })

      setDiscoveredServers(servers)

      if (servers.length === 0) {
        setConnectionMessage(
          autoLaunch
            ? 'No Techpuls server was found automatically. Check that the desktop/server app is open, then scan again.'
            : 'No Techpuls server was found. Check the network connection or use the optional address fallback.',
        )
        setShowDiscoveryList(false)
      } else {
        const bestServer = servers[0]
        setShowDiscoveryList(!autoLaunch && servers.length > 1)
        setConnectionMessage(
          servers.length === 1
            ? 'Found 1 server. Opening it automatically...'
            : `Found ${servers.length} servers. Opening the fastest reachable server automatically...`,
        )
        await connectToServer(formatServerAddress(bestServer), false)
      }
    } catch (error) {
      setConnectionMessage(
        error instanceof Error ? error.message : 'Server discovery failed. Check your network.',
      )
    } finally {
      setDiscoveringServers(false)
    }
  }

  async function selectDiscoveredServer(server: DiscoveredServer) {
    setShowDiscoveryList(false)
    await connectToServer(formatServerAddress(server), false)
  }

  async function refreshData() {
    if (!baseUrl) {
      return
    }

    setRefreshBusy(true)

    try {
      const [pcsPayload, updatesPayload, profilePayload] = await Promise.all([
        apiFetch<PcsPayload>('/api/mobile/pcs'),
        apiFetch<UpdatesPayload>('/api/mobile/updates'),
        session
          ? apiFetch<ProfilePayload>('/api/mobile/profile')
          : Promise.resolve<ProfilePayload>({ ok: true, profile: null }),
      ])

      startTransition(() => {
        setPcs(pcsPayload.pcs ?? [])
        setUpdates(updatesPayload.updates ?? [])
        setProfile(profilePayload.profile)
      })

      setLastSync(new Date().toISOString())
    } catch (error) {
      setConnectionMessage(
        error instanceof Error ? error.message : 'Could not refresh mobile data.',
      )
    } finally {
      setRefreshBusy(false)
    }
  }

  async function submitProfilePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session || !currentProfilePassword || newProfilePassword.length < 8) return
    setProfileBusy(true)
    try {
      const payload = await apiFetch<{ ok: boolean; message: string }>('/api/mobile/profile', {
        body: createFormBody({ action: 'change_password', current_password: currentProfilePassword, new_password: newProfilePassword }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, method: 'POST',
      })
      setConnectionMessage(payload.message)
      setCurrentProfilePassword('')
      setNewProfilePassword('')
    } catch (error) {
      setConnectionMessage(error instanceof Error ? error.message : 'Could not update password.')
    } finally { setProfileBusy(false) }
  }

  async function uploadProfilePicture(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!session || !file) return
    if (!picturePassword) {
      setConnectionMessage('Enter your current password before changing your profile picture.')
      return
    }
    const body = new FormData()
    body.set('action', 'upload_picture')
    body.set('current_password', picturePassword)
    body.set('profile_picture', file)
    setProfileBusy(true)
    try {
      await apiFetch('/api/mobile/profile', { body, method: 'POST' })
      await refreshData()
      setPicturePassword('')
      setConnectionMessage('Profile picture updated.')
    } catch (error) {
      setConnectionMessage(error instanceof Error ? error.message : 'Could not upload profile picture.')
    } finally { setProfileBusy(false); input.value = '' }
  }

  async function removeProfilePicture() {
    if (!session) return
    if (!picturePassword) {
      setConnectionMessage('Enter your current password before changing your profile picture.')
      return
    }
    setProfileBusy(true)
    try {
      await apiFetch('/api/mobile/profile', {
        body: createFormBody({ action: 'remove_picture', current_password: picturePassword }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, method: 'POST',
      })
      await refreshData()
      setPicturePassword('')
      setConnectionMessage('Profile picture removed.')
    } catch (error) {
      setConnectionMessage(error instanceof Error ? error.message : 'Could not remove profile picture.')
    } finally { setProfileBusy(false) }
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!username.trim() || !password.trim()) {
      setConnectionMessage('Enter both username and password.')
      return
    }

    if (!baseUrl) {
      const address = serverAddress.trim()
      if (!address) {
        setConnectionMessage('Connect to the TechPulse server or scan the pairing QR code before signing in.')
        return
      }
      const connected = await connectToServer(address)
      if (!connected) {
        return
      }
    }

    const candidateBaseUrl = baseUrl || buildBaseUrl(serverAddress)

    setLoginBusy(true)

    try {
      const payload = await readJson<LoginPayload>(`${candidateBaseUrl}/api/mobile/login`, {
        body: createFormBody({
          password,
          username,
        }),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        method: 'POST',
      })

      const nextSession: StoredSession = {
        accessToken: payload.access_token,
        userId: payload.user_id,
        username: payload.username,
      }

      setSession(nextSession)
      writeStoredSession(nextSession)
      setPassword('')
      setConnectionMessage(`Signed in as ${payload.username}.`)
      setActiveTab('overview')
    } catch (error) {
      setConnectionMessage(error instanceof Error ? error.message : 'Login failed.')
    } finally {
      setLoginBusy(false)
    }
  }

  async function handleRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!accountFullName.trim() || !username.trim() || password.length < 8) {
      setConnectionMessage('Enter your full name, a username, and a password of at least 8 characters.')
      return
    }
    if (!baseUrl) {
      const address = serverAddress.trim()
      if (!address) {
        setConnectionMessage('Connect to the TechPulse server or scan the pairing QR code before creating an account.')
        return
      }
      const connected = await connectToServer(address)
      if (!connected) return
    }

    setLoginBusy(true)
    try {
      const payload = await readJson<LoginPayload>(`${baseUrl || buildBaseUrl(serverAddress)}/api/mobile/register`, {
        body: createFormBody({
          full_name: accountFullName,
          password,
          role: accountRole,
          username,
        }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        method: 'POST',
      })
      const nextSession: StoredSession = {
        accessToken: payload.access_token,
        userId: payload.user_id,
        username: payload.username,
      }
      setSession(nextSession)
      writeStoredSession(nextSession)
      setPassword('')
      setAccountFullName('')
      setConnectionMessage(`Account created. Signed in as ${payload.username}.`)
      setActiveTab('overview')
    } catch (error) {
      setConnectionMessage(error instanceof Error ? error.message : 'Account creation failed.')
    } finally {
      setLoginBusy(false)
    }
  }

  function handleLogout() {
    setSession(null)
    writeStoredSession(null)
    setProfile(null)
    setCurrentProfilePassword('')
    setPicturePassword('')
    setNewProfilePassword('')
    setConnectionMessage('Signed out on this device.')
  }

  return (
    <main className="app-shell">
      <section className="hero-card">
        <div className="hero-copy">
          <p className="eyebrow">Techpuls Mobile</p>
          <h1>Equipment lifecycle access from anywhere on campus.</h1>
          <p className="hero-text">
            The APK carries the customer experience locally, then links it to the live
            Techpuls stack over LAN by QR pairing, direct address, or network discovery.
          </p>
          <div className="hero-highlights">
            <span className="hero-pill">Bundled UI</span>
            <span className="hero-pill">QR pairing</span>
            <span className="hero-pill">Cross-network discovery</span>
          </div>
        </div>

        <div className="hero-metrics">
          <div className={`status-badge status-${connectionStatus}`}>{connectionLabel}</div>
          <div className="metric-card">
            <span className="metric-label">Server</span>
            <strong>{serverInfo?.server_hostname || 'Not connected'}</strong>
            <span>{serverAddressSummary}</span>
          </div>
          <div className="metric-card">
            <span className="metric-label">Account</span>
            <strong>{session ? session.username : 'Sign in required'}</strong>
            <span>{session ? 'Authenticated mobile access' : 'Sign in to view equipment'}</span>
          </div>
          <div className="metric-card">
            <span className="metric-label">Last sync</span>
            <strong>{lastSync ? formatTimestamp(lastSync) : 'Not synced yet'}</strong>
            <span>{refreshBusy ? 'Refreshing mobile data' : 'Local UI is bundled in the APK'}</span>
          </div>
        </div>
      </section>

      <section className="operations-strip">
        <div className="ops-card">
          <span className="metric-label">Connection path</span>
          <strong>{baseUrl || 'No active server link'}</strong>
          <span>{connectionMessage}</span>
        </div>
        <div className="ops-card">
          <span className="metric-label">Equipment access</span>
          <strong>{session ? 'Ready to scan' : 'Sign in required'}</strong>
          <span>Scan a QR label to view the equipment record.</span>
        </div>
        <div className="ops-card">
          <span className="metric-label">Cafe floor</span>
          <strong>
            {onlinePcCount} online / {availablePcs.length} free
          </strong>
          <span>{pcs.length > 0 ? `${pcs.length} registered PCs visible to mobile.` : 'No mobile PC data yet.'}</span>
        </div>
        <div className="ops-card">
          <span className="metric-label">Latest update</span>
          <strong>{latestUpdate ? latestUpdate.title : 'No release notes yet'}</strong>
          <span>{latestUpdate ? `v${latestUpdate.version} ${latestUpdate.update_type}` : 'Publish updates from the server.'}</span>
        </div>
      </section>

      <section className="panel-grid">
        <article className="panel-card">
          <div className="panel-head">
            <div>
              <p className="section-label">Connection</p>
              <h2>Techpuls server auto-detect</h2>
            </div>
            <button
              className="ghost-button"
              onClick={() => void refreshData()}
              disabled={!baseUrl || refreshBusy}
              type="button"
            >
              {refreshBusy ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>

          <label className="field-label" htmlFor="serverAddress">
            Server address
          </label>
          <input
            id="serverAddress"
            className="text-field"
            onChange={(event) => setServerAddress(event.target.value)}
            placeholder="192.168.1.10:5000 or https://name.trycloudflare.com"
            type="text"
            value={serverAddress}
          />
          <p className="helper-copy">
            The app opens the fastest detected server automatically. This field stays available as a fallback for unusual networks.
          </p>

          <div className="connection-guidance">
            <div className="guidance-item">
              <strong>QR pairing</strong>
              <span>Best when the desktop app is nearby and already connected.</span>
            </div>
            <div className="guidance-item">
              <strong>Auto-detect</strong>
              <span>Runs at launch and opens the fastest reachable server.</span>
            </div>
            <div className="guidance-item">
              <strong>Fallback address</strong>
              <span>Available only for networks where scanning is blocked.</span>
            </div>
          </div>

          <div className="button-row">
            <button
              className="primary-button"
              disabled={connectionStatus === 'testing'}
              onClick={() => void connectToServer()}
              type="button"
            >
              {connectionStatus === 'testing' ? 'Checking...' : 'Connect'}
            </button>
            <button
              className="secondary-button"
              disabled={discoveringServers}
              onClick={() => void startServerDiscovery()}
              type="button"
            >
              {discoveringServers ? `Scanning... (${discoveryProgress.tested})` : 'Scan again'}
            </button>
            <button
              className="secondary-button"
              disabled={scannerStatus === 'starting'}
              onClick={() => void startQrScanner()}
              type="button"
            >
              {scannerStatus === 'starting' ? 'Opening camera...' : 'Scan Pairing QR'}
            </button>
            <button
              className="ghost-button"
              onClick={() => {
                closeQrScanner()
                setSession(null)
                writeStoredSession(null)
                window.localStorage.removeItem(CONFIG_STORAGE_KEY)
                setBaseUrl('')
                setServerInfo(null)
                setConnectionStatus('idle')
                setConnectionMessage('Saved device data cleared.')
              }}
              type="button"
            >
              Reset saved data
            </button>
          </div>

          <p className="status-line">{connectionMessage}</p>

          {scannerOpen && (
            <div className="qr-scanner-panel">
              <div className="scanner-head">
                <div>
                  <p className="section-label">{scannerMode === 'equipment' ? 'Equipment lookup' : 'Camera pairing'}</p>
                  <h3>{scannerMode === 'equipment' ? 'Scan an equipment QR code' : 'Scan the desktop pairing QR'}</h3>
                </div>
                <button className="ghost-button scanner-close" onClick={closeQrScanner} type="button">
                  Close
                </button>
              </div>

              <div className="scanner-view">
                <video
                  ref={videoRef}
                  autoPlay
                  className={scannerStatus === 'active' ? 'scanner-video active' : 'scanner-video'}
                  muted
                  playsInline
                />
                {scannerStatus === 'active' ? <div className="scanner-target" aria-hidden="true" /> : null}
                {scannerStatus !== 'active' ? (
                  <div className="scanner-placeholder">
                    <strong>
                      {scannerStatus === 'unsupported'
                        ? 'Live QR scan is not supported here.'
                        : scannerStatus === 'error'
                          ? 'The camera could not scan the QR yet.'
                          : 'Preparing the camera viewer...'}
                    </strong>
                    <span>{scannerMessage}</span>
                  </div>
                ) : null}
              </div>

              <p className="status-line">{scannerMessage}</p>

              <div className="button-row scanner-actions">
                <button className="secondary-button" onClick={() => void startQrScanner(scannerModeRef.current)} type="button">
                  Restart camera
                </button>
                <label className="ghost-button file-picker-button">
                  Use photo
                  <input accept="image/*" capture="environment" onChange={handleScannerImage} type="file" />
                </label>
              </div>
            </div>
          )}

          {showDiscoveryList && discoveredServers.length > 0 && (
            <div className="discovered-servers-panel">
              <p className="section-label">Available servers</p>
              <div className="server-list">
                {discoveredServers.map((server, idx) => (
                  <button
                    key={idx}
                    className="server-item"
                    onClick={() => void selectDiscoveredServer(server)}
                    type="button"
                  >
                    <div className="server-info">
                      <strong>{server.hostname}</strong>
                      <span className="server-address">
                        {formatServerAddress(server)}
                      </span>
                      <span className="server-source">{getSourceDescription(server.source)}</span>
                    </div>
                    <div className="server-meta">
                      <span className="response-time">{server.responseTime}ms</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="connection-meta">
            <div className="mini-card">
              <span>App version</span>
              <strong>{serverInfo?.app_version || 'Unknown'}</strong>
            </div>
            <div className="mini-card">
              <span>Available PCs</span>
              <strong>{availablePcs.length}</strong>
            </div>
            <div className="mini-card">
              <span>Updates</span>
              <strong>{updates.length}</strong>
            </div>
          </div>
        </article>

        <article className="panel-card">
          <div className="panel-head">
            <div>
              <p className="section-label">Account</p>
                <h2>{session ? `Signed in as ${session.username}` : 'TechPulse account login'}</h2>
            </div>
            {session ? (
              <button className="ghost-button" onClick={handleLogout} type="button">
                Logout
              </button>
            ) : null}
          </div>

          {session ? (
            <div className="overview-stack">
              <div className="summary-grid">
                <div className="summary-card">
                  <span>Online PCs</span>
                  <strong>{onlinePcCount}</strong>
                </div>
                <div className="summary-card">
                  <span>Available PCs</span>
                  <strong>{availablePcs.length}</strong>
                </div>
                <div className="summary-card">
                  <span>Equipment updates</span>
                  <strong>{updates.length}</strong>
                </div>
              </div>

              <div className="active-tab-banner">
                <div>
                  <p className="section-label">Current workspace</p>
                  <h3>{activeTabMeta.label}</h3>
                </div>
                <p>{activeTabMeta.hint}</p>
              </div>

              <div className="tab-row" role="tablist" aria-label="Mobile app sections">
                {(['overview', 'pcs', 'equipment', 'profile', 'updates'] as TabKey[]).map((tab) => (
                  <button
                    key={tab}
                    className={tab === activeTab ? 'tab-button active' : 'tab-button'}
                    onClick={() => setActiveTab(tab)}
                    type="button"
                  >
                    {TAB_META[tab].label}
                  </button>
                ))}
              </div>

              {activeTab === 'overview' ? (
                <section className="content-stack">
                  <div className="info-banner">
                    This APK hosts the customer UI locally. Only the Techpuls server needs
                    to be reachable on the network.
                  </div>

                  <div className="two-column-grid">
                    <div className="content-card">
                      <h3>Quick actions</h3>
                      <div className="quick-actions-grid">
                        <button className="ghost-button action-button" onClick={() => setActiveTab('pcs')} type="button">
                          Check PCs
                        </button>
                        <button className="ghost-button action-button" disabled={!baseUrl || equipmentScanBusy} onClick={() => void startQrScanner('equipment')} type="button">
                          {equipmentScanBusy ? 'Loading item…' : 'Scan equipment QR'}
                        </button>
                      </div>
                    </div>

                    <div className="content-card">
                      <h3>Latest updates</h3>
                      {updates.length > 0 ? (
                        updates.slice(0, 2).map((update) => (
                          <div className="list-item" key={`${update.version}-${update.title}`}>
                            <strong>{update.title}</strong>
                            <span>{update.description}</span>
                            <span className="pill accent">
                              v{update.version} {update.update_type}
                            </span>
                          </div>
                        ))
                      ) : (
                        <p className="empty-copy">No updates published yet.</p>
                      )}
                    </div>
                  </div>
                </section>
              ) : null}

              {activeTab === 'profile' ? (
                <section className="content-stack">
                  <div className="content-card">
                    <h3>Account details</h3>
                    {profile ? (
                      <>
                        <div className="list-item"><strong>{profile.full_name}</strong><span>{profile.role}</span></div>
                        <div className="list-item"><strong>Username</strong><span>{profile.username}</span></div>
                      </>
                    ) : <p className="empty-copy">Sign in to view your account profile.</p>}
                    <p className="section-copy">{profile?.has_profile_picture ? 'A profile picture is saved.' : 'No profile picture is saved.'} Enter your current password to make a change.</p>
                    <label className="field-label" htmlFor="picturePassword">Current password</label>
                    <input id="picturePassword" className="text-field" autoComplete="current-password" disabled={!session || profileBusy} onChange={(event) => setPicturePassword(event.target.value)} type="password" value={picturePassword} />
                    <label className="field-label" htmlFor="profilePicture">Profile picture · JPG, PNG, or WebP up to 2 MB</label>
                    <input id="profilePicture" className="text-field" accept="image/jpeg,image/png,image/webp" disabled={!session || profileBusy} onChange={uploadProfilePicture} type="file" />
                    {profile?.has_profile_picture ? <button className="ghost-button" disabled={profileBusy} onClick={() => void removeProfilePicture()} type="button">Remove picture</button> : null}
                  </div>
                  <form className="content-card" onSubmit={submitProfilePassword}>
                    <h3>Change password</h3>
                    <label className="field-label" htmlFor="profileCurrentPassword">Current password</label>
                    <input id="profileCurrentPassword" className="text-field" autoComplete="current-password" disabled={!session || profileBusy} onChange={(event) => setCurrentProfilePassword(event.target.value)} type="password" value={currentProfilePassword} />
                    <label className="field-label" htmlFor="profileNewPassword">New password (at least 8 characters)</label>
                    <input id="profileNewPassword" className="text-field" autoComplete="new-password" disabled={!session || profileBusy} minLength={8} onChange={(event) => setNewProfilePassword(event.target.value)} type="password" value={newProfilePassword} />
                    <button className="primary-button" disabled={!session || profileBusy || newProfilePassword.length < 8} type="submit">{profileBusy ? 'Saving…' : 'Update password'}</button>
                  </form>
                </section>
              ) : null}

              {activeTab === 'pcs' ? (
                <section className="content-card">
                  <h3>PC availability</h3>
                  {pcs.length > 0 ? (
                    pcs.map((pc) => (
                      <div className="list-item" key={pc.id}>
                        <strong>{pc.name}</strong>
                        <span>{pc.lan_ip || 'No LAN IP registered yet'}</span>
                        <span className={statusPillClass(pc.online ? 'online' : pc.is_occupied ? 'busy' : 'free')}>
                          {pc.online ? 'online' : pc.is_occupied ? 'busy' : 'free'}
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="empty-copy">No PCs are exposed by the mobile API yet.</p>
                  )}
                </section>
              ) : null}

              {activeTab === 'equipment' ? (
                <section className="content-stack">
                  <div className="content-card product-scan-card">
                    <div className="panel-head">
                      <div><p className="section-label">Equipment lookup</p><h3>Scan a product or asset</h3></div>
                      <button className="primary-button compact-button" disabled={!baseUrl || equipmentScanBusy} onClick={() => void startQrScanner('equipment')} type="button">
                        {equipmentScanBusy ? 'Loading…' : 'Scan QR'}
                      </button>
                    </div>
                    <p className="section-copy">Sign in and scan an equipment label to view its name, category, and current status.</p>
                  </div>
                  <form className="content-card" onSubmit={submitEquipmentCode}>
                    <label className="field-label" htmlFor="manualEquipmentCode">Equipment QR value</label>
                    <input
                      id="manualEquipmentCode"
                      className="text-field"
                      disabled={!session || equipmentScanBusy}
                      onChange={(event) => setManualCode(event.target.value)}
                      placeholder="PYPONDO-EQUIPMENT:…"
                      type="text"
                      value={manualCode}
                    />
                    <p className="helper-copy">Use this when the label is damaged or the camera is unavailable.</p>
                    <button className="secondary-button" disabled={!session || equipmentScanBusy || !manualCode.trim()} type="submit">
                      {equipmentScanBusy ? 'Loading…' : 'Look up item'}
                    </button>
                  </form>
                  {scannedEquipment ? (
                    <>
                      <div className="content-card">
                        <div className="equipment-title-row">
                          <div><p className="section-label">{scannedEquipment.equipment_code} · {scannedEquipment.category || 'Equipment'}</p><h3>{scannedEquipment.equipment_name}</h3></div>
                          <span className={statusPillClass(scannedEquipment.status)}>{scannedEquipment.status}</span>
                        </div>
                      </div>
                      {scannedEquipment.can_request ? (
                        <form className="content-card" onSubmit={submitBorrowRequest}>
                          <h3>Request this equipment</h3>
                          <label className="field-label" htmlFor="borrowPurpose">Purpose</label>
                          <input id="borrowPurpose" className="text-field" onChange={(event) => setBorrowPurpose(event.target.value)} value={borrowPurpose} required />
                          <label className="field-label" htmlFor="expectedReturn">Expected return date</label>
                          <input id="expectedReturn" className="text-field" onChange={(event) => setExpectedReturn(event.target.value)} type="date" value={expectedReturn} required />
                          <button className="primary-button" disabled={requestBusy} type="submit">{requestBusy ? 'Sending...' : 'Send borrow request'}</button>
                        </form>
                      ) : null}
                      <form className="content-card" onSubmit={submitEquipmentIssue}>
                        <h3>Report an issue</h3>
                        <label className="field-label" htmlFor="issueTitle">Issue type</label>
                        <input id="issueTitle" className="text-field" onChange={(event) => setIssueTitle(event.target.value)} placeholder="Damage, malfunction, missing accessory..." value={issueTitle} required />
                        <label className="field-label" htmlFor="issueDescription">Description</label>
                        <textarea id="issueDescription" className="text-area" onChange={(event) => setIssueDescription(event.target.value)} value={issueDescription} required rows={4} />
                        <button className="secondary-button" disabled={issueBusy} type="submit">{issueBusy ? 'Submitting...' : 'Submit issue report'}</button>
                      </form>
                    </>
                  ) : <div className="content-card"><p className="empty-copy">Scan an equipment QR code to load its record.</p></div>}
                </section>
              ) : null}

              {activeTab === 'updates' ? (
                <section className="content-card">
                  <h3>Release feed</h3>
                  {updates.length > 0 ? (
                    updates.map((update) => (
                      <div className="list-item" key={`${update.version}-${update.title}`}>
                        <strong>{update.title}</strong>
                        <span>{update.description}</span>
                        <span className="pill accent">
                          v{update.version} · {update.update_type} · {formatTimestamp(update.timestamp)}
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="empty-copy">No update feed items are available.</p>
                  )}
                </section>
              ) : null}
            </div>
          ) : (
            <form className="login-form" onSubmit={creatingAccount ? handleRegister : handleLogin}>
              <p className="login-copy">
                {creatingAccount
                  ? 'Create a borrower account for equipment requests and issue reporting.'
                  : 'Sign in with a student or instructor account. The APK keeps its interface local and connects to TechPulse through the paired server.'}
              </p>

              {creatingAccount ? (
                <>
                  <label className="field-label" htmlFor="accountFullName">Full name</label>
                  <input id="accountFullName" className="text-field" onChange={(event) => setAccountFullName(event.target.value)} type="text" value={accountFullName} />
                  <label className="field-label" htmlFor="accountRole">Account type</label>
                  <select id="accountRole" className="text-field" onChange={(event) => setAccountRole(event.target.value as 'student' | 'instructor')} value={accountRole}>
                    <option value="student">Student</option>
                    <option value="instructor">Instructor</option>
                  </select>
                </>
              ) : null}

              <label className="field-label" htmlFor="username">
                Username
              </label>
              <input
                id="username"
                className="text-field"
                onChange={(event) => setUsername(event.target.value)}
                type="text"
                value={username}
              />

              <label className="field-label" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                className="text-field"
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                value={password}
              />

              <button
                className="primary-button"
                disabled={loginBusy || connectionStatus === 'testing'}
                type="submit"
              >
                {loginBusy ? (creatingAccount ? 'Creating account...' : 'Signing in...') : (creatingAccount ? 'Create account' : 'Sign in')}
              </button>
              <button className="ghost-button" disabled={loginBusy} onClick={() => setCreatingAccount((value) => !value)} type="button">
                {creatingAccount ? 'I already have an account' : 'Create a borrower account'}
              </button>
            </form>
          )}
        </article>
      </section>
    </main>
  )
}

export default App
