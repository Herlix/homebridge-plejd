import { Logger } from "homebridge";
import { UserInputConfig } from "./model/userInputConfig.js";
import { randomBytes } from "crypto";
import noble from "@abandonware/noble";
import {
  DEFAULT_BRIGHTNESS_TRANSITION_MS,
  PLEJD_PING_TIMEOUT,
  PLEJD_WRITE_TIMEOUT,
  MIN_PAYLOAD_LENGTH,
  AUTH_STEP_DELAY,
  PROBE_TIMEOUT,
  CONNECT_TIMEOUT,
  RECONNECT_DELAY,
  MAX_PING_FAILURES,
  DEVICE_COOLDOWN,
} from "./constants.js";
import {
  delay,
  race,
  withRetry,
  plejdChallageResp as plejdCharResp,
  plejdEncodeDecode,
} from "./utils.js";

/**
 * Plejd BLE UUIDs
 *
 * they all have '60854726be45040c957391b5' as suffix
 */
enum PlejdCharacteristics {
  Service = "31ba000160854726be45040c957391b5",
  LightLevel = "31ba000360854726be45040c957391b5",
  Data = "31ba000460854726be45040c957391b5",
  LastData = "31ba000560854726be45040c957391b5",
  Auth = "31ba000960854726be45040c957391b5",
  Ping = "31ba000a60854726be45040c957391b5",
}

export enum PlejdCommand {
  OnOffState = "0097",
  StateBrightness = "00c8",
  Brightness = "0098", // 0-255
  Scene = "0021",
  Time = "001b",
  RequestResponse = "0102",
  RequestNoResponse = "0110",
  RequestReadValue = "0103",
  ButtonClick = "0006",
}

export class PlejdService {
  private sendQueue: Buffer[] = [];
  private pingInterval: NodeJS.Timeout | null = null;
  private queueInterval: NodeJS.Timeout | null = null;
  private discoverHandler: ((peripheral: noble.Peripheral) => void) | null =
    null;
  private loopGeneration = 0;
  private failedDevices: Map<string, number> = new Map(); // MAC → cooldown expiry
  private connectedSince: number | null = null;

  private static readonly PROBE_NEEDED = "PROBE_NEEDED";

  constructor(
    private readonly config: UserInputConfig,
    public readonly log: Logger,
    private readonly onUpdate: (
      identifier: number,
      isOn: boolean,
      dim?: number,
    ) => void,
  ) {}

  // --- Public API --- \\

  /**
   * @returns the current queue items
   */
  readQueue(): Buffer[] {
    return [...this.sendQueue];
  }

  /**
   * Update the state of a device
   *
   * @param identifier: The device identifier
   * @param turnOn: The new state of the device
   * @param opt.targetBrightness: The new brightness of the device between 0-100
   * @param opt.currentBrightness: The current brightness of the device between 0-100
   * @param opt.transitionMs: split brightness into steps, adding a transition to the brightness change
   */
  updateState = async (
    identifier: number,
    turnOn: boolean,
    opt: {
      targetBrightness?: number;
      currentBrightness?: number;
      transitionMs?: number;
    } = {},
  ) => {
    const deviceIdHex = identifier.toString(16).padStart(2, "0");

    if (!turnOn || !opt.targetBrightness || opt.targetBrightness === 0) {
      const payload =
        deviceIdHex +
        PlejdCommand.RequestNoResponse +
        PlejdCommand.OnOffState +
        (turnOn ? "01" : "00");
      this.log.debug(
        `BLE: Turning ${turnOn ? "on" : "off"} device ${identifier}`,
      );
      this.sendQueue.unshift(Buffer.from(payload, "hex"));
      return;
    }

    // Filter out any existing brightness commands for this device before adding new ones
    const brightnessCommandPrefix =
      deviceIdHex + PlejdCommand.RequestNoResponse + PlejdCommand.Brightness;
    this.sendQueue = this.sendQueue.filter(
      (cmd) =>
        !cmd.toString("hex").startsWith(brightnessCommandPrefix.toLowerCase()),
    );

    const trans = opt.transitionMs || DEFAULT_BRIGHTNESS_TRANSITION_MS;
    const steps = trans > 0 ? Math.round(trans / PLEJD_WRITE_TIMEOUT) : 1;

    this.log.debug(
      `BLE: Setting brightness for device ${identifier} to ${opt.targetBrightness}% over ${trans}ms in ${steps} steps`,
    );

    const startBrightness = opt.currentBrightness || 0;
    const brightnessDifference = opt.targetBrightness - startBrightness;
    for (let step = 1; step <= steps; step++) {
      const currentStepBrightness = Math.min(
        100,
        Math.max(0, startBrightness + (brightnessDifference * step) / steps),
      );
      const eightBitBrightness = Math.round(currentStepBrightness * 2.55);

      // Brightness payload: same byte sent twice per Plejd protocol
      const dimHex = eightBitBrightness.toString(16).padStart(2, "0");
      const payload =
        deviceIdHex +
        PlejdCommand.RequestNoResponse +
        PlejdCommand.Brightness +
        "01" +
        dimHex +
        dimHex;

      this.sendQueue.unshift(Buffer.from(payload, "hex"));
    }
  };

