// Pure game logic + Raster renderer. No $ references.

import { CARS, QUIZ, LEVEL_XP, levelFromXp, xpProgress, type CarDef, type Perk, type QuizQ } from './road-trip-art'

// ─── Colors ───────────────────────────────────────────────────────────────────

const T = 0x01000000  // terminal default

const D = {
  road: 0x1C1B24, grass: 0x0F2218, edge: 0x6E7CF6, lane: 0x2E2D3A,
  hud: 0xFFF6E8, car: 0x6E7CF6, carBody: 0x9AA5FF, coin: 0xFFD700,
  task: 0xFF3D97, obs: 0xFF5533, obsStripe: 0xCC2200,
  nitro: 0x00FFFF, right: 0x44FF88, wrong: 0xFF3D97,
  tree: 0x2A5C38, dot: 0x334433, overlay: 0x1A1928,
  gateA: 0x3A3060, gateB: 0x603030, gateC: 0x305030,
  shield: 0xFFDD00, quizHdr: 0xFF8C00, dimRoad: 0x252430,
}
const R = {
  road: 0x000000, grass: 0x001400, edge: 0xFF00FF, lane: 0x006666,
  hud: 0x00FF00, car: 0x00FFFF, carBody: 0x00DDDD, coin: 0xFFAA00,
  task: 0xFF00FF, obs: 0xFF2200, obsStripe: 0xAA0000,
  nitro: 0xFF00FF, right: 0x00FF00, wrong: 0xFF0000,
  tree: 0x004400, dot: 0x002200, overlay: 0x0A0A0A,
  gateA: 0x220066, gateB: 0x660022, gateC: 0x006622,
  shield: 0xFFCC00, quizHdr: 0xFF6600, dimRoad: 0x0A0A0A,
}

// ─── Base64 ───────────────────────────────────────────────────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function encodeB64(bytes: Uint8Array): string {
  const len = bytes.length
  const out: string[] = new Array(Math.ceil(len / 3) * 4)
  let o = 0
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i]!, b1 = bytes[i + 1] ?? 0, b2 = bytes[i + 2] ?? 0
    out[o++] = B64[b0 >> 2]!
    out[o++] = B64[((b0 & 3) << 4) | (b1 >> 4)]!
    out[o++] = B64[((b1 & 0xf) << 2) | (b2 >> 6)]!
    out[o++] = B64[b2 & 0x3f]!
  }
  const rem = len % 3
  if (rem === 1) { out[o - 2] = '='; out[o - 1] = '=' }
  else if (rem === 2) { out[o - 1] = '=' }
  return out.join('')
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type Phase = 'countdown' | 'driving' | 'paused' | 'flattire' | 'arrived' | 'garage'
export type ObjKind = 'coin' | 'taskcoin' | 'barrier' | 'cone' | 'pothole' | 'gate'

export interface RoadObj {
  id: number
  kind: ObjKind
  row: number         // current screen row in road area (2 = just below HUD)
  lane: 0 | 1 | 2    // for gate: the "correct" lane; use lanes[] for barriers
  lanes?: (0 | 1 | 2)[]  // barrier: which lanes are blocked
  quizIdx?: number    // gate only
  collected: boolean
}

export interface Profile {
  bank: number
  ownedCars: string[]
  currentCar: string
  xp: number
  bestDistance: number
}

export interface GameState {
  // Layout
  cols: number
  rows: number       // total Raster rows
  laneW: number      // lane width in columns
  roadL: number      // column of left road edge (▌)
  // Profile
  profile: Profile
  // Per-run
  phase: Phase
  tick: number
  countdown: number
  cdTimer: number
  carX: number
  carTargetLane: 0 | 1 | 2
  carLane: 0 | 1 | 2
  speed: number
  scrollAcc: number
  scrollPhase: number  // 0..7, drives lane-dash scroll
  distance: number
  objects: RoadObj[]
  nextId: number
  spawnAcc: number
  spawnNext: number
  coinsThisRun: number
  quizRightThisRun: number
  nitroTicks: number
  shieldActive: boolean
  flatTireTimer: number
  shakeTicks: number
  seenCompleted: number
  taskCoinQueue: number
  lastQuizTick: number
  nextQuizTicks: number
  activeQuiz: QuizQ | null
  quizAnswered: boolean
  garagePage: number
  retro: boolean
  arrivedData: { distance: number; coins: number; quizRight: number } | null
}

