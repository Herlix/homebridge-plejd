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
import { delay } from './utils.js';

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
  OnOffState = '0097',
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
      await this.startScanning(state);
    });

    noble.on('warning', (msg: string) => {
      this.log.warn('Noble warning: ', msg);
    });

    noble.on('discover', async (peripheral) => await this.onDiscover(peripheral));
  }

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
    if (!this.connectedPeripheral || !this.dataCharacteristic || !this.addressBuffer) {
      await this.startScanning();
      return;
    }

    const payload = Buffer.from(!brightness || brightness === 0 ?
      (
        identifier.toString(16).padStart(2, '0') +
          PlejdCommand.RequestNoResponse +
          PlejdCommand.OnOffState +
          (isOn ? '01' : '00')
      ) :
      (
        identifier.toString(16).padStart(2, '0') +
          PlejdCommand.RequestNoResponse +
          PlejdCommand.Brightness +
          '01' +
          Math.round(2.55 * brightness).toString(16).padStart(4, '0')
      ),
    'hex',
    );

    const data = plejdEncodeDecode(
      this.config.cryptoKey,
      this.addressBuffer,
      payload,
    );

    this.sendToDeviceQueued(data);
  };

  //   -------------- Private -------------- \\
  private onDiscover = async (peripheral: noble.Peripheral) => {
    this.log.debug(
      `Discovered | ${peripheral.advertisement.localName} | addr: ${peripheral.address} | RSSI: ${peripheral.rssi} dB`,
    );
    await noble.stopScanningAsync();

    try {
      await peripheral.connectAsync();
    } catch (error) {
      this.log.error(
        `Connecting failed | ${peripheral.advertisement.localName} | addr: ${peripheral.address}) - err: ${error}`,
      );
      return;
    }

    this.connectedPeripheral = peripheral;

    peripheral.once('disconnect', async () => {
      this.connectedPeripheral?.removeAllListeners();
      this.connectedPeripheral = null;
      this.addressBuffer = null;
      this.dataCharacteristic = null;
      this.log.info('Disconnected from mesh');
      await this.startScanning();
    });

    const characteristics = await this.discoverCaracteristics(peripheral);
    if (!characteristics) {
      this.log.error('Failed to discover characteristics, disconnecting...');
      await peripheral.disconnectAsync();
      return;
    }
    await this.setupDevice(peripheral, characteristics);
  };

  private discoverCaracteristics = async (peripheral: noble.Peripheral): Promise<noble.Characteristic[] | undefined> => {
    const addr = peripheral.address;
    this.log.info(
      `Connected to mesh | ${peripheral.advertisement.localName} (addr: ${addr})`,
    );

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
      return (await peripheral.discoverSomeServicesAndCharacteristicsAsync(services, characteristicIds)).characteristics;
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
    await this.authenticate(authChar);
    await this.setupCommunication(pingChar, lastDataChar);
  };

  private sendToDeviceQueued = async (data: Buffer) => {
    this.sendQueue.unshift(data);
    if (this.sendQueue.length === 1) {
      await this.handleQueuedMessages();
    }
  };

  private handleQueuedMessages = async () => {
    while (this.sendQueue.length > 0 && this.connectedPeripheral && this.dataCharacteristic) {
      const data = this.sendQueue.pop();
      if (!data) {
        return;
      }
      this.log.debug(
        `BLE command sent to ${this.addressBuffer?.toString('hex') ?? 'Unknown'} | ${data.length} bytes | ${data.toString('hex')}`,
      );
      await this.dataCharacteristic.writeAsync(data, false);
      await delay(PLEJD_WRITE_TIMEOUT);
    }
  };

  private startPlejdPing = async (pingChar: noble.Characteristic) => {
    while (this.connectedPeripheral && pingChar) {
      try {
        const ping = randomBytes(1);
        pingChar.writeAsync(ping, false);
        const pong = await pingChar.readAsync();
        if (((ping[0] + 1) & 0xff) !== pong[0]) {
          this.log.error('Ping pong communication failed, missing pong response');
        }
        await delay(PLEJD_PING_TIMEOUT);
      } catch (error) {
        this.log.warn('Ping failed, device disconnected, will retry to connect to mesh: ', error);
        await this.startScanning();
      }
    }
  };

  private handleNotification = async (data: Buffer, isNotification: boolean) => {
    if (!this.connectedPeripheral || !this.addressBuffer || this.addressBuffer?.byteLength === 0) {
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
            'hex',
          )}`,
        );
      }
    }
  };

  private startScanning = async (state: string | undefined = undefined) => {
    if (!state){
      state = noble._state;
    }
    if (state === NOBLE_IS_POWER_ON) {
      this.log.debug('Scanning for Plejd devices');
      await noble.startScanningAsync([PlejdCharacteristics.Service], false);
    }
  };

  private setupCommunication = async (pingChar: noble.Characteristic, lastDataChar: noble.Characteristic) => {
    this.startPlejdPing(pingChar);
    await lastDataChar.subscribeAsync();
    lastDataChar.on('data', async (data, isNotification) => {
      if(!lastDataChar || !this.connectedPeripheral) {
        await lastDataChar.unsubscribeAsync();
        return;
      }
      await this.handleNotification(data, isNotification);
    });
  };

  private authenticate = async (authChar: noble.Characteristic) => {
    await authChar.writeAsync(Buffer.from([0x00]), false);
    const data = await authChar.readAsync();
    await authChar.writeAsync(plejdCharResp(this.config.cryptoKey, data), false);
  };
}
