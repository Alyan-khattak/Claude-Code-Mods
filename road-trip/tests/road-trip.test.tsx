import { describe, expect, test } from 'claude-code/testing'
import {
  createGame, tickGame, hitObstacle, garageBuy, triggerArrived, resumeFromArrived,
  parseProfile, laneCenter, renderFrame,
  type GameState, type Profile, type RoadObj,
} from '../hooks/road-trip-game'
import { CARS } from '../hooks/road-trip-art'

const BASE_PROFILE: Profile = {
  bank: 500, ownedCars: ['hatch'], currentCar: 'hatch', xp: 0, bestDistance: 0,
}

function makeGame(profile: Partial<Profile> = {}, cols = 80, rows = 24): GameState {
  return createGame(cols, rows, { ...BASE_PROFILE, ...profile }, false)
}

function skipCountdown(g: GameState): void {
  g.phase = 'driving'
  g.countdown = 0
}

// ─── Test 1: countdown then drives, distance grows ───────────────────────────

describe('game start', () => {
  test('countdown ticks to GO then distance increases', async () => {
    const g = makeGame()
    expect(g.phase).toBe('countdown')
    expect(g.countdown).toBe(3)

    // Skip countdown
    skipCountdown(g)
    const d0 = g.distance

    // Tick several frames
    for (let i = 0; i < 10; i++) tickGame(g)

    expect(g.phase).toBe('driving')
    expect(g.distance).toBeGreaterThan(d0)
  })
})

// ─── Test 2: obstacle → flat tire; Agency Wagon absorbs first hit ─────────────

describe('obstacle collision', () => {
  test('hatch gets flat tire on barrier', async () => {
    const g = makeGame()
    skipCountdown(g)
    // Place a barrier directly on the car
    const cx = laneCenter(g, 1)
    g.carX = cx
    g.carLane = 1
    g.carTargetLane = 1
    const barrier: RoadObj = { id: 99, kind: 'barrier', row: g.rows - 3, lane: 1, lanes: [1], collected: false }
    g.objects.push(barrier)

    tickGame(g)
    expect(g.phase).toBe('flattire')
  })

  test('Agency Wagon absorbs first hit', async () => {
    const profile: Partial<Profile> = {
      bank: 500, ownedCars: ['hatch', 'wagon'], currentCar: 'wagon',
    }
    const g = makeGame(profile)
    skipCountdown(g)
    expect(g.shieldActive).toBe(true)

    const cx = laneCenter(g, 1)
    g.carX = cx
    g.carLane = 1
    g.carTargetLane = 1
    const barrier: RoadObj = { id: 99, kind: 'barrier', row: g.rows - 3, lane: 1, lanes: [1], collected: false }
    g.objects.push(barrier)

    tickGame(g)
    expect(g.phase).toBe('driving')
    expect(g.shieldActive).toBe(false)
  })
})

// ─── Test 3: coins add to bank; Founder GT doubles ──────────────────────────

describe('coin collection', () => {
  test('hatch: coin adds 1 to bank', async () => {
    const g = makeGame({ bank: 0 })
    skipCountdown(g)
    const cx = laneCenter(g, 1)
    g.carX = cx; g.carLane = 1; g.carTargetLane = 1
    g.objects.push({ id: 1, kind: 'coin', row: g.rows - 3, lane: 1, collected: false })
    tickGame(g)
    expect(g.profile.bank).toBe(1)
  })

  test('Founder GT: coin adds 2', async () => {
    const profile: Partial<Profile> = {
      bank: 450, ownedCars: ['hatch', 'gt'], currentCar: 'gt', xp: 5000,
    }
    const g = makeGame(profile)
    skipCountdown(g)
    const cx = laneCenter(g, 1)
    g.carX = cx; g.carLane = 1; g.carTargetLane = 1
    g.objects.push({ id: 1, kind: 'coin', row: g.rows - 3, lane: 1, collected: false })
    const before = g.profile.bank
    tickGame(g)
    expect(g.profile.bank).toBe(before + 2)
  })
})

// ─── Test 4: task coin worth 10 ──────────────────────────────────────────────

describe('task coins', () => {
  test('task coin adds 10 to bank', async () => {
    const g = makeGame({ bank: 0 })
    skipCountdown(g)
    const cx = laneCenter(g, 0)
    g.carX = cx; g.carLane = 0; g.carTargetLane = 0
    g.objects.push({ id: 1, kind: 'taskcoin', row: g.rows - 3, lane: 0, collected: false })
    tickGame(g)
    expect(g.profile.bank).toBe(10)
  })
})

// ─── Test 5: quiz correct lane gives coins + nitro ───────────────────────────