// ─── Layout helpers ──────────────────────────────────────────────────────────

function calcLayout(cols: number): { laneW: number; roadL: number } {
  const laneW = Math.max(5, Math.floor((cols - 16) / 3))
  const roadW = 3 * laneW + 4  // 2 edges + 2 dividers
  const roadL = Math.max(2, Math.floor((cols - roadW) / 2))
  return { laneW, roadL }
}

export function laneCenter(g: Pick<GameState, 'roadL' | 'laneW'>, lane: 0 | 1 | 2): number {
  return g.roadL + 1 + lane * (g.laneW + 1) + Math.floor(g.laneW / 2)
}

function roadRight(g: Pick<GameState, 'roadL' | 'laneW'>): number {
  return g.roadL + 1 + 3 * g.laneW + 2  // after lane 2, the ▐ edge
}

// ─── Profile validation ───────────────────────────────────────────────────────

export function parseProfile(raw: unknown): Profile {
  const def: Profile = { bank: 0, ownedCars: ['hatch'], currentCar: 'hatch', xp: 0, bestDistance: 0 }
  if (!raw || typeof raw !== 'object') return def
  const r = raw as Record<string, unknown>
  const validIds = CARS.map(c => c.id)
  if (typeof r['bank'] === 'number' && r['bank'] >= 0) def.bank = Math.floor(r['bank'])
  if (Array.isArray(r['ownedCars'])) {
    def.ownedCars = r['ownedCars'].filter((x: unknown) => typeof x === 'string' && validIds.includes(x)) as string[]
    if (!def.ownedCars.includes('hatch')) def.ownedCars.unshift('hatch')
  }
  if (typeof r['currentCar'] === 'string' && def.ownedCars.includes(r['currentCar'])) {
    def.currentCar = r['currentCar']
  }
  if (typeof r['xp'] === 'number' && r['xp'] >= 0) def.xp = Math.floor(r['xp'])
  if (typeof r['bestDistance'] === 'number' && r['bestDistance'] >= 0) def.bestDistance = Math.floor(r['bestDistance'])
  return def
}

// ─── Game creation ────────────────────────────────────────────────────────────

export function createGame(cols: number, rows: number, profile: Profile, retro: boolean): GameState {
  const { laneW, roadL } = calcLayout(cols)
  const car = CARS.find(c => c.id === profile.currentCar) ?? CARS[0]!
  return {
    cols, rows, laneW, roadL,
    profile: { ...profile },
    phase: 'countdown',
    tick: 0,
    countdown: 3,
    cdTimer: 0,
    carX: laneCenter({ laneW, roadL }, 1),
    carTargetLane: 1,
    carLane: 1,
    speed: car.perk === 'all' ? 0.8 : 0.5,
    scrollAcc: 0,
    scrollPhase: 0,
    distance: 0,
    objects: [],
    nextId: 1,
    spawnAcc: 0,
    spawnNext: 20,
    coinsThisRun: 0,
    quizRightThisRun: 0,
    nitroTicks: car.perk === 'all' ? 90 : 0,
    shieldActive: car.perk === 'shield' || car.perk === 'all',
    flatTireTimer: 0,
    shakeTicks: 0,
    seenCompleted: 0,
    taskCoinQueue: 0,
    lastQuizTick: 0,
    nextQuizTicks: pickQuizInterval(),
    activeQuiz: null,
    quizAnswered: false,
    garagePage: CARS.findIndex(c => c.id === profile.currentCar),
    retro,
    arrivedData: null,
  }
}

export function resizeGame(g: GameState, cols: number, rows: number): GameState {
  const { laneW, roadL } = calcLayout(cols)
  const newG = { ...g, cols, rows, laneW, roadL }
  // Reposition car to same lane
  newG.carX = laneCenter(newG, newG.carLane)
  // Reposition objects horizontally (they're row-based anyway, no x stored)
  return newG
}

function pickQuizInterval(): number {
  // 25–30 seconds at 70ms/tick = 357–428 ticks
  return 357 + Math.floor(Math.random() * 72)
}

// ─── Input ────────────────────────────────────────────────────────────────────

