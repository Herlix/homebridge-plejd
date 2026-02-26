# homebridge-plejd Architecture Reference

Technical reference for the homebridge-plejd codebase. Intended for LLMs and developers who need to understand, modify, or extend the plugin.

Version 1.7.5 | February 2026

---

## Quick Reference

```bash
npm run build      # TypeScript to dist/
npm test           # Jest tests (--detectOpenHandles --forceExit)
npm run lint       # ESLint, zero warnings policy
npm run dev        # Build + link + nodemon
```

- **Runtime entry**: `dist/index.js`
- **Language**: TypeScript, ES2022 target, ESM (`"type": "module"`)
- **Imports**: Must use `.js` extensions (ESM requirement)
- **Strict mode**: Enabled
- **BLE dependency**: `@abandonware/noble`
- **Homebridge**: `^1.8.0 || ^2.0.0-beta.0`
- **Node**: `^18 || ^20 || ^22 || ^24`

---

## File Map

| File | Lines | Purpose |
|------|-------|---------|
| `src/index.ts` | 12 | Plugin registration — calls `api.registerPlatform()` |
| `src/constants.ts` | 13 | Platform/plugin names and timing constants |
| `src/utils.ts` | 89 | Crypto (AES-128-ECB XOR cipher, challenge-response), delay, withRetry, race |
| `src/plejdApi.ts` | 153 | Cloud API client: login, getSites, getSite |
| `src/plejdService.ts` | 810 | Core BLE: scanning, connecting, auth, command queue, ping, notifications, blacklisting |
| `src/PlejdHbPlatform.ts` | 381 | Homebridge DynamicPlatformPlugin: config loading, device/scene discovery, update routing |
| `src/PlejdHbAccessory.ts` | 149 | Device accessory: HomeKit get/set for On and Brightness |
| `src/PlejdHbSceneAccessory.ts` | 85 | Scene accessory: HomeKit Switch with 1s auto-reset |
| `src/model/device.ts` | 10 | `Device` interface |
| `src/model/scene.ts` | 7 | `Scene` interface |
| `src/model/userInputConfig.ts` | 8 | `UserInputConfig` interface (devices + scenes + cryptoKey) |
| `src/model/plejdSite.ts` | 507 | Full `Site` type tree from Plejd cloud API (auto-generated) |
| `tests/plejdService.spec.ts` | 140 | BLE service queue and brightness transition tests |
| `tests/utils.spec.ts` | 317 | Crypto, delay, race, withRetry tests |

---

## Dependency Graph

```
index.ts
  └─ PlejdHbPlatform.ts
       ├─ PlejdHbAccessory.ts ──── model/device.ts
       ├─ PlejdHbSceneAccessory.ts ── model/scene.ts
       ├─ plejdService.ts ── model/userInputConfig.ts ── model/device.ts, model/scene.ts
       │    ├─ utils.ts
       │    └─ constants.ts
       ├─ plejdApi.ts ── model/plejdSite.ts
       └─ constants.ts
```

---

## Data Flow

### Outbound: HomeKit to Physical Device

```
HomeKit SET event
  → PlejdHbAccessory.setOn() / .setBrightness()     [PlejdHbAccessory.ts:116-146]
  → PlejdService.updateState()                        [plejdService.ts:93-153]
  → Buffer pushed to sendQueue via unshift()
  → Queue processor pops every 50ms                   [plejdService.ts:425-456]
  → plejdEncodeDecode() encrypts payload               [utils.ts:58-81]
  → dataChar.writeAsync() via withRetry+race
  → BLE mesh → physical Plejd device
```

### Inbound: Physical Device to HomeKit