  /**
   * Trigger a Plejd scene
   *
   * @param sceneIndex - The scene index from sceneIndex mapping
   */
  triggerScene = (sceneIndex: number) => {
    const sceneIndexHex = sceneIndex.toString(16).padStart(2, "0");
    // Payload format: [address][version][command_type][command][scene_index]
    // = 00 01 10 00 21 <sceneIndex>
    const payload = "00" + "0110" + PlejdCommand.Scene + sceneIndexHex;

    this.log.debug(`BLE: Triggering scene ${sceneIndex}`);
    this.sendQueue.unshift(Buffer.from(payload, "hex"));
  };

  configureBLE = () => {
    noble.on("stateChange", async (state) => {
      this.log.info(`Noble State changed: ${state}`);
      if (state === "poweredOn") {
        this.runLoop();
      } else if (state === "poweredOff") {
        const uptime = this.formatUptime();
        this.log.info(
          `Bluetooth powered off${uptime}, cleaning up connections`,
        );
        this.connectedSince = null;
        this.cancelLoop();
      }
    });

    noble.on("warning", (message: string) => {
      this.log.warn(`Noble warning: ${message}`);
    });
    noble.on("scanStart", () => {
      this.log.debug("Noble: scan started");
    });
    noble.on("scanStop", () => {
      this.log.debug("Noble: scan stopped");
    });
  };

  // --- Connection loop --- \\

  /**
   * Cancel any in-flight connection loop by incrementing the generation counter.
   * Stops timers, scanning, and removes discover handler.
   */
  private cancelLoop() {
    this.loopGeneration++;
    this.stopPing();
    this.stopQueue();
    this.removeDiscoverHandler();
    try {
      noble.stopScanning();
    } catch {
      // Ignore — may not be scanning
    }
  }

  /**
   * Main connection loop. Cancels any previous loop, then repeatedly
   * attempts to connect until the generation changes (poweredOff).
   */
  private async runLoop() {
    this.cancelLoop();
    const gen = this.loopGeneration;

    while (gen === this.loopGeneration) {
      try {
        await this.connectAndRun(gen);
      } catch (error) {
        if (gen !== this.loopGeneration) return;
        this.log.error("Connection cycle failed:", error);
      }

      // Delay before retrying (unless generation changed)
      if (gen === this.loopGeneration) {
        await delay(RECONNECT_DELAY);
      }
    }
  }