export function handleKey(g: GameState, key: 'a' | 'd' | 'p' | 'g' | 'b'): void {
  switch (g.phase) {
    case 'countdown':
    case 'driving':
      if (key === 'a') { const t = Math.max(0, g.carTargetLane - 1) as 0|1|2; g.carTargetLane = t }
      else if (key === 'd') { const t = Math.min(2, g.carTargetLane + 1) as 0|1|2; g.carTargetLane = t }
      else if (key === 'p') g.phase = 'paused'
      else if (key === 'g') { g.phase = 'garage'; g.garagePage = CARS.findIndex(c => c.id === g.profile.currentCar) }
      break
    case 'paused':
      if (key === 'p' || key === 'g') g.phase = 'driving'
      else if (key === 'a') { const t = Math.max(0, g.carTargetLane - 1) as 0|1|2; g.carTargetLane = t }
      else if (key === 'd') { const t = Math.min(2, g.carTargetLane + 1) as 0|1|2; g.carTargetLane = t }
      break
    case 'garage':
      if (key === 'a') g.garagePage = Math.max(0, g.garagePage - 1)
      else if (key === 'd') g.garagePage = Math.min(CARS.length - 1, g.garagePage + 1)
      else if (key === 'b') garageBuy(g)
      else if (key === 'p' || key === 'g') g.phase = g.arrivedData ? 'arrived' : 'driving'
      break
    case 'arrived':
      if (key === 'a') startNewRun(g)           // Keep Driving
      else if (key === 'g') { g.phase = 'garage'; g.garagePage = CARS.findIndex(c => c.id === g.profile.currentCar) }
      // 'b' = Close (handled by caller via $.ui.close)
      break
    case 'flattire':
      break
  }
}

export function garageBuy(g: GameState): 'ok' | 'locked' | 'poor' | 'driving' {
  const car = CARS[g.garagePage]
  if (!car) return 'poor'
  const level = levelFromXp(g.profile.xp)
  if (level < car.levelReq) return 'locked'
  if (g.profile.currentCar === car.id && g.profile.ownedCars.includes(car.id)) return 'driving'
  if (!g.profile.ownedCars.includes(car.id)) {
    if (g.profile.bank < car.price) return 'poor'
    g.profile.bank -= car.price
    g.profile.ownedCars = [...g.profile.ownedCars, car.id]
  }
  g.profile.currentCar = car.id
  if (g.arrivedData) {
    g.phase = 'countdown'
    g.arrivedData = null
    startNewRun(g)
  } else {
    startNewRun(g)
  }
  return 'ok'
}

function startNewRun(g: GameState): void {
  const { laneW, roadL } = calcLayout(g.cols)
  Object.assign(g, {
    phase: 'countdown', tick: 0, countdown: 3, cdTimer: 0,
    laneW, roadL,
    carX: laneCenter({ laneW, roadL }, 1), carTargetLane: 1, carLane: 1,
    speed: 0.5, scrollAcc: 0, scrollPhase: 0, distance: 0,
    objects: [], nextId: g.nextId, spawnAcc: 0, spawnNext: 20,
    coinsThisRun: 0, quizRightThisRun: 0,
    flatTireTimer: 0, shakeTicks: 0, arrivedData: null,
  })
  const car = CARS.find(c => c.id === g.profile.currentCar) ?? CARS[0]!
  if (car.perk === 'all') { g.speed = 0.8; g.nitroTicks = 90 } else { g.nitroTicks = 0 }
  g.shieldActive = car.perk === 'shield' || car.perk === 'all'
  g.lastQuizTick = 0
  g.nextQuizTicks = pickQuizInterval()
  g.activeQuiz = null
  g.quizAnswered = false
}

// ─── Game tick ────────────────────────────────────────────────────────────────