```
Physical device state change / button press
  → BLE notification on LastData characteristic
  → handleNotification()                               [plejdService.ts:512-608]
  → plejdEncodeDecode() decrypts payload                [utils.ts:58-81]
  → Parse device_id, command, state, brightness
  → onUpdate() callback
  → PlejdHbPlatform.onPlejdUpdates()                   [PlejdHbPlatform.ts:324-376]
  → Find matching accessory by identifier
  → Update HomeKit characteristics
  → PlejdHbAccessory.onPlejdUpdates()                  [PlejdHbAccessory.ts:96-114]
```

---

## Core Data Types

### Device (`src/model/device.ts`)

```typescript
interface Device {
  name: string;
  model: string;
  identifier: number;            // Plejd mesh address (1 byte, 0-255)
  outputType: "LIGHT" | "RELAY"; // Determines HomeKit service type
  uuid: string;                  // Generated via hap.uuid.generate(identifier.toString())
  room?: string;
  hidden: boolean;
  plejdDeviceId: string;         // Hardware MAC address (used for BLE matching)
}
```

### Scene (`src/model/scene.ts`)

```typescript
interface Scene {
  name: string;
  sceneIndex: number;  // Protocol-level index (from site.sceneIndex map)
  sceneId: string;     // Cloud API identifier
  uuid: string;
  hidden: boolean;
}
```

### UserInputConfig (`src/model/userInputConfig.ts`)

```typescript
interface UserInputConfig {
  devices: Device[];
  scenes: Scene[];
  cryptoKey: Buffer;  // 16-byte AES key (hex string stripped of dashes → Buffer.from(hex, "hex"))
}
```

### DeviceState (inline in `PlejdHbAccessory.ts:7-11`)

```typescript
interface DeviceState {
  isOn: boolean;
  brightness: number;     // 0-100 (HomeKit scale), NOT 0-255 (Plejd scale)
  transitionMs: number;
}
```

### Site — Key Fields Used (`src/model/plejdSite.ts`)

The full `Site` type is 507 lines (auto-generated). Only these fields are used at runtime:

| Field | Type | Purpose |
|-------|------|---------|
| `plejdMesh.cryptoKey` | `string` | Hex-encoded AES-128 encryption key |
| `devices[]` | Array | Device list with `deviceId`, `title`, `outputType`, `roomId` |
| `plejdDevices[]` | Array | Hardware details with `firmware.notes` (model name) |
| `rooms[]` | Array | Room metadata (`roomId`, `title`) |
| `scenes[]` | Array | Scene definitions (`sceneId`, `title`, `hiddenFromSceneList`) |
| `outputAddress` | Object | Maps `deviceId → { "0": meshAddress, "1"?: meshAddress }` |
| `sceneIndex` | Object | Maps `sceneId → numeric scene index` |

---

## BLE Protocol

### Service and Characteristic UUIDs

All share the suffix `60854726be45040c957391b5`:

| Name | Full UUID | Purpose |
|------|-----------|---------|
| Service | `31ba000160854726be45040c957391b5` | Main Plejd BLE service (scan filter) |
| LightLevel | `31ba000360854726be45040c957391b5` | Light level data (unused) |
| Data | `31ba000460854726be45040c957391b5` | Write channel for commands |
| LastData | `31ba000560854726be45040c957391b5` | Notification channel (subscribe for updates) |
| Auth | `31ba000960854726be45040c957391b5` | Authentication handshake |
| Ping | `31ba000a60854726be45040c957391b5` | Keep-alive ping/pong |

Note: The Data characteristic is retrieved via `peripheral.services[0].characteristics` (line 405-408) rather than from the discovery result. This is a known quirk.

### Command Codes (`plejdService.ts:32-42`)

```typescript
enum PlejdCommand {
  OnOffState      = "0097",  // Turn on/off
  StateBrightness = "00c8",  // State with brightness (inbound)
  Brightness      = "0098",  // Set brightness 0-255 (outbound)
  Scene           = "0021",  // Trigger scene
  Time            = "001b",  // Time sync (inbound)
  RequestResponse   = "0102",  // Request type: with response
  RequestNoResponse = "0110",  // Request type: without response (used for commands)
  RequestReadValue  = "0103",  // Request type: read value
  ButtonClick     = "0006",  // Physical button event (inbound)
}
```

