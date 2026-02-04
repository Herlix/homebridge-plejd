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
  Result,
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
  private isConnecting = false;
  private isAuthenticated = false;
  private deviceAddress?: string | null = null;
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
    const brightnessCommandPrefix =
      deviceIdHex + PlejdCommand.RequestNoResponse + PlejdCommand.Brightness;

    this.sendQueue = this.sendQueue.filter(
      (cmd) =>
        !cmd.toString("hex").startsWith(brightnessCommandPrefix.toLowerCase()),
    );

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

      const payload =
        deviceIdHex +
        PlejdCommand.RequestNoResponse +
        PlejdCommand.Brightness +
        "01" +
        eightBitBrightness.toString(16).padStart(4, "0");

      this.sendQueue.unshift(Buffer.from(payload, "hex"));
    }
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
   *
   * On linux the address is returned.
   *
   * On macos however, the address is not exposed.
   * The mac is static on the Plejd devices and sometimes exposed in the localName property,
   * this is used to identify the device.
   *
   * @param peripheral in question
   * @returns
   */
  private extractAddress(peripheral: noble.Peripheral): Result<string, string> {
    this.log.debug(
      `Peripheral advertisement: ${JSON.stringify(peripheral.advertisement)}`,
    );

    if (peripheral.address) {
      return { value: peripheral.address.replace(/:/g, "").toUpperCase() };
    }
    const macRegex = /([A-Fa-f0-9]{12})$/;
    const match = peripheral.advertisement.localName.match(macRegex);

    if (!match || !match[1]) {
      // In the rare case a user has one device and it does not expose its MAC address
      if (this.config.devices.length === 1) {
        return { value: this.config.devices[0].plejdDeviceId };
      } else {
        return {
          error: `Unable to extract MAC address peripgeral: ${peripheral.advertisement.localName}`,
        };
      }
    }
    return { value: match[1].toUpperCase() };
  }

  /**
   *
   * Checks if the peripheral is suitable, will blacklist if not suitable.
   *
   * Returns error if a device does not follow expected behaviour.
   *
   * A device can be blacklisted in a previous scan, this would be a unsuitable device.
   *
   * @param peripheral
   * @returns
   */
  private isSuitableDeviceAddress = async (
    peripheral: noble.Peripheral,
  ): Promise<Result<string, string>> => {
    const deviceAddressResult = this.extractAddress(peripheral);
    let deviceAddress = "";
    if (!deviceAddressResult.value) {
      this.log.warn(
        `Unable to extract MAC address peripheral: ${JSON.stringify(peripheral.advertisement)}`,
      );
      return { error: deviceAddressResult.error };
    }
    deviceAddress = deviceAddressResult.value;

    if (!this.config.devices.find((x) => x.plejdDeviceId === deviceAddress)) {
      this.blacklistDevice(deviceAddress, "not_found");
      this.log.warn(`Device ${deviceAddress} not found in known devices`);
      return {};
    }

    if (peripheral.rssi < -90) {
      this.log.info(
        `Skipping device with weak signal: ${deviceAddress} (${peripheral.rssi} dB)`,
      );
      this.blacklistDevice(deviceAddress, "weak_signal");
      return {};
    }

    if (this.isDeviceBlacklisted(deviceAddress)) {
      this.log.info(`Skipping blacklisted device: ${deviceAddress}`);
      return {};
    }

    if (this.isConnecting) {
      this.log.debug("Connection already in progress, skipping...");
      return {};
    }

    this.log.info(
      `Discovered | ${peripheral.advertisement.localName} | addr: ${deviceAddress} | Signal strength: ${this.mapRssiToQuality(peripheral.rssi)} (${peripheral.rssi} dB)`,
    );

    return { value: deviceAddress };
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

          await peripheral.connectAsync();
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
        "Max reconnection attempts reached. Resetting noble and starting scan.",
      );
      noble.reset();
      await this.tryStartScanning();
    } finally {
      this.isConnecting = false;
    }

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
    this.log.info("Setting up ping pong communication with Plejd device");
    this.startPlejdPing(peripheral, pingChar);
    this.log.debug("Starting queue handler for messages to Plejd device");

    const addressBuffer = Buffer.from(
      this.deviceAddress.replace(/:/g, ""),
      "hex",
    ).reverse();

    this.startQueueProcessor(dataChar, addressBuffer);

    try {
      this.log.info("Subscribing to incomming messages");
      await race(() => lastDataChar.subscribeAsync());
      lastDataChar.on("data", async (data, isNotification) => {
        await this.handleNotification(data, isNotification, addressBuffer);
      });
    } catch (e) {
      this.blacklistDevice(
        this.deviceAddress,
        `Communication setup failed: ${e}`,
      );
      await this.tryDisconnect(peripheral);
      this.log.error("Failed to subscribe to Plejd device", e);
    }
  };

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
      this.blacklistDevice(this.deviceAddress, `Authentication failed: ${e}`);
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
        noble.once("discover", async (peripheral) => {
          const timeOut = () => {
            if (this.discoverTimeout) {
              clearTimeout(this.discoverTimeout);
            }

            this.discoverTimeout = setTimeout(async () => {
              if (!this.isAuthenticated) {
                this.log.warn("No device found during scan, restarting scan");
                await noble.stopScanningAsync();
                await this.tryStartScanning();
              }
            }, 30000);
          };
          const r = await this.isSuitableDeviceAddress(peripheral);
          if (r.error) {
            this.log.warn(r.error);
            await noble.stopScanningAsync();
            await this.tryStartScanning();
            timeOut();
          } else if (r.value) {
            await this.connectToPeripheral(peripheral, r.value);
            timeOut();
          }
        });
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

  private cleanup() {
    this.stopPlejdPing();
    this.stopQueueProcessor();
    if (this.blacklistCleanupInterval) {
      clearInterval(this.blacklistCleanupInterval);
      this.blacklistCleanupInterval = null;
    }
    this.sendQueue = [];
    this.isAuthenticated = false;
    this.deviceState = {
      lastPingSuccess: Date.now(),
      consecutivePingFailures: 0,
    };
    this.deviceAddress = undefined;
  }
}