export function tickGame(g: GameState): void {
  if (g.phase === 'paused' || g.phase === 'arrived' || g.phase === 'garage') return

  if (g.phase === 'countdown') {
    g.cdTimer++
    if (g.cdTimer >= 18) {  // ~1.3s per count
      g.cdTimer = 0
      g.countdown--
      if (g.countdown <= 0) g.phase = 'driving'
    }
    return
  }

  if (g.phase === 'flattire') {
    g.flatTireTimer--
    if (g.flatTireTimer <= 0) startNewRun(g)
    return
  }

  // Driving
  g.tick++

  // Smooth car movement (ease toward target lane center)
  const targetX = laneCenter(g, g.carTargetLane)
  const dx = targetX - g.carX
  g.carX += dx * 0.18
  if (Math.abs(dx) < 0.6) { g.carX = targetX; g.carLane = g.carTargetLane }

  // Shake decay
  if (g.shakeTicks > 0) g.shakeTicks--

  // Nitro decay
  if (g.nitroTicks > 0) g.nitroTicks--

  // Speed ramp-up (max ~2.5 rows/tick)
  const baseSpeed = 0.5 + g.distance / 20000
  g.speed = Math.min(2.5, (g.nitroTicks > 0 ? 2.5 : baseSpeed))

  // Scroll
  g.scrollAcc += g.speed
  const scrolled = Math.floor(g.scrollAcc)
  g.scrollAcc -= scrolled
  g.scrollPhase = (g.scrollPhase + g.speed) % 8

  // Update distance
  g.distance += g.speed * 1.5  // meters (approx)

  // XP from distance (1 XP per ~50 distance)
  if (Math.floor(g.distance / 50) > Math.floor((g.distance - g.speed * 1.5) / 50)) {
    g.profile.xp += 1
  }

  // Move objects down the screen (they scroll toward car, which is at bottom)
  for (const obj of g.objects) {
    obj.row += scrolled
  }

  // Spawn task coins from queue
  if (g.taskCoinQueue > 0 && g.tick % 8 === 0) {
    const lane = (Math.floor(Math.random() * 3)) as 0 | 1 | 2
    g.objects.push({ id: g.nextId++, kind: 'taskcoin', row: 2, lane, collected: false })
    g.taskCoinQueue--
  }

  // Spawn new objects
  g.spawnAcc += g.speed
  if (g.spawnAcc >= g.spawnNext) {
    g.spawnAcc = 0
    g.spawnNext = 15 + Math.floor(Math.random() * 12)
    spawnObject(g)
  }

  // Quiz timer
  if (g.tick - g.lastQuizTick >= g.nextQuizTicks && !g.activeQuiz) {
    const q = QUIZ[Math.floor(Math.random() * QUIZ.length)]!
    g.activeQuiz = q
    g.quizAnswered = false
    const correctLane = Math.floor(Math.random() * 3) as 0 | 1 | 2
    // Build gate permutation so correct answer lands in correctLane
    const perm: [0|1|2, 0|1|2, 0|1|2] = [0, 1, 2]
    // swap correct answer index into correctLane
    const correctOptIdx = q.correct
    const tmp = perm[correctLane]!
    perm[correctLane] = correctOptIdx as 0|1|2
    perm[correctOptIdx] = tmp as 0|1|2
    g.objects.push({
      id: g.nextId++, kind: 'gate', row: 2,
      lane: correctLane,
      quizIdx: QUIZ.indexOf(q),
      collected: false,
    })
    ;(g.objects[g.objects.length - 1] as RoadObj & { perm?: number[] })['perm'] = perm
    g.lastQuizTick = g.tick
    g.nextQuizTicks = pickQuizInterval()
  }

  // Collision detection
  const carTopRow = g.rows - 3  // top of car in Raster coords
  const carBotRow = g.rows - 1
  const carEffLane = closestLane(g, g.carX)
  const car = CARS.find(c => c.id === g.profile.currentCar) ?? CARS[0]!
  const hasMagnet = car.perk === 'magnet' || car.perk === 'all'

  for (const obj of g.objects) {
    if (obj.collected) continue
    if (obj.row < carTopRow || obj.row > carBotRow + 1) continue

    // Lane match
    const inLane = obj.lane === carEffLane
    const adjacentCoin = hasMagnet && (obj.kind === 'coin' || obj.kind === 'taskcoin') &&
      Math.abs(obj.lane - carEffLane) === 1

    if (!inLane && !adjacentCoin) {
      // Check barrier: it blocks specific lanes
      if (obj.kind === 'barrier') {
        const blocked = (obj as RoadObj & { lanes?: (0|1|2)[] }).lanes ?? [obj.lane]
        if (!blocked.includes(carEffLane)) continue
      } else continue
    }

    if (obj.kind === 'coin') {
      obj.collected = true
      const mult = car.perk === 'doublecoin' || car.perk === 'all' ? 2 : 1
      g.profile.bank += mult
      g.coinsThisRun += mult
    } else if (obj.kind === 'taskcoin') {
      obj.collected = true
      const mult = car.perk === 'doublecoin' || car.perk === 'all' ? 2 : 1
      g.profile.bank += 10 * mult
      g.coinsThisRun += 10 * mult
    } else if (obj.kind === 'barrier' || obj.kind === 'cone' || obj.kind === 'pothole') {
      if (g.nitroTicks > 0) {
        // Nitro smashes through: collect 2 coins
        obj.collected = true
        g.profile.bank += 2
        g.coinsThisRun += 2
      } else if (g.shieldActive) {
        obj.collected = true
        g.shieldActive = false
      } else {
        obj.collected = true
        hitObstacle(g)
        return
      }
    } else if (obj.kind === 'gate' && !g.quizAnswered) {
      obj.collected = true
      g.quizAnswered = true
      const correctLane = obj.lane
      if (carEffLane === correctLane) {
        // Correct lane
        g.activeQuiz = null
        const mult = car.perk === 'doublecoin' || car.perk === 'all' ? 2 : 1
        g.profile.bank += 15 * mult
        g.coinsThisRun += 15 * mult
        g.profile.xp += 50
        g.nitroTicks = Math.max(g.nitroTicks, 60 + Math.floor(60 * Math.random()))
        g.quizRightThisRun++
      } else {
        g.activeQuiz = null
      }
    }
  }

  // Remove off-screen or collected objects
  g.objects = g.objects.filter(o => !o.collected && o.row <= g.rows + 2)
}