### Payload Format

```
[device_id:1byte] [request_type:2bytes] [command:2bytes] [data:variable]
```

#### Example: Turn on device 5

```
Plaintext: 05 0110 0097 01
           │  │    │    └── 01 = on (00 = off)
           │  │    └─────── 0097 = OnOffState
           │  └──────────── 0110 = RequestNoResponse
           └─────────────── 05 = device identifier (hex)
```

#### Example: Set brightness to 50% on device 10

```
Plaintext: 0a 0110 0098 01 80 80
           │  │    │    │  │  └── brightness repeated (Plejd protocol)
           │  │    │    │  └───── 0x80 = 128/255 ≈ 50%
           │  │    │    └──────── 01 = state on
           │  │    └───────────── 0098 = Brightness
           │  └────────────────── 0110 = RequestNoResponse
           └───────────────────── 0a = device 10
```

#### Example: Trigger scene index 3

```
Plaintext: 00 0110 0021 03
           │  │    │    └── 03 = scene index
           │  │    └─────── 0021 = Scene
           │  └──────────── 0110 = RequestNoResponse
           └─────────────── 00 = broadcast address
```

### Brightness Scaling

- **Outbound** (HomeKit → Plejd): `eightBit = Math.round(percent * 2.55)` where percent is 0-100
- **Inbound** (Plejd → HomeKit): `percent = (100 / 255) * rawByte`, or `1` if rawByte is `0` (avoids 0% while light is "on")
- The brightness byte is sent twice in the payload (Plejd protocol convention)

### Encryption / Decryption (`utils.ts:58-81`)

AES-128-ECB used as a stream cipher via XOR:

1. Take the connected device's MAC address (6 bytes), reversed byte order
2. Build 16-byte address buffer: `[addr(6) | addr(6) | addr(0:4)]`
3. Encrypt address buffer with AES-128-ECB using site crypto key → 16-byte keystream
4. XOR keystream with payload, cycling every 16 bytes (`data[i] ^ keystream[i % 16]`)

The function is its own inverse: applying it twice returns the original data.

```typescript
// utils.ts:58-81
export const plejdEncodeDecode = (key: Buffer, addressBuffer: Buffer, data: Buffer): Buffer => {
  const buf = Buffer.concat([addressBuffer, addressBuffer, addressBuffer.subarray(0, 4)]);
  const cipher = createCipheriv("aes-128-ecb", key, "");
  cipher.setAutoPadding(false);
  let ct = cipher.update(buf).toString("hex");
  ct += cipher.final().toString("hex");
  const ctBuff = Buffer.from(ct, "hex");
  let output = "";
  for (let i = 0, length = data.length; i < length; i++) {
    output += String.fromCharCode(data[i] ^ ctBuff[i % 16]);
  }
  return Buffer.from(output, "ascii");
};
```

### Authentication Flow (`plejdService.ts:647-673`, `utils.ts:49-56`)

1. Write `Buffer.from([0x00])` to Auth characteristic
2. Wait 100ms
3. Read Auth characteristic → 16-byte challenge
4. Wait 100ms
5. Compute response: `SHA256(XOR(cryptoKey, challenge))` → 32 bytes → split into two 16-byte halves → XOR them → 16-byte response
6. Write response to Auth characteristic
7. Wait 100ms
8. `isAuthenticated = true`

```typescript
// utils.ts:49-56
export const plejdChallageResp = (key: Buffer, chal: Buffer) => {
  const intermediate = createHash("sha256").update(xor(key, chal)).digest();
  const part1 = Buffer.from(intermediate.subarray(0, 16));
  const part2 = Buffer.from(intermediate.subarray(16));
  return xor(part1, part2);
};
```

---

## Connection Lifecycle

### Startup Sequence