  /**
   * Single connection attempt: scan → connect → discover → auth → probe → run.
   * Throws on any failure so the outer loop can retry.
   */
  private async connectAndRun(gen: number) {
    // 1. Scan for a suitable device
    const { peripheral, address } = await this.scanForDevice(gen);
    if (gen !== this.loopGeneration) return;

    let deviceAddress = address;

    try {
      // 2. Connect
      this.log.info(
        `Connecting to ${peripheral.advertisement.localName} (addr: ${deviceAddress})`,
      );
      await race(() => peripheral.connectAsync(), CONNECT_TIMEOUT);
      if (gen !== this.loopGeneration) {
        await this.tryDisconnect(peripheral);
        return;
      }

      this.log.info(
        `Connected to mesh | ${peripheral.advertisement.localName} (addr: ${deviceAddress})`,
      );

      // 3. Discover characteristics
      const characteristics = await this.discoverCharacteristics(peripheral);
      if (gen !== this.loopGeneration) {
        await this.tryDisconnect(peripheral);
        return;
      }

      const authChar = characteristics.find(
        (c) => c.uuid === PlejdCharacteristics.Auth,
      );
      const lastDataChar = characteristics.find(
        (c) => c.uuid === PlejdCharacteristics.LastData,
      );
      const pingChar = characteristics.find(
        (c) => c.uuid === PlejdCharacteristics.Ping,
      );
      const dataChar =
        peripheral?.services[0]?.characteristics?.find(
          (c) => c.uuid === PlejdCharacteristics.Data,
        ) ?? null;

      if (!authChar || !lastDataChar || !pingChar || !dataChar) {
        throw new Error(
          `Missing required characteristics: auth=${!!authChar}, lastData=${!!lastDataChar}, ping=${!!pingChar}, data=${!!dataChar}`,
        );
      }

      // 4. Authenticate
      await this.authenticate(authChar);
      if (gen !== this.loopGeneration) {
        await this.tryDisconnect(peripheral);
        return;
      }

      // 5. Subscribe + probe MAC if needed
      this.log.info("Subscribing to incoming messages");
      await race(() => lastDataChar.subscribeAsync());

      if (deviceAddress === PlejdService.PROBE_NEEDED) {
        this.log.info(
          "Probing for device MAC address via mesh notifications...",
        );
        const probedAddress = await this.probeDeviceAddress(lastDataChar);
        if (!probedAddress) {
          throw new Error(
            "Failed to determine device MAC address — no identifiable mesh traffic within timeout",
          );
        }
        deviceAddress = probedAddress;
        this.log.info(`Device identified as ${probedAddress}`);
      }

      if (gen !== this.loopGeneration) {
        await this.tryDisconnect(peripheral);
        return;
      }

      // Success — clear cooldowns
      this.failedDevices.clear();

      const addressBuffer = Buffer.from(
        deviceAddress.replace(/:/g, ""),
        "hex",
      ).reverse();

      // 6. Run (ping + queue + notifications) until failure
      await this.runConnected(
        gen,
        peripheral,
        { pingChar, lastDataChar, dataChar },
        addressBuffer,
      );
    } catch (error) {
      // Add device to cooldown on failure
      if (
        deviceAddress &&
        deviceAddress !== PlejdService.PROBE_NEEDED
      ) {
        this.failedDevices.set(deviceAddress, Date.now() + DEVICE_COOLDOWN);
      }
      await this.tryDisconnect(peripheral);
      throw error;
    }
  }

  // --- Scanning --- \\

  /**
   * Scans for the first suitable Plejd peripheral.
   * Returns the peripheral and its resolved address (or PROBE_NEEDED).
   */
  private scanForDevice(
    gen: number,
  ): Promise<{ peripheral: noble.Peripheral; address: string }> {
    return new Promise<{ peripheral: noble.Peripheral; address: string }>(
      (resolve, reject) => {
        if (gen !== this.loopGeneration) {
          reject(new Error("Generation changed before scan started"));
          return;
        }

        this.log.info("Scanning for Plejd devices");

        this.discoverHandler = (peripheral: noble.Peripheral) => {
          if (gen !== this.loopGeneration) {
            this.removeDiscoverHandler();
            noble.stopScanning();
            reject(new Error("Generation changed during scan"));
            return;
          }

          const deviceAddress = this.extractAddress(peripheral);

          // If MAC extracted but not in config, skip
          if (
            deviceAddress &&
            !this.config.devices.find(
              (x) => x.plejdDeviceId === deviceAddress,
            )
          ) {
            this.log.debug(
              `Skipping unknown device: ${deviceAddress}`,
            );
            return;
          }

          // If MAC extracted and in cooldown, skip
          if (deviceAddress) {
            const cooldownExpiry = this.failedDevices.get(deviceAddress);
            if (cooldownExpiry && Date.now() < cooldownExpiry) {
              this.log.debug(
                `Skipping device in cooldown: ${deviceAddress}`,
              );
              return;
            }
          }

          const address = deviceAddress ?? PlejdService.PROBE_NEEDED;
          const displayAddr =
            address === PlejdService.PROBE_NEEDED
              ? "unknown (will probe)"
              : address;

          this.log.info(
            `Discovered | ${peripheral.advertisement.localName} | addr: ${displayAddr} | RSSI: ${peripheral.rssi} dB`,
          );

          this.removeDiscoverHandler();
          noble.stopScanning();
          resolve({ peripheral, address });
        };

        noble.on("discover", this.discoverHandler);

        noble.startScanning([PlejdCharacteristics.Service], false, (err) => {
          if (err) {
            this.removeDiscoverHandler();
            reject(new Error(`Failed to start scanning: ${err}`));
          }
        });
      },
    );
  }