export function hitObstacle(g: GameState): void {
  g.shakeTicks = 8
  g.phase = 'flattire'
  g.flatTireTimer = 28  // ~2s
}

function spawnObject(g: GameState): void {
  const r = Math.random()
  if (r < 0.45) {
    // Coins: 2-4 in a line, random lane
    const lane = (Math.floor(Math.random() * 3)) as 0 | 1 | 2
    const count = 2 + Math.floor(Math.random() * 3)
    for (let i = 0; i < count; i++) {
      g.objects.push({ id: g.nextId++, kind: 'coin', row: 2 + i * 3, lane, collected: false })
    }
  } else if (r < 0.70) {
    // Obstacle: barrier, cone or pothole
    const kind: ObjKind = r < 0.55 ? 'barrier' : r < 0.62 ? 'cone' : 'pothole'
    // Pick which lanes to block (never all 3)
    const blockedCount = Math.random() < 0.4 ? 2 : 1
    const lanes: (0 | 1 | 2)[] = [0, 1, 2]
    for (let i = lanes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[lanes[i], lanes[j]] = [lanes[j]!, lanes[i]!]
    }
    const blocked = lanes.slice(0, blockedCount) as (0 | 1 | 2)[]
    const primaryLane = blocked[0]!
    g.objects.push({ id: g.nextId++, kind, row: 2, lane: primaryLane, lanes: blocked, collected: false })
  }
  // else: nothing this cycle
}

function closestLane(g: GameState, x: number): 0 | 1 | 2 {
  let best: 0 | 1 | 2 = 0
  let bestDist = Infinity
  for (const lane of [0, 1, 2] as const) {
    const d = Math.abs(laneCenter(g, lane) - x)
    if (d < bestDist) { bestDist = d; best = lane }
  }
  return best
}

// ─── Arrived / Resume ─────────────────────────────────────────────────────────

export function triggerArrived(g: GameState): void {
  if (g.phase !== 'driving' && g.phase !== 'countdown') return
  if (g.distance > g.profile.bestDistance) g.profile.bestDistance = Math.floor(g.distance)
  g.arrivedData = { distance: Math.floor(g.distance), coins: g.coinsThisRun, quizRight: g.quizRightThisRun }
  g.phase = 'arrived'
}

export function resumeFromArrived(g: GameState): void {
  if (g.phase !== 'arrived') return
  startNewRun(g)
}

// ─── Raster renderer ──────────────────────────────────────────────────────────

let frameBuffer = new Uint32Array(0)

function ensureBuf(cols: number, rows: number): Uint32Array {
  const need = cols * rows * 3
  if (frameBuffer.length !== need) frameBuffer = new Uint32Array(need)
  return frameBuffer
}

function sc(buf: Uint32Array, col: number, row: number, cols: number, rows: number, cp: number, fg: number, bg: number): void {
  if (col < 0 || col >= cols || row < 0 || row >= rows) return
  const i = (row * cols + col) * 3
  buf[i] = cp; buf[i + 1] = fg; buf[i + 2] = bg
}