```
Homebridge launches
  → index.ts registers PlejdHbPlatform
  → Constructor stores config, listens for 'didFinishLaunching'
  → configurePlejd() fires                              [PlejdHbPlatform.ts:52-79]
       → Cloud mode: PlejdRemoteApi.getPlejdRemoteSite()
       → Manual mode: uses config.devices + config.crypto_key directly
  → configureDevices()                                   [PlejdHbPlatform.ts:81-212]
       → Merge cloud devices with manual overrides
       → Filter to LIGHT and RELAY outputTypes
       → Create PlejdService with crypto key
       → plejdService.configureBLE()                     [plejdService.ts:171-177]
            → Start blacklist cleanup interval (5 min)
            → noble.on('stateChange') → tryStartScanning()
  → discoverDevices() + discoverScenes()
       → Match to cached accessories or register new ones
       → Unregister stale accessories no longer in config
```

### Scanning and Discovery (`plejdService.ts:675-718`)

1. Call `cleanup()` to reset all state
2. Stop any active scanning
3. Check `noble._state === 'poweredOn'`
4. Clean expired blacklist entries
5. Wait 5 seconds (let BLE stack stabilize)
6. Start scanning for Plejd service UUID (`allowDuplicates=false`)
7. On each `discover` event: validate device via `isSuitableDeviceAddress()`
8. 30-second timeout: if no device authenticated, restart scan
9. On scan failure: wait 10s, retry

### Device Validation (`plejdService.ts:235-280`)

Each discovered peripheral goes through these checks in order:

1. **MAC extraction** — extract address via `extractAddress()` (see MAC Address Resolution below)
2. **Blacklist check** — skip if device identifier is blacklisted (uses MAC if available, falls back to manufacturer data bytes 12-17 or peripheral UUID)
3. **Config match** — if MAC was extracted, it must exist in `config.devices[].plejdDeviceId`; blacklist if not found. If no MAC, proceed with `PROBE_NEEDED`.
4. **Signal strength** — `peripheral.rssi >= -90` dB; blacklist if too weak
5. **Connection mutex** — skip if `isConnecting` is already true

### Connection with Retry (`plejdService.ts:282-352`)

- Mutex via `isConnecting` flag (set in `finally`)
- Up to 3 retries with 2-second delays between attempts
- On successful connect:
  - Register disconnect handler (cleanup → wait 5s → rescan)
  - Discover characteristics
  - Authenticate (challenge-response)
  - Setup communication (ping, queue, notifications)
- On all retries exhausted: `noble.reset()` and restart scanning

### Communication Setup (`plejdService.ts:610-645`)

1. Build address buffer from connected device MAC (reversed, 6 bytes)
2. Start ping keep-alive (3-second interval)
3. Start queue processor (50ms interval)
4. Subscribe to LastData characteristic notifications
5. On subscription failure: blacklist device and disconnect

### MAC Address Resolution (`plejdService.ts:187-253`)

The connected device's MAC address is needed for BLE payload encryption — using the wrong MAC means garbled data. Extracting the MAC varies by platform:

#### Extraction Strategies (`extractAddress()`)

Tried in order:

1. **`peripheral.address`** (Linux) — noble exposes the MAC directly
2. **Manufacturer data bytes 6-11 reversed** (macOS) — Plejd advertisements include a MAC in the manufacturer data, but it may be the advertising device's own MAC **or a relayed device's MAC** from the mesh. The code only accepts it if it matches a configured device's `plejdDeviceId`.
3. **Single-device fallback** — if only one device is configured, assume it's that device

If none of these succeed, `isSuitableDeviceAddress()` returns `PROBE_NEEDED` instead of a MAC.

#### Probing Fallback (`probeDeviceAddress()`)

On macOS, manufacturer data bytes 6-11 are unreliable because the Plejd mesh relays advertisements between devices — the MAC in the advertisement may belong to a different device than the one actually advertising. When `extractAddress()` returns null, the plugin connects first and then probes:

