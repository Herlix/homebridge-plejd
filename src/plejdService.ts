import { Logger } from "homebridge";
import { UserInputConfig } from "./model/userInputConfig.js";
import {
  plejdChalResp as plejdCharResp,
  plejdEncodeDecode,
  reverseBuffer,
} from "./plejdUtils.js";

import { randomBytes } from "crypto";
import noble from "@abandonware/noble";
import { PLEJD_PING_TIMEOUT, PLEJD_WRITE_TIMEOUT } from "./settings.js";

/**
 * Plejd BLE UUIDs
 */
enum PlejdCharacteristics {
  Service = "31ba000160854726be45040c957391b5",
  LightLevel = "31ba000360854726be45040c957391b5",
  Data = "31ba000460854726be45040c957391b5",
  LastData = "31ba000560854726be45040c957391b5",
  Auth = "31ba000960854726be45040c957391b5",
  Ping = "31ba000a60854726be45040c957391b5",
}

enum PlejdCommand {
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
  private plejdTimeout: NodeJS.Timeout | null = null;
  private queueTimeout: NodeJS.Timeout | null = null;

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
   * Update the state of a device
   *
   * @param identifier: The device identifier
   * @param isOn: The new state of the device
   * @param brightness: The new brightness of the device between 0-100
   */
  updateState = async (
    identifier: number,
    isOn: boolean,
    brightness: number | null,
  ) => {
    const payload = Buffer.from(
      !brightness || brightness === 0
        ? identifier.toString(16).padStart(2, "0") +
            PlejdCommand.RequestNoResponse +
            PlejdCommand.OnOffState +
            (isOn ? "01" : "00")
        : identifier.toString(16).padStart(2, "0") +
            PlejdCommand.RequestNoResponse +
            PlejdCommand.Brightness +
            "01" +
            Math.round(2.55 * brightness)
              .toString(16)
              .padStart(4, "0"),
      "hex",
    );

    this.sendQueue.unshift(payload);
  };

  configureBLE = () => {
    noble.on("stateChange", async (state) => {
      this.log.debug(`Noble State changed: ${state}`);
      await this.tryStartScanning();
    });

    noble.on("warning", (msg: string) => {
      this.log.warn("Noble warning: ", msg);
    });
  };

  //   -------------- Private -------------- \\

  private onDiscover = async (peripheral: noble.Peripheral) => {
    this.log.info(
      `Discovered | ${peripheral.advertisement.localName} | addr: ${peripheral.address} | Signal strength: ${this.mapRssiToQuality(peripheral.rssi)} (${peripheral.rssi} dB)`,
    );
    this.log.debug(`Stopping scan`);
    await noble.stopScanningAsync();

    let retryCount = 0;
    const maxRetries = 3;

    const connectWithRetry = async () => {
      try {
        this.log.debug(`Connecting to the new peripheral`);
        await peripheral.connectAsync();
        this.log.info(
          `Connected to mesh | ${peripheral.advertisement.localName} (addr: ${peripheral.address})`,
        );

        peripheral.once("disconnect", async () => {
          this.log.info("Disconnected from mesh");
          if (retryCount < maxRetries) {
            retryCount++;
            this.log.debug(`Attempting to reconnect (attempt ${retryCount})`);
            await connectWithRetry();
          } else {
            this.log.error("Max reconnection attempts reached. Starting scan.");
            await this.tryStartScanning();
          }
        });

        // Reset retry count on successful connection
        retryCount = 0;

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
      } catch (error) {
        this.log.error(
          `Connecting failed | ${peripheral.advertisement.localName} | addr: ${peripheral.address}) - err: ${error}`,
        );
        await this.tryDisconnect(peripheral);
        if (retryCount < maxRetries) {
          retryCount++;
          this.log.debug(`Attempting to reconnect (attempt ${retryCount})`);
          await connectWithRetry();
        } else {
          this.log.error(
            "Max reconnection attempts reached. Resetting noble and starting scan.",
          );
          noble.reset();
          await this.tryStartScanning();
        }
      }
    };

    await connectWithRetry();
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
    this.log.debug("Discovering characteristics");
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
    this.log.debug("Characteristics discovered");
    return characteristics;
  };

  private setupDevice = async (
    peripheral: noble.Peripheral,
    characteristics: noble.Characteristic[],
  ) => {
    this.log.debug("Locating relevant characteristics");
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
      return;
    }

    const addressBuffer = reverseBuffer(
      Buffer.from(String(peripheral.address).replace(/:/g, ""), "hex"),
    );

