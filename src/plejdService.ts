import { Logger } from 'homebridge';
import { UserInputConfig } from './model/userInputConfig.js';
import {
  plejdChalResp as plejdCharResp,
  plejdEncodeDecode,
  reverseBuffer,
} from './plejdUtils.js';

import { randomBytes } from 'crypto';
import noble from '@abandonware/noble';
import { PLEJD_PING_TIMEOUT, PLEJD_WRITE_TIMEOUT } from './settings.js';

const NOBLE_IS_POWER_ON = 'poweredOn';

/**
 * Plejd BLE UUIDs
 */
enum PlejdCharacteristics {
  Service = '31ba000160854726be45040c957391b5',
  LightLevel = '31ba000360854726be45040c957391b5',
  Data = '31ba000460854726be45040c957391b5',
  LastData = '31ba000560854726be45040c957391b5',
  Auth = '31ba000960854726be45040c957391b5',
  Ping = '31ba000a60854726be45040c957391b5',
}

enum PlejdCommand {
  UpdateState = '0097',
  StateBrightness = '00c8',
  Brightness = '0098', // 0-255
  Scene = '0021',
  Time = '001b',
  RequestResponse = '0102',
  RequestNoResponse = '0110',
  RequestReadValue = '0103',
  ButtonClick = '0006',
}

export class PlejdService {
  private connectedPeripheral: noble.Peripheral | null;
  private addressBuffer: Buffer | null;
  private dataCharacteristic: noble.Characteristic | null;
  private pingTimer: NodeJS.Timeout | undefined;
  private queueTimer: NodeJS.Timeout | undefined;
  private sendQueue: Buffer[];

  constructor(
    private readonly config: UserInputConfig,
    public readonly log: Logger,
    private readonly onUpdate: (
      identifier: number,
      isOn: boolean,
      dim?: number,
    ) => void,
  ) {
    this.addressBuffer = null;
    this.dataCharacteristic = null;
    this.connectedPeripheral = null;
    this.sendQueue = [];

    noble.on('stateChange', async (state) => {
      if (state === NOBLE_IS_POWER_ON) {
        this.log.debug('Scanning for Plejd devices');
        await noble.startScanningAsync([PlejdCharacteristics.Service], false);
      }
    });

    noble.on('warning', (msg: string) => {
      this.log.warn('Noble warning: ', msg);
    });

    noble.on('discover', async (peripheral) => await this.onDiscover(peripheral));
  }

  /// Brightness should be between 1-100
  updateState = (
    identifier: number,
    isOn: boolean,
    brightness: number | null,
  ) => {
    if (!this.dataCharacteristic || !this.addressBuffer) {
      this.log.warn(
        `Atempting to update state, characteristic (${this.dataCharacteristic}) or address (${this.addressBuffer}) not found`,
      );
      return;
    }

    const dimming = brightness !== null;
    const command =
      isOn && dimming ? PlejdCommand.Brightness : PlejdCommand.UpdateState;

    let payload = Buffer.from(
      identifier.toString(16).padStart(2, '0') +
        PlejdCommand.RequestNoResponse +
        command +
        isOn ? '00' : '01',
      'hex',
    );

    if (dimming) {
      const dim = Math.round(2.55 * brightness); // Convert to Plejd 0-255
      payload = Buffer.concat([
        payload,
        Buffer.from(dim.toString(16).padStart(4, '0'), 'hex'),
      ]);
    }

    this.log.debug(
      `BLE command sent to ${identifier} | ${isOn ? 'ON' : 'OFF'}${ brightness !== null ? ' | Brightness: ' + brightness : ''}`,
    );
    const data = plejdEncodeDecode(
      this.config.cryptoKey,
      this.addressBuffer,
      payload,
    );

    this.sendQueue.push(data);
  };

  //   -------------- Private -------------- \\
  private onDiscover = async (peripheral: noble.Peripheral) => {
    await noble.stopScanningAsync();
    this.log.debug(
      `Discovered | ${peripheral.advertisement.localName} | addr: ${peripheral.address} | RSSI: ${peripheral.rssi} dB`,
    );

    try {
      await peripheral.connectAsync();
    } catch (error) {
      this.log.error(
        `Connecting failed | ${peripheral.advertisement.localName} | addr: ${peripheral.address}) - err: ${error}`,
      );
      return;
    }

    peripheral.once('disconnect', () => {
      this.log.info('Disconnected from mesh');
    });

    const characteristics = await this.discoverCaracteristics(peripheral);
    if (!characteristics) {
      this.log.error('Failed to discover characteristics, disconnecting...');
      return;
    }
    await this.setupDevice(peripheral, characteristics);
  };

  private discoverCaracteristics = async (peripheral: noble.Peripheral): Promise<noble.Characteristic[] | undefined> => {
    const addr = peripheral.address;
    this.log.info(
      `Connected to mesh | ${peripheral.advertisement.localName} (addr: ${addr})`,
    );

    this.connectedPeripheral = peripheral;
    this.addressBuffer = reverseBuffer(
      Buffer.from(String(addr).replace(/:/g, ''), 'hex'),
    );

    const services = [PlejdCharacteristics.Service];
    const characteristicIds = [
      PlejdCharacteristics.Data,
      PlejdCharacteristics.LastData,
      PlejdCharacteristics.Auth,
      PlejdCharacteristics.Ping,
    ];
    try {
      const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(services, characteristicIds);
      return characteristics;
    } catch (error) {
      this.log.error(
        `Failed to setup device | ${peripheral.advertisement.localName} (addr: ${addr}) - err: ${error}`,
      );
      return;
    }
  };