1. Subscribe to the LastData (notification) characteristic
2. Listen for mesh traffic (up to 30 seconds)
3. For each incoming notification, try decrypting with every configured device's MAC as the address buffer
4. A successful decrypt (one that yields a recognized `PlejdCommand` code at bytes 3-5) identifies the correct MAC
5. Use that MAC for all subsequent encryption/decryption

This works because encryption depends on the connected device's MAC — only the correct MAC produces valid command codes after decryption.

#### Limitation

Even when manufacturer data *does* match a known device, it could theoretically be a relayed MAC rather than the advertising device's own. This is a known limitation — the probe mechanism only activates when no MAC is found at all.

### Disconnection and Reconnection

- **Planned disconnect** (from ping failure): blacklist + disconnect + rescan
- **Unexpected disconnect** (BLE event): cleanup → wait 5s → rescan
- **`cleanup()`** (`plejdService.ts`): stops ping, stops queue processor, clears send queue, removes discover handler, resets `isAuthenticated`, resets `deviceState`, clears `deviceAddress`. Note: blacklist cleanup interval is **not** cleared — it runs for the lifetime of the service to survive reconnections.

---

## Queue-Based Command System

### Why a Queue

BLE write operations are slow and can fail. HomeKit can send multiple commands in rapid succession (e.g., brightness slider drag). The queue decouples command generation from transmission, ensuring reliable delivery.

### Queue Mechanics (`plejdService.ts:425-456`)

- **Add**: `sendQueue.unshift(buffer)` (pushes to front)
- **Remove**: `sendQueue.pop()` (takes from back)
- This creates **FIFO** behavior (first queued = first sent)
- **Interval**: Every 50ms (`PLEJD_WRITE_TIMEOUT`), one command is popped, encrypted, and written
- **Failed writes**: Re-queued at front via `unshift()` for immediate retry
- **Write retry**: Each BLE write wraps in `withRetry(3 attempts) → race(5s timeout)`

### Brightness Transitions (`plejdService.ts:93-153`)

When `transitionMs > 0`, a brightness change is split into interpolated steps:

1. `steps = Math.round(transitionMs / PLEJD_WRITE_TIMEOUT)`
2. For each step: `brightness = start + (difference * step / steps)`
3. Clamp to 0-100, convert to 0-255 via `Math.round(percent * 2.55)`
4. Before queuing new steps, **filter out** any existing brightness commands for the same device (prevents stale commands from clogging the queue)

### Turn Off Shortcut

If `turnOn=false`, or `targetBrightness` is 0 or undefined: a single `OnOffState` command is queued instead of brightness commands.

---

## Device Blacklisting (`plejdService.ts:728-785`)

Prevents retry storms when a device repeatedly fails.

### Data Structure

```typescript
Map<string, { until: number; attempts: number }>
```

### Duration Progression

| Attempts | Base Duration | Actual Duration |
|----------|---------------|-----------------|
| 1 | 5 min | 5 min |
| 2 | 5 min | 10 min |
| 3 | 5 min | 20 min |
| 4 | 5 min | 40 min |
| 5 | 30 min | 30 min |
| 6 | 30 min | 60 min |
| 7 | 30 min | 120 min |
| ... | 30 min | ... |
| max | 30 min | 24 hours (cap) |

Formula: `min(baseTime * 2^(attempts-1), 24h)` where baseTime is 5min for attempts < 5, 30min for attempts >= 5.

### Blacklist Triggers

- MAC extraction failure
- Device not in configured list
- Weak signal (RSSI < -90 dB)
- Authentication failure
- Communication setup failure (subscription)
- 3 consecutive ping failures

### Cleanup

Every 5 minutes, expired entries are removed (`startBlacklistCleanup` at line 774).

---

## Keep-Alive Ping (`plejdService.ts:465-503`)