  // --- Device setup --- \\

  private async discoverCharacteristics(
    peripheral: noble.Peripheral,
  ): Promise<noble.Characteristic[]> {
    this.log.info("Discovering characteristics");
    const services = [PlejdCharacteristics.Service];
    const characteristicIds = [
      PlejdCharacteristics.Data,
      PlejdCharacteristics.LastData,
      PlejdCharacteristics.Auth,
      PlejdCharacteristics.Ping,
    ];

    const { characteristics } =
      await peripheral.discoverSomeServicesAndCharacteristicsAsync(
        services,
        characteristicIds,
      );
    this.log.info("Characteristics discovered");
    return characteristics;
  }

  private async authenticate(authChar: noble.Characteristic) {
    this.log.info("Authenticating to Plejd device");
    await race(() => authChar.writeAsync(Buffer.from([0x00]), false));
    await delay(AUTH_STEP_DELAY);
    const data = await race(() => authChar.readAsync());
    await delay(AUTH_STEP_DELAY);
    await race(() =>
      authChar.writeAsync(plejdCharResp(this.config.cryptoKey, data), false),
    );
    await delay(AUTH_STEP_DELAY);
    this.log.info("Authentication successful");
  }

  /**
   * Determines the connected device's MAC by listening for mesh notifications
   * and trying to decode them with each known device's MAC.
   * A valid decode (known command code) identifies the correct MAC.
   */
  private probeDeviceAddress(
    lastDataChar: noble.Characteristic,
  ): Promise<string | null> {
    const knownCommands = new Set(Object.values(PlejdCommand));

    return new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => {
        lastDataChar.removeAllListeners("data");
        resolve(null);
      }, PROBE_TIMEOUT);

      const handler = (data: Buffer) => {
        for (const device of this.config.devices) {
          const addressBuffer = Buffer.from(
            device.plejdDeviceId.replace(/:/g, ""),
            "hex",
          ).reverse();

          const decoded = plejdEncodeDecode(
            this.config.cryptoKey,
            addressBuffer,
            data,
          );

          if (decoded.length >= 5) {
            const command = decoded.toString("hex", 3, 5);
            if (knownCommands.has(command as PlejdCommand)) {
              clearTimeout(timeout);
              lastDataChar.removeAllListeners("data");
              resolve(device.plejdDeviceId);
              return;
            }
          }
        }
      };