describe('quiz gate', () => {
  test('correct lane awards coins and nitro', async () => {
    const g = makeGame({ bank: 0 })
    skipCountdown(g)
    g.activeQuiz = { q: 'Test?', opts: ['A', 'B', 'C'], correct: 0 }
    // Gate with correct lane = 1
    const gate: RoadObj = { id: 1, kind: 'gate', row: g.rows - 3, lane: 1, collected: false }
    ;(gate as RoadObj & { perm: number[] })['perm'] = [0, 1, 2]  // opt 0 in lane 1 = not correct...
    // Correct lane = lane where perm[lane] === correct opt idx = 0, so lane 0
    // Redefine: gate.lane = correct lane = 0
    gate.lane = 0
    ;(gate as RoadObj & { perm: number[] })['perm'] = [0, 1, 2]
    g.objects.push(gate)
    g.carX = laneCenter(g, 0)
    g.carLane = 0; g.carTargetLane = 0

    const bankBefore = g.profile.bank
    tickGame(g)

    expect(g.profile.bank).toBeGreaterThan(bankBefore)
    expect(g.nitroTicks).toBeGreaterThan(0)
  })

  test('wrong lane gives nothing', async () => {
    const g = makeGame({ bank: 0 })
    skipCountdown(g)
    g.activeQuiz = { q: 'Test?', opts: ['A', 'B', 'C'], correct: 0 }
    const gate: RoadObj = { id: 1, kind: 'gate', row: g.rows - 3, lane: 0, collected: false }  // correct = lane 0
    ;(gate as RoadObj & { perm: number[] })['perm'] = [0, 1, 2]
    g.objects.push(gate)
    g.carX = laneCenter(g, 2)  // drive wrong lane
    g.carLane = 2; g.carTargetLane = 2

    const bankBefore = g.profile.bank
    tickGame(g)

    expect(g.profile.bank).toBe(bankBefore)
    expect(g.nitroTicks).toBe(0)
  })
})

// ─── Test 6: buy car deducts coins; locked/unaffordable blocked ───────────────

describe('garage buy', () => {
  test('buy Side Hustle Coupe deducts coins', async () => {
    const g = makeGame({ bank: 200, xp: 500 })  // level 2
    g.garagePage = CARS.findIndex(c => c.id === 'coupe')
    const result = garageBuy(g)
    expect(result).toBe('ok')
    expect(g.profile.bank).toBe(140)  // 200 - 60
    expect(g.profile.ownedCars).toContain('coupe')
    expect(g.profile.currentCar).toBe('coupe')
  })

  test('locked car cannot be bought', async () => {
    const g = makeGame({ bank: 10000, xp: 0 })  // level 1
    g.garagePage = CARS.findIndex(c => c.id === 'hyper')  // needs level 8
    const result = garageBuy(g)
    expect(result).toBe('locked')
    expect(g.profile.bank).toBe(10000)
  })

  test('unaffordable car cannot be bought', async () => {
    const g = makeGame({ bank: 10, xp: 500 })  // level 2
    g.garagePage = CARS.findIndex(c => c.id === 'coupe')  // costs 60
    const result = garageBuy(g)
    expect(result).toBe('poor')
    expect(g.profile.bank).toBe(10)
  })
})

// ─── Test 7: turn.complete → arrived; turn.start → resume ────────────────────

describe('arrived card', () => {
  test('triggerArrived sets phase to arrived with data', async () => {
    const g = makeGame()
    skipCountdown(g)
    for (let i = 0; i < 5; i++) tickGame(g)

    triggerArrived(g)
    expect(g.phase).toBe('arrived')
    expect(g.arrivedData).not.toBeNull()
    expect(g.arrivedData!.distance).toBeGreaterThanOrEqual(0)
  })

  test('resumeFromArrived starts a new countdown', async () => {
    const g = makeGame()
    skipCountdown(g)
    triggerArrived(g)
    resumeFromArrived(g)
    expect(g.phase).toBe('countdown')
    expect(g.distance).toBe(0)
  })
})

// ─── Test 8: broken profile loads cleanly ────────────────────────────────────

describe('profile parsing', () => {
  test('unknown car removed, bank clamped, hatch always owned', async () => {
    const broken = {
      bank: -100,
      ownedCars: ['hatch', 'nonexistent_car', 'wagon'],
      currentCar: 'nonexistent_car',
      xp: -50,
      bestDistance: 0,
    }
    const p = parseProfile(broken)
    expect(p.bank).toBe(0)
    expect(p.ownedCars).not.toContain('nonexistent_car')
    expect(p.ownedCars).toContain('hatch')
    expect(p.ownedCars).toContain('wagon')
    expect(p.currentCar).toBe('hatch')  // nonexistent_car removed, falls back to hatch
    expect(p.xp).toBe(0)
  })
})

// ─── Test 9: renderFrame produces a non-empty string ─────────────────────────

describe('renderer', () => {
  test('renderFrame produces valid base64 cells string', async () => {
    const g = makeGame()
    const cells = renderFrame(g)
    expect(cells.length).toBeGreaterThan(0)
    // Valid base64: only allowed chars
    expect(/^[A-Za-z0-9+/]+=*$/.test(cells)).toBe(true)
    // Length = ceil(cols * rows * 12 / 3) * 4
    const expected = Math.ceil((80 * 24 * 12) / 3) * 4
    expect(cells.length).toBe(expected)
  })
})