- **Interval**: Every 3 seconds (`PLEJD_PING_TIMEOUT`)
- **Protocol**: Write 1 random byte → read response → validate `pong === (ping + 1) & 0xFF`
- **Failure tracking**: `consecutivePingFailures` counter
- **Success**: Resets counter to 0, updates `lastPingSuccess` timestamp
- **3 consecutive failures**: Blacklists device, stops ping, disconnects, restarts scanning

---

## Cloud API (`src/plejdApi.ts`)

### Base URL

`https://cloud.plejd.com/parse/`

### Common Headers

```
X-Parse-Application-Id: zHtVqXt8k4yFyk2QGmgp48D9xZr2G94xWYnF4dak
Content-Type: application/json
```

### Endpoints

| Step | Method | Path | Body | Returns |
|------|--------|------|------|---------|
| 1. Login | POST | `login` | `{username, password}` | `sessionToken` |
| 2. List Sites | POST | `functions/getSiteList` | (none) | Array of `SiteDto` |
| 3. Get Site | POST | `functions/getSiteById` | `{siteId}` | Full `Site` object |

After login, all requests also include `X-Parse-Session-Token` header.

### Device Resolution in configureDevices (`PlejdHbPlatform.ts:81-212`)

1. Start with manually configured devices (from config JSON)
2. For each cloud device, look up mesh address from `site.outputAddress[deviceId]["0"]`
3. For dual-output devices (e.g., DIM-01-2P), if output "0" is already taken by a manually configured device, use output "1"
4. Manual devices override cloud devices (matching by `identifier`)
5. Hidden devices are skipped
6. Devices without `LIGHT` or `RELAY` outputType are filtered out (e.g., WMS-01)
7. Devices missing `outputType` default to `"LIGHT"` with a warning

---

## HomeKit Service Mapping

### Device Accessories (`PlejdHbAccessory.ts`)

| outputType | HomeKit Service | Characteristics |
|------------|----------------|-----------------|
| `LIGHT` | Lightbulb | On (get/set), Brightness (get/set) |
| `RELAY` | Switch | On (get/set) |

When a device type changes between runs (e.g., RELAY → LIGHT due to cloud config update), stale services are detected and removed (lines 47-82).

**Accessory Info**: Manufacturer="Plejd", Model=`device.model`, SerialNumber=`device.identifier`

### Scene Accessories (`PlejdHbSceneAccessory.ts`)

- Exposed as HomeKit `Switch` service
- `setOn(true)` → calls `plejdService.triggerScene(sceneIndex)`
- Auto-resets to OFF after 1000ms (`SCENE_RESET_DELAY_MS`)
- `setOn(false)` → just updates internal state (no BLE command)

**Accessory Info**: Manufacturer="Plejd", Model="Plejd Scene", SerialNumber=`scene-{sceneIndex}`

---

## Notification Handling (`plejdService.ts:512-608`)

### Parsing

1. Validate minimum 5 bytes
2. Decrypt with `plejdEncodeDecode()`
3. `id = decodedData[0]` — device mesh address
4. `command = bytes 3-5` as hex string
5. `isOn = byte 5 === 0x01` (if payload long enough)

### Command-Specific Handling

| Command | Parsing | Callback |
|---------|---------|----------|
| `Time` (001b) | 4-byte LE unix timestamp at bytes 5-9 | Log only |
| `Brightness` (0098) / `StateBrightness` (00c8) | Dim byte at position 7; convert to 1-100% | `onUpdate(id, isOn, brightness)` |
| `OnOffState` (0097) / `Scene` (0021) / `ButtonClick` (0006) | None | `onUpdate(id, isOn)` |
| `RequestResponse` / `RequestNoResponse` / `RequestReadValue` | None | `onUpdate(id, isOn)` |
| Unknown | None | `onUpdate(id, isOn)` + warn log |

---

## Configuration

### Cloud Mode (recommended)