  private setupDevice = async (
    peripheral: noble.Peripheral,
    characteristics: noble.Characteristic[],
  ) => {
    const authChar = characteristics.find(
      (char) => char.uuid === PlejdCharacteristics.Auth,
    );
    const lastDataChar = characteristics.find(
      (char) => char.uuid === PlejdCharacteristics.LastData,
    );
    const pingChar = characteristics.find(
      (char) => char.uuid === PlejdCharacteristics.Ping,
    );
    this.dataCharacteristic =
      peripheral?.services[0]?.characteristics?.find(
        (char) => char.uuid === PlejdCharacteristics.Data,
      ) ?? null;

    if (!authChar || !lastDataChar || !pingChar) {
      this.log.error(
        'Unable to extract characteristic during discovery',
        authChar,
        lastDataChar,
        pingChar,
      );
      return;
    }

    // Authenticate
    await authChar.writeAsync(Buffer.from([0x00]), false);
    const data = await authChar.readAsync();
    await authChar.writeAsync(plejdCharResp(this.config.cryptoKey, data), false);

    // Setup communication
    this.startPlejdPing(pingChar);
    this.startPlejdQueue();
    await lastDataChar.subscribeAsync();
    lastDataChar.on('data', (data, isNotification) =>
      this.handleNotification(data, isNotification),
    );
  };

  private startPlejdQueue = () => {
    if (this.queueTimer) {
      clearInterval(this.queueTimer);
    }
    this.queueTimer = setTimeout(
      async () => await this.writePlejdQueueItems(),
      PLEJD_WRITE_TIMEOUT,
    );
  };

  private writePlejdQueueItems = async () => {
    const data = this.sendQueue.pop();

    if (this.dataCharacteristic && data) {
      await this.dataCharacteristic.writeAsync(data, false);
      this.queueTimer = setTimeout(
        () => this.startPlejdQueue(),
        PLEJD_WRITE_TIMEOUT / 2,
      );
    } else {
      this.queueTimer = setTimeout(
        () => this.startPlejdQueue(),
        PLEJD_WRITE_TIMEOUT,
      );
    }
  };

  private startPlejdPing = (pingChar: noble.Characteristic) => {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
    }
    this.pingTimer = setInterval(
      async () => {
        if (this.connectedPeripheral) {
          try {
            await this.plejdPing(pingChar);
          } catch (error) {
            this.log.warn('Ping failed, device disconnected, will retry to connect to mesh: ', error);
            if (noble._state === NOBLE_IS_POWER_ON) {
              await noble.startScanningAsync([PlejdCharacteristics.Service], false);
            }
          }
        }
      },
      PLEJD_PING_TIMEOUT,
    );
  };

  private plejdPing = async (
    pingChar: noble.Characteristic,
  ) => {
    const ping = randomBytes(1);
    pingChar.writeAsync(ping, false);
    const pong = await pingChar.readAsync();
    if (((ping[0] + 1) & 0xff) !== pong[0]) {
      throw new Error('Ping pong communication failed, missing pong response');
    }
  };

  private handleNotification = (data: Buffer, isNotification: boolean) => {
    if (!this.addressBuffer || this.addressBuffer?.byteLength === 0) {
      return;
    }

    const decodedData = plejdEncodeDecode(
      this.config.cryptoKey,
      this.addressBuffer,
      data,
    );
    const id = parseInt(decodedData[0].toString(), 10);
    const command = decodedData.toString('hex', 3, 5);

    const isOn = parseInt(decodedData.toString('hex', 5, 6), 10) === 1;

    const commandType =
      Object.values(PlejdCommand).find((x) => x.toString() === command) ??
      'Unknown';

    const d = {
      id: id,
      command: command,
      commandType: commandType,
      on: isOn,
      Notification: isNotification,
      payload: decodedData.toString('hex'),
    };
    this.log.debug('Handle BLE notification', d);

    switch (command) {
      case PlejdCommand.Time: {
        const arg = parseInt(
          reverseBuffer(decodedData.subarray(5, 9)).toString('hex'),
          16,
        );
        const date = new Date(arg * 1000);
        this.log.debug('Time sync: ' + date.toString());
        break;
      }
      case PlejdCommand.Brightness:
      case PlejdCommand.StateBrightness: {
        const dim = parseInt(decodedData.toString('hex', 7, 8), 16);

        // Convert to Homebridge 1-100
        const converted = dim === 0 ? 1 : (100 / 255) * dim;
        this.onUpdate(id, isOn, converted);
        break;
      }
      case PlejdCommand.Scene:
      case PlejdCommand.UpdateState:
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
            'hex',
          )}`,
        );
      }
    }
  };
}