function sw(buf: Uint32Array, col: number, row: number, cols: number, rows: number, str: string, fg: number, bg: number): void {
  let c = col
  for (let i = 0; i < str.length; ) {
    const cp = str.codePointAt(i)!
    sc(buf, c++, row, cols, rows, cp, fg, bg)
    i += cp > 0xFFFF ? 2 : 1
  }
}

function fr(buf: Uint32Array, r1: number, c1: number, r2: number, c2: number, cols: number, rows: number, cp: number, fg: number, bg: number): void {
  for (let row = r1; row <= r2; row++) {
    for (let col = c1; col <= c2; col++) {
      sc(buf, col, row, cols, rows, cp, fg, bg)
    }
  }
}

export function renderFrame(g: GameState): string {
  const { cols, rows, laneW, roadL } = g
  const buf = ensureBuf(cols, rows)
  const c = g.retro ? R : D
  const roadR = roadRight(g)
  const sp = Math.floor(g.scrollPhase)

  // ── Background ─────────────────────────────────────────────────────────────
  // Grass
  fr(buf, 0, 0, rows - 1, cols - 1, cols, rows, 0x20, c.dot, c.grass)
  // Road
  fr(buf, 0, roadL, rows - 1, roadR, cols, rows, 0x20, T, c.road)

  // ── Trees in grass ─────────────────────────────────────────────────────────
  const treePositions = [1, 4, 7, 10, 13, 16, 19, 22]
  for (const tp of treePositions) {
    const rr = ((tp * 3 + sp * 2) % (rows - 2)) + 2
    if (rr >= 2 && rr < rows - 1) {
      // left tree
      sc(buf, Math.max(0, roadL - 2), rr, cols, rows, 0x2663, c.tree, c.grass)  // ♣
      // right tree
      sc(buf, Math.min(cols - 1, roadR + 2), rr, cols, rows, 0x2663, c.tree, c.grass)
    }
  }

  // ── Road edges ─────────────────────────────────────────────────────────────
  for (let row = 2; row < rows; row++) {
    sc(buf, roadL, row, cols, rows, 0x258C, c.edge, c.grass)   // ▌
    sc(buf, roadR, row, cols, rows, 0x2590, c.edge, c.grass)   // ▐
  }

  // ── Lane dividers (dashed, scroll) ─────────────────────────────────────────
  const div1 = roadL + 1 + laneW
  const div2 = roadL + 2 + laneW * 2
  for (let row = 2; row < rows; row++) {
    if ((row + sp) % 4 === 0) {
      sc(buf, div1, row, cols, rows, 0x2503, c.lane, c.road)  // ┃
      sc(buf, div2, row, cols, rows, 0x2503, c.lane, c.road)
    }
  }

  // ── Objects ────────────────────────────────────────────────────────────────
  for (const obj of g.objects) {
    if (obj.collected) continue
    const row = obj.row
    if (row < 2 || row >= rows) continue
    const cx = laneCenter(g, obj.lane)

    if (obj.kind === 'coin') {
      sc(buf, cx, row, cols, rows, 0x24, c.coin, c.road)           // $
    } else if (obj.kind === 'taskcoin') {
      sc(buf, cx - 1, row, cols, rows, 0x28, c.task, c.road)       // (
      sc(buf, cx,     row, cols, rows, 0x24, c.task, c.road)       // $
      sc(buf, cx + 1, row, cols, rows, 0x29, c.task, c.road)       // )
    } else if (obj.kind === 'barrier') {
      const lanes = (obj as RoadObj & { lanes?: (0|1|2)[] }).lanes ?? [obj.lane]
      for (const lane of lanes) {
        const x = laneCenter(g, lane)
        for (let dc = -Math.floor(laneW / 2); dc <= Math.floor(laneW / 2); dc++) {
          const c2 = ((x + dc) + Math.abs(dc)) % 2 === 0 ? c.obs : c.obsStripe
          sc(buf, x + dc, row, cols, rows, 0x259E, T, c2)          // ▞
        }
      }
    } else if (obj.kind === 'cone') {
      sc(buf, cx, row, cols, rows, 0x25B2, c.obs, c.road)          // ▲
    } else if (obj.kind === 'pothole') {
      sc(buf, cx - 1, row, cols, rows, 0x28, c.obs, c.road)
      sc(buf, cx,     row, cols, rows, 0x25C9, c.obs, c.road)      // ◉
      sc(buf, cx + 1, row, cols, rows, 0x29, c.obs, c.road)
    } else if (obj.kind === 'gate') {
      const perm = (obj as RoadObj & { perm?: number[] })['perm'] ?? [0, 1, 2]
      const gateColors = [c.gateA, c.gateB, c.gateC]
      for (const lane of [0, 1, 2] as const) {
        const optIdx = perm[lane] ?? lane
        const lx = laneCenter(g, lane)
        const lbl = ['A', 'B', 'C'][optIdx] ?? 'A'
        const q = g.activeQuiz
        const opt = q?.opts[optIdx] ?? ''
        const bg = gateColors[lane]!
        // Fill lane with gate color
        for (let dc = -Math.floor(laneW / 2); dc <= Math.floor(laneW / 2); dc++) {
          sc(buf, lx + dc, row, cols, rows, 0x20, T, bg)
        }
        // Write label
        const labelStr = lbl + ' ' + opt.slice(0, Math.min(opt.length, laneW - 3))
        sw(buf, lx - Math.floor(laneW / 2), row, cols, rows, labelStr, 0xFFFFFF, bg)
      }
      // Show question 3 rows above gate
      if (g.activeQuiz && row > 5) {
        const q = g.activeQuiz
        sw(buf, roadL + 1, row - 3, cols, rows, 'QUIZ  ' + q.q.slice(0, Math.min(q.q.length, roadR - roadL - 8)), c.quizHdr, c.dimRoad)
        sw(buf, roadL + 1, row - 2, cols, rows, '  A ' + q.opts[0] + '   B ' + q.opts[1] + '   C ' + q.opts[2], c.hud, c.dimRoad)
      }
    }
  }

  // ── Car ────────────────────────────────────────────────────────────────────
  const carDef = CARS.find(cd => cd.id === g.profile.currentCar) ?? CARS[0]!
  const carCol = Math.round(g.carX) - 2
  const carRow = rows - 3
  const shakeX = g.shakeTicks > 0 ? (g.tick % 2 === 0 ? 1 : -1) : 0
  const carFg = g.nitroTicks > 0 ? c.nitro : c.car
  for (let r = 0; r < 3; r++) {
    sw(buf, carCol + shakeX, carRow + r, cols, rows, carDef.art[r]!, carFg, c.road)
  }
  // Shield indicator
  if (g.shieldActive) {
    sc(buf, carCol - 1, carRow + 1, cols, rows, 0x25C6, c.shield, c.road)  // ◆

  }

  // ── HUD ────────────────────────────────────────────────────────────────────
  fr(buf, 0, 0, 1, cols - 1, cols, rows, 0x20, T, c.overlay)
  const { level, frac } = xpProgress(g.profile.xp)
  const dist = Math.floor(g.distance)
  const best = g.profile.bestDistance
  const bank = g.profile.bank

  // Row 0: title, distance, best, bank
  const r0 = ' ROAD TRIP' + '  ' + dist + ' m  · Best ' + best + ' m  · ' + String.fromCodePoint(0x25C9) + ' ' + bank
  sw(buf, 0, 0, cols, rows, r0.slice(0, cols), c.hud, c.overlay)
  // Nitro indicator
  if (g.nitroTicks > 0) sw(buf, cols - 8, 0, cols, rows, ' NITRO! ', c.nitro, c.overlay)

  // Row 1: level, XP bar, perk, car name
  const xpBar = Array.from({ length: 10 }, (_, i) =>
    i < Math.floor(frac * 10) ? String.fromCodePoint(0x25B0) : String.fromCodePoint(0x25B1)
  ).join('')  // ▰▱
  const carPerkStr = carDef.perk === 'none' ? '' : '  ' + String.fromCodePoint(0x25C6) + ' ' + capPerk(carDef.perk)
  const r1 = ' LV ' + level + ' ' + xpBar + carPerkStr + '  ' + carDef.name
  sw(buf, 0, 1, cols, rows, r1.slice(0, cols), c.hud, c.overlay)

  // ── Overlays ───────────────────────────────────────────────────────────────
  if (g.phase === 'countdown' && g.countdown > 0) {
    drawCentered(buf, Math.floor(rows / 2), g.countdown === 3 ? 'Get ready...' : g.countdown === 2 ? 'Get ready. 2' : 'Get ready. 1', cols, rows, c.nitro, c.overlay)
  }

  if (g.phase === 'flattire') {
    drawCentered(buf, Math.floor(rows / 2), 'Flat tire!  Respawning...', cols, rows, c.wrong, c.overlay)
  }

  if (g.phase === 'paused') {
    drawCentered(buf, Math.floor(rows / 2) - 1, '  PAUSED  ', cols, rows, c.hud, c.overlay)
    drawCentered(buf, Math.floor(rows / 2),      '  P resume  G garage  ', cols, rows, c.hud, c.overlay)
  }

  if (g.phase === 'arrived' && g.arrivedData) {
    const ad = g.arrivedData
    const mid = Math.floor(rows / 2)
    fr(buf, mid - 4, Math.floor(cols * 0.1), mid + 4, Math.floor(cols * 0.9), cols, rows, 0x20, T, c.overlay)
    drawCentered(buf, mid - 3, 'Arrived! Your AI employee finished the job', cols, rows, c.right, c.overlay)
    drawCentered(buf, mid - 1, dist + ' m   ' + String.fromCodePoint(0x25C9) + ' ' + ad.coins + ' coins   ' + ad.quizRight + ' quiz', cols, rows, c.hud, c.overlay)
    drawCentered(buf, mid,     'LV ' + level + '  Bank: ' + String.fromCodePoint(0x25C9) + ' ' + bank, cols, rows, c.hud, c.overlay)
    drawCentered(buf, mid + 2, '  A Keep Driving   G Garage   B Close  ', cols, rows, c.coin, c.overlay)
  }

  if (g.phase === 'garage') {
    drawGarage(buf, g, c, cols, rows)
  }

  return encodeB64(new Uint8Array(buf.buffer))
}

