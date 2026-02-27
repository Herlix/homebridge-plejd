import { Logger } from "homebridge";
import { UserInputConfig } from "./model/userInputConfig.js";
import { randomBytes } from "crypto";
import noble from "@abandonware/noble";
import {
  DEFAULT_BRIGHTNESS_TRANSITION_MS,
  PLEJD_PING_TIMEOUT,
  PLEJD_WRITE_TIMEOUT,
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
  private discoverTimeout: NodeJS.Timeout | null = null;
  private plejdTimeout: NodeJS.Timeout | null = null;
  private queueTimeout: NodeJS.Timeout | null = null;
  private blacklistCleanupInterval: NodeJS.Timeout | null = null;
  private discoverHandler: ((peripheral: noble.Peripheral) => void) | null =
    null;
  private isConnecting = false;
  private isAuthenticated = false;
  private deviceAddress: string | null = null;
  private deviceState = {
    lastPingSuccess: Date.now(),
    consecutivePingFailures: 0,
  };
  private deviceBlacklist: Map<string, { until: number; attempts: number }> =
    new Map();
  private readonly MAX_FAILURES = 5;
  private readonly BLACKLIST_DURATION = 5 * 60 * 1000;
  private readonly EXTENDED_BLACKLIST_DURATION = 30 * 60 * 1000;

  constructor(
    private readonly config: UserInputConfig,
    public readonly log: Logger,
    private readonly onUpdate: (
      identifier: number,
      isOn: boolean,
      dim?: number,
    ) => void,
  ) {}

  /**
   *
   * @returns the current queue items
   */
  readQueue(): Buffer[] {
    return [...this.sendQueue];
  }

  /**
   *
   * Update the state of a device
   *
   * @param identifier: The device identifier
   * @param turnOn: The new state of the device
   * @param targetBrightness: The new brightness of the device between 0-100
   * @param currentBrightness: The current brightness of the device between 0-100
   * @param transitionMS: split brightness into steps, adding a transition to the brightness change
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
    const payload =
      "00" + "0110" + PlejdCommand.Scene + sceneIndexHex;

    this.log.debug(`BLE: Triggering scene ${sceneIndex}`);
    this.sendQueue.unshift(Buffer.from(payload, "hex"));
  };

  configureBLE = () => {
    this.startBlacklistCleanup();
    noble.on("stateChange", async (state) => {
      this.log.debug(`Noble State changed: ${state}`);
      await this.tryStartScanning();
    });
  };

  //   -------------- Private -------------- \\

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

  /**
   * Gets a stable identifier for blacklisting. Uses MAC if available,
   * falls back to manufacturer data stable bytes (12-17) on macOS,
   * then peripheral.uuid as last resort.
   */
  private getPeripheralIdentifier(
    peripheral: noble.Peripheral,
    resolvedAddress?: string | null,
  ): string {
    const macResult = resolvedAddress ?? this.extractAddress(peripheral);
    if (macResult) {
      return macResult;
    }

    // Manufacturer data bytes 12-17 are stable per physical device,
    // even when the BLE address rotates on macOS.
    const mfgData = peripheral.advertisement.manufacturerData;
    if (mfgData && mfgData.length >= 18) {
      return `mfg:${mfgData.subarray(12, 18).toString("hex").toUpperCase()}`;
    }

    return `uuid:${peripheral.uuid}`;
  }

  private static readonly PROBE_NEEDED = "PROBE_NEEDED";

  /**
   * Checks if the peripheral is suitable for connection.
   * Returns the device MAC, "PROBE_NEEDED" if MAC must be determined after
   * connecting (macOS fallback), or null if the device should be skipped.
   */
  private isSuitableDeviceAddress = async (
    peripheral: noble.Peripheral,
  ): Promise<string | null> => {
    const deviceAddress = this.extractAddress(peripheral);
    const peripheralId = this.getPeripheralIdentifier(
      peripheral,
      deviceAddress,
    );

    // Check blacklist first using fallback-safe identifier
    if (this.isDeviceBlacklisted(peripheralId)) {
      this.log.debug(`Skipping blacklisted peripheral: ${peripheralId}`);
      return null;
    }

    if (deviceAddress) {
      if (
        !this.config.devices.find((x) => x.plejdDeviceId === deviceAddress)
      ) {
        this.blacklistDevice(deviceAddress, "not_found");
        this.log.warn(`Device ${deviceAddress} not found in known devices`);
        return null;
      }
    } else {
      this.log.info(
        `Cannot extract MAC from peripheral (uuid: ${peripheral.uuid}), will probe after connecting`,
      );
    }

    if (peripheral.rssi < -90) {
      const id = deviceAddress ?? peripheralId;
      this.log.info(
        `Skipping device with weak signal: ${id} (${peripheral.rssi} dB)`,
      );
      this.blacklistDevice(id, "weak_signal");
      return null;
    }

    if (this.isConnecting) {
      this.log.debug("Connection already in progress, skipping...");
      return null;
    }

    const displayAddr = deviceAddress ?? "unknown (will probe)";
    this.log.info(
      `Discovered | ${peripheral.advertisement.localName} | addr: ${displayAddr} | Signal strength: ${this.mapRssiToQuality(peripheral.rssi)} (${peripheral.rssi} dB)`,
    );

    return deviceAddress ?? PlejdService.PROBE_NEEDED;
  };

  private connectToPeripheral = async (
    peripheral: noble.Peripheral,
    deviceAddress: string,
  ) => {
    if (this.isConnecting) {
      this.log.debug("Connection already in progress, skipping...");
      return {};
    }

    this.isConnecting = true;
    let retryCount = 0;
    const maxRetries = 3;

    try {
      while (retryCount <= maxRetries) {
        try {
          if (retryCount > 0) {
            await delay(2000);
            this.log.info(
              `Attempting to reconnect (attempt ${retryCount}/${maxRetries})`,
            );
          }

          await race(() => peripheral.connectAsync(), 10_000);
          this.log.info(
            `Connected to mesh | ${peripheral.advertisement.localName} (addr: ${deviceAddress})`,
          );
          this.deviceAddress = deviceAddress;

          peripheral.once("disconnect", async () => {
            this.log.info("Disconnected from mesh");
            this.cleanup();
            await delay(5000);
            await this.tryStartScanning();
          });

          let characteristics: noble.Characteristic[];
          try {
            characteristics = await this.discoverCaracteristics(peripheral);
          } catch (e) {
            this.log.error(
              "Failed to discover characteristics, disconnecting. Error:",
              e,
            );
            await this.tryDisconnect(peripheral);
            throw e;
          }

          await this.setupDevice(peripheral, characteristics);
          return {}; // Success - exit the method
        } catch (error) {
          this.log.error(
            `Connecting failed | ${peripheral.advertisement.localName} | addr: ${deviceAddress}) - err: ${error}`,
          );
          await this.tryDisconnect(peripheral);
          retryCount++;
        }
      }

      // All retries exhausted
      this.log.error(
        "Max reconnection attempts reached, will restart scan.",
      );
    } finally {
      this.isConnecting = false;
    }

    // Restart scanning after isConnecting is cleared
    await this.tryStartScanning();

    return {};
  };

  private mapRssiToQuality(rssi: number): string {
    if (rssi >= -30) {
      return "Excellent (Very close proximity)";
    } else if (rssi >= -67) {
      return "Very Good";
    } else if (rssi >= -70) {
      return "Good";
    } else if (rssi >= -80) {
      return "Fair";
    } else if (rssi >= -90) {
      return "Weak";
    } else {
      return "Very Weak (Potential connection issues)";
    }
  }

  private discoverCaracteristics = async (
    peripheral: noble.Peripheral,
  ): Promise<noble.Characteristic[]> => {
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
  };

  private setupDevice = async (
    peripheral: noble.Peripheral,
    characteristics: noble.Characteristic[],
  ) => {
    this.log.info("Locating relevant characteristics");
    const authChar = characteristics.find(
      (char) => char.uuid === PlejdCharacteristics.Auth,
    );
    const lastDataChar = characteristics.find(
      (char) => char.uuid === PlejdCharacteristics.LastData,
    );
    const pingChar = characteristics.find(
      (char) => char.uuid === PlejdCharacteristics.Ping,
    );
    const dataChar =
      peripheral?.services[0]?.characteristics?.find(
        (char) => char.uuid === PlejdCharacteristics.Data,
      ) ?? null;

    if (!authChar || !lastDataChar || !pingChar || !dataChar) {
      this.log.error(
        "Unable to extract characteristic during discovery",
        authChar,
        lastDataChar,
        pingChar,
      );
      await this.tryDisconnect(peripheral);
      return;
    }

    await this.authenticate(peripheral, authChar);
    await this.setupCommunication(peripheral, pingChar, lastDataChar, dataChar);
  };

  private startQueueProcessor = (
    dataChar: noble.Characteristic,
    addressBuffer: Buffer,
  ) => {
    this.stopQueueProcessor();

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
        this.log.error("Failed to send data to device, will retry: ", error);
      }
    };

    this.queueTimeout = setInterval(processQueue, PLEJD_WRITE_TIMEOUT);
  };

  private stopQueueProcessor = () => {
    if (this.queueTimeout) {
      clearInterval(this.queueTimeout);
      this.queueTimeout = null;
    }
  };

  private startPlejdPing = (
    peripheral: noble.Peripheral,
    pingChar: noble.Characteristic,
  ) => {
    this.stopPlejdPing();

    const performPing = async () => {
      if (!pingChar) return;

      try {
        const ping = randomBytes(1);
        await race(() => pingChar.writeAsync(ping, false));
        const pong = await race(() => pingChar.readAsync());

        if (((ping[0] + 1) & 0xff) !== pong[0]) {
          this.log.error(
            "Ping pong communication failed, missing pong response",
          );
          this.deviceState.consecutivePingFailures++;
        } else {
          this.deviceState.lastPingSuccess = Date.now();
          this.deviceState.consecutivePingFailures = 0;
        }
      } catch (error) {
        this.deviceState.consecutivePingFailures++;
        this.log.warn("Ping failed: ", error);
      }

      if (
        this.deviceAddress &&
        this.deviceAddress !== PlejdService.PROBE_NEEDED &&
        this.deviceState.consecutivePingFailures >= 3
      ) {
        this.log.warn("Ping failed 3 times, reconnecting to mesh");
        this.blacklistDevice(this.deviceAddress, "Ping failed 3 times");
        this.stopPlejdPing();
        await this.tryDisconnect(peripheral);
        await this.tryStartScanning();
      }
    };

    this.plejdTimeout = setInterval(performPing, PLEJD_PING_TIMEOUT);
  };

  private stopPlejdPing = () => {
    if (this.plejdTimeout) {
      clearInterval(this.plejdTimeout);
      this.plejdTimeout = null;
    }
  };

  private handleNotification = async (
    data: Buffer,
    isNotification: boolean,
    addressBuffer: Buffer,
  ) => {
    const MIN_PAYLOAD_LENGTH = 5; // 1 byte id + 2 bytes padding + 2 bytes command
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

  private setupCommunication = async (
    peripheral: noble.Peripheral,
    pingChar: noble.Characteristic,
    lastDataChar: noble.Characteristic,
    dataChar: noble.Characteristic,
  ) => {
    if (!this.deviceAddress) {
      this.log.error("Device address not set");
      return;
    }

    try {
      this.log.info("Subscribing to incoming messages");
      await race(() => lastDataChar.subscribeAsync());

      // On macOS: probe for the correct device MAC via mesh notifications
      if (this.deviceAddress === PlejdService.PROBE_NEEDED) {
        this.log.info(
          "Probing for device MAC address via mesh notifications...",
        );
        const probedAddress = await this.probeDeviceAddress(lastDataChar);
        if (!probedAddress) {
          this.log.error(
            "Failed to determine device MAC address — no identifiable mesh traffic within timeout",
          );
          await this.tryDisconnect(peripheral);
          await this.tryStartScanning();
          return;
        }
        this.deviceAddress = probedAddress;
        this.log.info(`Device identified as ${probedAddress}`);
      }

      // Start ping only after MAC is resolved
      this.log.info("Setting up ping pong communication with Plejd device");
      this.startPlejdPing(peripheral, pingChar);

      const addressBuffer = Buffer.from(
        this.deviceAddress.replace(/:/g, ""),
        "hex",
      ).reverse();

      this.log.debug("Starting queue handler for messages to Plejd device");
      this.startQueueProcessor(dataChar, addressBuffer);

      lastDataChar.on("data", async (data, isNotification) => {
        await this.handleNotification(data, isNotification, addressBuffer);
      });
    } catch (e) {
      if (this.deviceAddress !== PlejdService.PROBE_NEEDED) {
        this.blacklistDevice(
          this.deviceAddress,
          `Communication setup failed: ${e}`,
        );
      }
      await this.tryDisconnect(peripheral);
      this.log.error("Failed to subscribe to Plejd device", e);
    }
  };

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
      }, 30_000);

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

  private authenticate = async (
    peripheral: noble.Peripheral,
    authChar: noble.Characteristic,
  ) => {
    if (this.isAuthenticated || !this.deviceAddress) {
      return;
    }

    try {
      this.log.info("Authenticating to Plejd device");
      await race(() => authChar.writeAsync(Buffer.from([0x00]), false));
      await delay(100);
      const data = await race(() => authChar.readAsync());
      await delay(100);
      await race(() =>
        authChar.writeAsync(plejdCharResp(this.config.cryptoKey, data), false),
      );
      await delay(100);
      this.log.info("Authentication successful");
      this.isAuthenticated = true;
    } catch (e) {
      this.isAuthenticated = false;
      if (
        this.deviceAddress &&
        this.deviceAddress !== PlejdService.PROBE_NEEDED
      ) {
        this.blacklistDevice(this.deviceAddress, `Authentication failed: ${e}`);
      }
      await this.tryDisconnect(peripheral);
      this.log.error("Failed to authenticate to Plejd device", e);
    }
  };

  private tryStartScanning = async () => {
    this.cleanup();
    await noble.stopScanningAsync();
    try {
      if (noble._state === "poweredOn") {
        this.cleanupBlacklist();
        this.log.info("Scanning for Plejd devices");
        await delay(5000);
        await race(
          () => noble.startScanningAsync([PlejdCharacteristics.Service], false),
          10_000,
        );

        this.resetDiscoverTimeout();

        this.discoverHandler = async (peripheral: noble.Peripheral) => {
          const r = await this.isSuitableDeviceAddress(peripheral);
          if (r) {
            this.stopDiscoverTimeout();
            this.removeDiscoverHandler();
            await this.connectToPeripheral(peripheral, r);
          }
          // If no value, continue listening for more peripherals
        };
        noble.on("discover", this.discoverHandler);
      }
    } catch (e) {
      this.log.error("Failed to start scanning for Plejd devices", e);
      await delay(10000);
      await this.tryStartScanning();
    }
  };

  private tryDisconnect = async (peripheral: noble.Peripheral) => {
    try {
      await peripheral.disconnectAsync();
    } catch (e) {
      this.log.debug("Failed to disconnect from previous peripheral", e);
    }
  };

  private isDeviceBlacklisted(address: string): boolean {
    const blacklistEntry = this.deviceBlacklist.get(address);
    if (!blacklistEntry) return false;

    if (Date.now() > blacklistEntry.until) {
      this.deviceBlacklist.delete(address);
      return false;
    }

    return true;
  }

  private blacklistDevice(address: string, reason: string) {
    const entry = this.deviceBlacklist.get(address) ?? {
      until: 0,
      attempts: 0,
    };
    entry.attempts++;

    const baseTime =
      entry.attempts >= this.MAX_FAILURES
        ? this.EXTENDED_BLACKLIST_DURATION
        : this.BLACKLIST_DURATION;

    const duration = Math.min(
      baseTime * Math.pow(2, entry.attempts - 1),
      24 * 60 * 60 * 1000, // Max 24 hours
    );

    entry.until = Date.now() + duration;
    this.deviceBlacklist.set(address, entry);

    this.log.warn(
      `Device ${address} blacklisted for ${duration / 1000} seconds. Reason: ${reason}. Failure attempts: ${entry.attempts}`,
    );
  }

  private cleanupBlacklist() {
    const now = Date.now();
    for (const [address, entry] of this.deviceBlacklist.entries()) {
      if (now > entry.until) {
        this.deviceBlacklist.delete(address);
      }
    }
  }

  private startBlacklistCleanup() {
    if (this.blacklistCleanupInterval) {
      clearInterval(this.blacklistCleanupInterval);
    }

    this.blacklistCleanupInterval = setInterval(
      () => {
        this.cleanupBlacklist();
      },
      5 * 60 * 1000,
    ); // Clean every 5 minutes
  }

  private removeDiscoverHandler() {
    if (this.discoverHandler) {
      noble.removeListener("discover", this.discoverHandler);
      this.discoverHandler = null;
    }
  }

  private cleanup() {
    this.stopPlejdPing();
    this.stopQueueProcessor();
    this.removeDiscoverHandler();
    this.stopDiscoverTimeout();
    this.sendQueue = [];
    this.isConnecting = false;
    this.isAuthenticated = false;
    this.deviceState = {
      lastPingSuccess: Date.now(),
      consecutivePingFailures: 0,
    };
    this.deviceAddress = null;
  }

  private stopDiscoverTimeout() {
    if (this.discoverTimeout) {
      clearTimeout(this.discoverTimeout);
      this.discoverTimeout = null;
    }
  }

  private resetDiscoverTimeout() {
    this.stopDiscoverTimeout();
    this.discoverTimeout = setTimeout(async () => {
      if (!this.isAuthenticated) {
        this.log.warn("No device found during scan, restarting scan");
        this.removeDiscoverHandler();
        await noble.stopScanningAsync();
        await this.tryStartScanning();
      }
    }, 30_000);
  }
}