    await this.authenticate(authChar);
    await this.setupCommunication(
      pingChar,
      lastDataChar,
      dataChar,
      addressBuffer,
    );
  };

  private handleQueuedMessages = (
    dataChar: noble.Characteristic,
    addressBuffer: Buffer,
  ) => {
    if (this.queueTimeout) {
      clearTimeout(this.queueTimeout);
    }

    this.queueTimeout = setTimeout(async () => {
      const payload = this.sendQueue.pop();
      if (!payload) {
        this.handleQueuedMessages(dataChar, addressBuffer);
        return;
      }

      const data = plejdEncodeDecode(
        this.config.cryptoKey,
        addressBuffer,
        payload,
      );
      this.log.debug(
        `BLE command sent to ${addressBuffer?.toString("hex") ?? "Unknown"} | ${data.length} bytes | ${data.toString("hex")}`,
      );
      try {
        await dataChar.writeAsync(data, false);
        this.handleQueuedMessages(dataChar, addressBuffer);
      } catch (error) {
        this.sendQueue.unshift(data);
        this.log.error("Failed to send data to device, will retry: ", error);
      }
    }, PLEJD_WRITE_TIMEOUT);
  };

  private startPlejdPing = (pingChar: noble.Characteristic) => {
    if (this.plejdTimeout) {
      clearTimeout(this.plejdTimeout);
    }

    this.plejdTimeout = setTimeout(async () => {
      if (pingChar) {
        try {
          const ping = randomBytes(1);
          await pingChar.writeAsync(ping, false);
          const pong = await pingChar.readAsync();
          if (((ping[0] + 1) & 0xff) !== pong[0]) {
            this.log.error(
              "Ping pong communication failed, missing pong response",
            );
          }
          this.startPlejdPing(pingChar);
        } catch (error) {
          this.log.warn(
            "Ping failed, device disconnected, will retry to connect to mesh: ",
            error,
          );
        }
      }
    }, PLEJD_PING_TIMEOUT);
  };

  private handleNotification = async (
    data: Buffer,
    isNotification: boolean,
    addressBuffer: Buffer,
  ) => {
    const decodedData = plejdEncodeDecode(
      this.config.cryptoKey,
      addressBuffer,
      data,
    );
    const id = parseInt(decodedData[0].toString(), 10);
    const command = decodedData.toString("hex", 3, 5);

    const isOn = parseInt(decodedData.toString("hex", 5, 6), 10) === 1;

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
          reverseBuffer(decodedData.subarray(5, 9)).toString("hex"),
          16,
        );
        const date = new Date(arg * 1000);
        this.log.debug("Time sync: " + date.toString());
        break;
      }
      case PlejdCommand.Brightness:
      case PlejdCommand.StateBrightness: {
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
    pingChar: noble.Characteristic,
    lastDataChar: noble.Characteristic,
    dataChar: noble.Characteristic,
    addressBuffer: Buffer,
  ) => {
    this.log.debug("Setting up ping pong communication with Plejd device");
    this.startPlejdPing(pingChar);
    this.log.debug("Starting queue handler for messages to Plejd device");
    this.handleQueuedMessages(dataChar, addressBuffer);

    try {
      this.log.debug("Subscribing to incomming messages");
      await lastDataChar.subscribeAsync();
      lastDataChar.on("data", async (data, isNotification) => {
        await this.handleNotification(data, isNotification, addressBuffer);
      });
    } catch (e) {
      this.log.error("Failed to subscribe to Plejd device", e);
    }
  };

  private authenticate = async (authChar: noble.Characteristic) => {
    try {
      this.log.debug("Authenticating to Plejd device");
      await authChar.writeAsync(Buffer.from([0x00]), false);
      const data = await authChar.readAsync();
      await authChar.writeAsync(
        plejdCharResp(this.config.cryptoKey, data),
        false,
      );
      this.log.debug("Authentication successful");
    } catch (e) {
      this.log.error("Failed to authenticate to Plejd device", e);
    }
  };

  private tryStartScanning = async () => {
    try {
      if (noble._state === "poweredOn") {
        this.log.info("Scanning for Plejd devices");

        await noble.startScanningAsync([PlejdCharacteristics.Service], false);
        noble.once(
          "discover",
          async (peripheral) => await this.onDiscover(peripheral),
        );
      }
    } catch (e) {
      this.log.error("Failed to start scanning for Plejd devices", e);
    }
  };

  private tryDisconnect = async (peripheral: noble.Peripheral) => {
    try {
      await peripheral.disconnectAsync();
    } catch (e) {
      this.log.debug("Failed to disconnect from previous peripheral", e);
    }
  };
}