function drawCentered(buf: Uint32Array, row: number, text: string, cols: number, rows: number, fg: number, bg: number): void {
  const col = Math.max(0, Math.floor((cols - text.length) / 2))
  fr(buf, row, Math.max(0, col - 1), row, Math.min(cols - 1, col + text.length), cols, rows, 0x20, T, bg)
  sw(buf, col, row, cols, rows, text, fg, bg)
}

function drawGarage(buf: Uint32Array, g: GameState, c: typeof D | typeof R, cols: number, rows: number): void {
  const car = CARS[g.garagePage]!
  const mid = Math.floor(rows / 2)
  const level = levelFromXp(g.profile.xp)
  const owned = g.profile.ownedCars.includes(car.id)
  const driving = g.profile.currentCar === car.id
  const locked = level < car.levelReq
  const canAfford = g.profile.bank >= car.price

  fr(buf, mid - 5, 2, mid + 5, cols - 3, cols, rows, 0x20, T, c.overlay)
  drawCentered(buf, mid - 5, '  GARAGE  ' + (g.garagePage + 1) + '/' + CARS.length, cols, rows, c.coin, c.overlay)

  // Car art centered
  const artCol = Math.floor((cols - 5) / 2)
  for (let r = 0; r < 3; r++) {
    sw(buf, artCol, mid - 3 + r, cols, rows, car.art[r]!, c.car, c.overlay)
  }

  drawCentered(buf, mid, car.name, cols, rows, c.hud, c.overlay)
  drawCentered(buf, mid + 1, car.flavor.slice(0, cols - 4), cols, rows, c.hud, c.overlay)

  let status: string
  if (driving) status = 'Driving this one'
  else if (owned) status = 'Owned  B to drive'
  else if (locked) status = 'Locked  reach LV ' + car.levelReq
  else if (!canAfford) status = String.fromCodePoint(0x25C9) + ' ' + car.price + '  you have ' + g.profile.bank
  else status = 'B to buy for ' + String.fromCodePoint(0x25C9) + ' ' + car.price
  drawCentered(buf, mid + 2, status, cols, rows, locked ? c.wrong : (owned || driving) ? c.right : c.coin, c.overlay)
  drawCentered(buf, mid + 4, '  A prev   D next   B select   P/G back  ', cols, rows, c.hud, c.overlay)
}

function capPerk(p: Perk): string {
  const map: Record<Perk, string> = { none: '', magnet: 'Magnet', shield: 'Shield', doublecoin: '2x Coins', all: 'All' }
  return map[p]
}