      lastDataChar.on("data", handler);
    });
  }

  // --- Running --- \\

  /**
   * Runs the connected session: ping, queue processing, and notification handling.
   * Returns a promise that rejects when the connection is lost.
   */
  private runConnected(
    gen: number,
    peripheral: noble.Peripheral,
    chars: {
      pingChar: noble.Characteristic;
      lastDataChar: noble.Characteristic;
      dataChar: noble.Characteristic;
    },
    addressBuffer: Buffer,
  ): Promise<void> {
    return new Promise<void>((_, reject) => {
      if (gen !== this.loopGeneration) {
        reject(new Error("Generation changed before run started"));
        return;
      }

      this.connectedSince = Date.now();

      // Handle disconnect
      peripheral.once("disconnect", () => {
        const uptime = this.formatUptime();
        this.connectedSince = null;
        this.log.info(`Disconnected from mesh${uptime}`);
        this.stopPing();
        this.stopQueue();
        reject(new Error("Peripheral disconnected"));
      });

      // Start ping with local failure counter
      this.startPing(gen, chars.pingChar, (error) => {
        this.stopPing();
        this.stopQueue();
        this.tryDisconnect(peripheral);
        reject(error);
      });

      // Start queue processor
      this.log.debug("Starting queue handler for messages to Plejd device");
      this.startQueue(chars.dataChar, addressBuffer);

      // Listen for notifications
      chars.lastDataChar.on("data", async (data, isNotification) => {
        await this.handleNotification(data, isNotification, addressBuffer);
      });

      this.log.info("Connection fully established — running");
    });
  }

  private startPing(
    gen: number,
    pingChar: noble.Characteristic,
    onFail: (error: Error) => void,
  ) {
    this.stopPing();
    let consecutiveFailures = 0;

    const performPing = async () => {
      if (gen !== this.loopGeneration) {
        this.stopPing();
        return;
      }

      try {
        const ping = randomBytes(1);
        await race(() => pingChar.writeAsync(ping, false), 2000);
        const pong = await race(() => pingChar.readAsync(), 2000);

        if (((ping[0] + 1) & 0xff) !== pong[0]) {
          this.log.error(
            "Ping pong communication failed, missing pong response",
          );
          consecutiveFailures++;
        } else {
          consecutiveFailures = 0;
        }
      } catch (error) {
        consecutiveFailures++;
        this.log.warn("Ping failed:", error);
      }

      if (consecutiveFailures >= MAX_PING_FAILURES) {
        this.log.warn(
          `Ping failed ${MAX_PING_FAILURES} times, reconnecting to mesh`,
        );
        onFail(new Error("Ping failed too many times"));
      }
    };

    this.log.debug(
      `Delaying first ping by ${PLEJD_PING_TIMEOUT}ms to let connection stabilize`,
    );
    this.pingInterval = setTimeout(() => {
      performPing();
      this.pingInterval = setInterval(performPing, PLEJD_PING_TIMEOUT);
    }, PLEJD_PING_TIMEOUT);
  }

  private stopPing() {
    if (this.pingInterval) {
      clearTimeout(this.pingInterval);
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private startQueue(
    dataChar: noble.Characteristic,
    addressBuffer: Buffer,
  ) {
    this.stopQueue();

    const processQueue = async () => {
      const payload = this.sendQueue.pop();
      if (!payload) return;

      const data = plejdEncodeDecode(
        this.config.cryptoKey,
        addressBuffer,
        payload,
      );
      this.log.info(
        `BLE command sent to ${addressBuffer?.toString("hex") ?? "Unknown"} | ${data.length} bytes | ${data.toString("hex")}`,
      );

      try {
        await withRetry(() => race(() => dataChar.writeAsync(data, false)), {
          maxRetries: 3,
          delayMs: PLEJD_WRITE_TIMEOUT,
        });
      } catch (error) {
        this.sendQueue.unshift(payload);
        this.log.error("Failed to send data to device, will retry:", error);
      }
    };

    this.queueInterval = setInterval(processQueue, PLEJD_WRITE_TIMEOUT);
  }

  private stopQueue() {
    if (this.queueInterval) {
      clearInterval(this.queueInterval);
      this.queueInterval = null;
    }
  }

  // --- MAC extraction --- \\

  /**
   * Extracts the device MAC address from a peripheral using multiple strategies:
   * 1. peripheral.address (Linux - noble exposes it directly)
   * 2. Manufacturer data bytes 6-11 reversed (Plejd mesh advertisements)
   * 3. Single-device fallback (if only one device configured)
   */
  private extractAddress(peripheral: noble.Peripheral): string | null {
    this.log.debug(
      `Peripheral advertisement: ${JSON.stringify(peripheral.advertisement)}`,
    );

    // 1. Direct address from noble (Linux)
    if (peripheral.address) {
      const cleaned = peripheral.address.replace(/[:-]/g, "").toUpperCase();
      if (/^[A-F0-9]{12}$/.test(cleaned)) {
        return cleaned;
      }
    }

    // 2. Extract from manufacturer data (macOS - bytes 6-11 reversed)
    const mfgMac = this.extractAddressFromManufacturerData(peripheral);
    if (mfgMac) {
      return mfgMac;
    }

    // 3. Single device fallback
    if (this.config.devices.length === 1) {
      return this.config.devices[0].plejdDeviceId;
    }

    return null;
  }

  /**
   * Plejd manufacturer data (19 bytes):
   * [0-1] Company ID (0x0377)
   * [2-4] Header
   * [5]   Varies
   * [6-11] Device MAC address (reversed byte order)
   * [12-17] Stable mesh identifier
   * [18] Padding (0x00)
   *
   * Bytes 6-11 may contain the advertising device's MAC or a relayed
   * device's MAC. We check against known devices to filter.
   */
  private extractAddressFromManufacturerData(
    peripheral: noble.Peripheral,
  ): string | null {
    const mfgData = peripheral.advertisement.manufacturerData;
    if (!mfgData || mfgData.length < 18) {
      return null;
    }

    const mac = Buffer.from(mfgData.subarray(6, 12))
      .reverse()
      .toString("hex")
      .toUpperCase();

    if (this.config.devices.find((x) => x.plejdDeviceId === mac)) {
      this.log.debug(`Extracted MAC from manufacturer data: ${mac}`);
      return mac;
    }

    return null;
  }

  // --- Notification handling --- \\

  private handleNotification = async (
    data: Buffer,
    isNotification: boolean,
    addressBuffer: Buffer,
  ) => {
    if (data.length < MIN_PAYLOAD_LENGTH) {
      this.log.warn(
        `Received malformed notification: expected at least ${MIN_PAYLOAD_LENGTH} bytes, got ${data.length}`,
      );
      return;
    }

    const decodedData = plejdEncodeDecode(
      this.config.cryptoKey,
      addressBuffer,
      data,
    );

    if (decodedData.length < MIN_PAYLOAD_LENGTH) {
      this.log.warn(
        `Decoded payload too short: expected at least ${MIN_PAYLOAD_LENGTH} bytes, got ${decodedData.length}`,
      );
      return;
    }

    const id = parseInt(decodedData[0].toString(), 10);
    const command = decodedData.toString("hex", 3, 5);

    const isOn =
      decodedData.length >= 6
        ? parseInt(decodedData.toString("hex", 5, 6), 10) === 1
        : false;

    const commandType =
      Object.values(PlejdCommand).find((x) => x.toString() === command) ??
      "Unknown";

    const d = {
      id: id,
      command: command,
      commandType: commandType,
      on: isOn,
      Notification: isNotification,
      payload: decodedData.toString("hex"),
    };
    this.log.debug("Handle BLE notification", d);

    switch (command) {
      case PlejdCommand.Time: {
        const arg = parseInt(
          Buffer.from(decodedData.subarray(5, 9)).reverse().toString("hex"),
          16,
        );
        const date = new Date(arg * 1000);
        this.log.debug("Time sync: " + date.toString());
        break;
      }
      case PlejdCommand.Brightness:
      case PlejdCommand.StateBrightness: {
        const BRIGHTNESS_PAYLOAD_LENGTH = 8;
        if (decodedData.length < BRIGHTNESS_PAYLOAD_LENGTH) {
          this.log.warn(
            `Brightness payload too short: expected ${BRIGHTNESS_PAYLOAD_LENGTH} bytes, got ${decodedData.length}`,
          );
          this.onUpdate(id, isOn);
          break;
        }
        const dim = parseInt(decodedData.toString("hex", 7, 8), 16);

        // Convert to Homebridge 1-100
        const converted = dim === 0 ? 1 : (100 / 255) * dim;
        this.log.debug(
          `Brightness: raw=${dim} (0x${dim.toString(16).padStart(2, "0")}), converted=${converted.toFixed(1)}%`,
        );
        this.onUpdate(id, isOn, converted);
        break;
      }
      case PlejdCommand.Scene:
      case PlejdCommand.OnOffState:
      case PlejdCommand.ButtonClick:
      case PlejdCommand.RequestResponse:
      case PlejdCommand.RequestNoResponse:
      case PlejdCommand.RequestReadValue: {
        this.onUpdate(id, isOn);
        break;
      }
      default: {
        this.onUpdate(id, isOn);
        this.log.warn(
          `Unknown | command: ${command} | id: ${id} | ${decodedData.toString(
            "hex",
          )}`,
        );
      }
    }
  };

  // --- Helpers --- \\

  private removeDiscoverHandler() {
    if (this.discoverHandler) {
      noble.removeListener("discover", this.discoverHandler);
      this.discoverHandler = null;
    }
  }

  private formatUptime(): string {
    if (this.connectedSince === null) return "";
    const seconds = Math.round((Date.now() - this.connectedSince) / 1000);
    return ` (connection was up for ${seconds}s)`;
  }

  private async tryDisconnect(peripheral: noble.Peripheral) {
    try {
      await peripheral.disconnectAsync();
    } catch {
      // Ignore — may already be disconnected
    }
  }
}