```json
{
  "platform": "Plejd",
  "username": "user@example.com",
  "password": "yourpassword",
  "site": "Home",
  "transition_ms": 500
}
```

Requires all three: `username`, `password`, `site`.

### Manual Mode

```json
{
  "platform": "Plejd",
  "crypto_key": "0123456789abcdef0123456789abcdef",
  "devices": [
    {
      "name": "Kitchen Light",
      "model": "DIM-02",
      "identifier": 11,
      "type": "Light"
    }
  ]
}
```

Requires `crypto_key` and `devices`. The crypto key can include dashes (stripped with `.replace(/-/g, "")`).

### Known Device Models (from config.schema.json)

DIM-01, DIM-02, LED-10, LED-75, JAL-01, DIM-01-2P, REL-01, REL-02, REL-01-2P, DAL-01, SPR-01, SPD-01, CTR-01, DWN-01, DWN-02, CCL-01, OUT-01, OUT-02, LST-01

---

## Timing Constants

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `PLEJD_WRITE_TIMEOUT` | 50ms | constants.ts:11 | Queue processor interval; gap between BLE writes |
| `PLEJD_PING_TIMEOUT` | 3000ms | constants.ts:12 | Ping interval |
| `DEFAULT_BRIGHTNESS_TRANSITION_MS` | 0ms | constants.ts:13 | Default transition (instant) |
| `SCENE_RESET_DELAY_MS` | 1000ms | PlejdHbSceneAccessory.ts:7 | Scene switch auto-off delay |
| Scan delay | 5000ms | plejdService.ts:682 | Delay before scanning after power-on |
| Auth step delay | 100ms | plejdService.ts:658-664 | Between auth characteristic operations |
| Connection retry delay | 2000ms | plejdService.ts:299 | Between connection retries |
| Post-disconnect delay | 5000ms | plejdService.ts:314 | Before rescanning after disconnect |
| Scan timeout | 30000ms | plejdService.ts:694-701 | Restart scan if no device found |
| Scan failure retry delay | 10000ms | plejdService.ts:715 | Before retrying failed scan |
| BLE operation timeout | 5000ms | utils.ts:39 | Default `race()` timeout |
| withRetry defaults | 3 retries, 100ms | utils.ts:15 | Default retry parameters |
| Blacklist cleanup | 5 min | plejdService.ts:779-784 | Expired entry cleanup interval |
| RSSI threshold | -90 dB | plejdService.ts:262 | Minimum signal strength |
| Max consecutive ping failures | 3 | plejdService.ts:493 | Triggers reconnect |
| Max connection retries | 3 | plejdService.ts:293 | Connection attempts before reset |

---

## Testing

### Infrastructure

- Jest with `ts-jest` preset
- ESM: `extensionsToTreatAsEsm: [".ts"]`
- Module name mapper strips `.js` from imports
- Run: `npm test` (adds `--detectOpenHandles --forceExit`)

### Coverage

| Source File | Test File | Covered | Not Covered |
|-------------|-----------|---------|-------------|
| `plejdService.ts` | `tests/plejdService.spec.ts` | updateState queue behavior, brightness transitions, on/off payloads | BLE connection, scanning, notifications, blacklisting |
| `utils.ts` | `tests/utils.spec.ts` | plejdChalResp, plejdEncodeDecode, delay, race, withRetry | Fully covered |
| `PlejdHbPlatform.ts` | — | — | Untested |
| `PlejdHbAccessory.ts` | — | — | Untested |
| `PlejdHbSceneAccessory.ts` | — | — | Untested |
| `plejdApi.ts` | — | — | Untested |

### Test Pattern for PlejdService

Tests create a `PlejdService` with empty config, call `updateState()`, then inspect `readQueue()`:

```typescript
service = new PlejdService(
  { devices: [], scenes: [], cryptoKey: Buffer.from("FooBar", "utf8") },
  Logger.withPrefix("Test"),
  () => {},
);
await service.updateState(deviceId, turnOn, { targetBrightness, transitionMs });
const queue = service.readQueue();  // Returns copy of internal queue
```

---

## Extension Guide

### Adding a New BLE Command

1. Add command code to `PlejdCommand` enum (`plejdService.ts:32-42`)
2. **Outbound**: Add a method like `triggerScene()` that builds payload and calls `sendQueue.unshift()`
3. **Inbound**: Add a `case` in `handleNotification()` switch (`plejdService.ts:560-607`)
4. **HomeKit state**: If needed, extend `onUpdate()` callback and handle in `PlejdHbPlatform.onPlejdUpdates()`
5. Add tests to `tests/plejdService.spec.ts` following the existing pattern

### Adding a New Accessory Type (e.g., Cover/Blind)

1. Create `src/PlejdHbCoverAccessory.ts` following `PlejdHbAccessory.ts` pattern
2. Use appropriate HomeKit service (e.g., `WindowCovering`)
3. Register characteristic handlers (TargetPosition, CurrentPosition, etc.)
4. Add new type to `Device.outputType` union in `src/model/device.ts`
5. Add discovery logic in `PlejdHbPlatform.ts` (parallel to `discoverDevices()`)
6. Add BLE command handling if needed (see above)
7. Update `config.schema.json` with new type option

### Adding a Configuration Option

1. Add property to `config.schema.json`
2. Read from `this.config.newOption` in `PlejdHbPlatform.ts`
3. Pass through to where needed (PlejdService, accessories, etc.)
4. Default handling: use `??` operator (see `transitionMs` pattern at `PlejdHbPlatform.ts:48-49`)

---

## Known Gotchas

1. **macOS BLE limitation**: `peripheral.address` is not exposed. Code extracts MAC from manufacturer data bytes 6-11 (reversed), but these may contain a relayed device's MAC rather than the advertiser's own. Falls back to single-device assumption or post-connection probing via mesh traffic decryption. See "MAC Address Resolution" section above.

2. **Manual mode `.count` bug**: `PlejdHbPlatform.ts:70` checks `this.config.devices.count > 0`. JavaScript arrays don't have a `.count` property (should be `.length`). Manual mode without cloud credentials likely never activates.

3. **Brightness 0 → 1 conversion**: In notification handling (`plejdService.ts:583`), `dim === 0` converts to `1%` (not 0%) to avoid HomeKit displaying 0% while light is "on."

4. **Dual-output devices**: DIM-01-2P and similar have two outputs. The code checks if output "0" address conflicts with a manually configured device and falls back to output "1" (`PlejdHbPlatform.ts:99-104`).

5. **`includeRoomsAsLights` dead code**: `PlejdRemoteApi` constructor accepts this parameter (hardcoded to `true` at call site, `PlejdHbPlatform.ts:63`) but it is never used in the API implementation.

6. **Data characteristic quirk**: Retrieved from `peripheral.services[0].characteristics` instead of the discovery result (`plejdService.ts:405-408`).

---

## External Reference Implementations

Two external repositories contain features not yet ported (lacking test hardware):

### pyplejd (Python) — `../extern/pyplejd/`

- Cover/blind support (`pyplejd/interface/plejd_cover.py`)
- Thermostat support (`pyplejd/interface/plejd_thermostat.py`)
- Motion sensor support (`pyplejd/interface/plejd_motion_sensor.py`)
- Button events (`pyplejd/interface/plejd_button.py`)
- BLE payload encoding (`pyplejd/ble/payload_encode.py`)

### hass-plejd (Home Assistant) — `../extern/hass-plejd/`

- Climate entities (`custom_components/plejd/climate.py`)
- Cover entities (`custom_components/plejd/cover.py`)
- Binary sensors (`custom_components/plejd/binary_sensor.py`)
- Sensors (`custom_components/plejd/sensor.py`)
- Event handling (`custom_components/plejd/event.py`)
