import { Logger } from 'homebridge';
import { UserInputConfig } from './model/userInputConfig';
import { plejdChalResp as plejdCharResp, plejdEncodeDecode, reverseBuffer } from './plejdUtils';

import { randomBytes } from 'crypto';
import noble from '@abandonware/noble';

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
  Time = '001b',
  Scene = '0021',
  RequestResponse = '0102',
  RequestNoResponse = '0110',
  RequestReadValue = '0103',
  ButtonClick = '1006'
}

export class PlejdService {
  private connectedPeripheral: noble.Peripheral | null;
  private addressBuffer: Buffer | null;
  private dataCharacteristic: noble.Characteristic | null;
  private pingIndex!: NodeJS.Timer;

  constructor(
    private readonly config: UserInputConfig,
    public readonly log: Logger,
    private readonly onUpdate: (identifier: number, isOn: boolean, dim?: number) => void) {

    this.addressBuffer = null;
    this.dataCharacteristic = null;
    this.connectedPeripheral = null;

    noble.on('stateChange', (state) => this.stateChange(state));
    noble.on('warning', (msg) => this.log.warn('Noble warning: ', msg));
  }

  /// Brightness should be between 1-100
  updateState = (identifier: number, isOn: boolean, brightness: number | null) => {
    if (!this.dataCharacteristic || !this.addressBuffer) {
      this.log.warn(`UpdateState | characteristic (${this.dataCharacteristic}) or address (${this.addressBuffer}) not found`);
      return;
    }

    const dimming = brightness !== null;
    const command = (isOn && dimming) ? PlejdCommand.Brightness : PlejdCommand.UpdateState;
    const on = isOn ? '01' : '00';

    let payload = Buffer.from((identifier).toString(16).padStart(2, '0') + PlejdCommand.RequestNoResponse + command + on, 'hex');

    if (dimming) {
      const dim = Math.round((2.55 * brightness)); // Convert to Plejd 0-255
      this.log.debug(`Dim value sent over BLE ${dim}`);
      payload = Buffer.concat([payload, Buffer.from(dim.toString(16).padStart(4, '0'), 'hex')]);
    }

    this.log.debug('UpdateState:', this.config.cryptoKey, this.addressBuffer, payload);
    const data = plejdEncodeDecode(this.config.cryptoKey, this.addressBuffer, payload);
    if (this.dataCharacteristic) {
      this.plejdWrite(this.dataCharacteristic, data);
    }
  };

  //   -------------- Private -------------- \\
  private stateChange = (state: string) => {
    if (state !== NOBLE_IS_POWER_ON) {
      this.log.debug('stateChange | Stopped | ' + state);
      noble.stopScanning();
    }
    this.log.debug('stateChange | Started | ' + state);
    this.startConnection();
  };

  private startConnection = () => {
    if (this.connectedPeripheral === null || noble.state === 'disconnected') {
      noble.startScanning([PlejdCharacteristics.Service], false, (e) => {
        if (e) {
          this.log.error('Unable to start scanning', e);
        }
      });
      noble.once('discover', (peripheral) => this.discover(peripheral));

    } else {
      this.connectedPeripheral?.cancelConnect();
      this.connectedPeripheral.connect((e) => {
        this.log.error('Unable to reconnect', e);
      });
    }
  };

  private discover = (peripheral: noble.Peripheral) => {
    this.log.info(`Discovered | ${peripheral.advertisement.localName} | addr: ${peripheral.address} | RSSI: ${peripheral.rssi} dB`);

    noble.stopScanning();

    peripheral.connect((error) => {
      if (error) {
        this.log.error(`Connecting failed | ${peripheral.advertisement.localName} | addr: ${peripheral.address}) - err: ${error}`);
        this.startConnection();
        return;
      }
      this.connectToPeripheral(peripheral);
    });
  };

  private connectToPeripheral = (peripheral: noble.Peripheral) => {
    this.log.info(`Connected | ${peripheral.advertisement.localName} (addr: ${peripheral.address})`);

    this.connectedPeripheral = peripheral;
    this.log.debug('haa', this.connectedPeripheral);
    this.addressBuffer = reverseBuffer(Buffer.from(String(peripheral.address).replace(/:/g, ''), 'hex'));


    const services = [PlejdCharacteristics.Service];
    const characteristics = [
      PlejdCharacteristics.Data,
      PlejdCharacteristics.LastData,
      PlejdCharacteristics.Auth,
      PlejdCharacteristics.Ping];

    peripheral.discoverSomeServicesAndCharacteristics(services, characteristics, (error, services, characteristics) => {
      if (error) {
        this.log.error(`Discover failed | ${peripheral.advertisement.localName} (${peripheral.address}) | ${error}`);
        return;
      }

      this.discovered(peripheral, services, characteristics);
    });

    peripheral.once('disconnect', () => {
      this.log.info('Peripheral disconnected');
    });
  };

  private discovered = (peripheral: noble.Peripheral, services: noble.Service[], characteristics: noble.Characteristic[]) => {
    const authChar = characteristics.find((char) => char.uuid === PlejdCharacteristics.Auth);
    const lastDataChar = characteristics.find((char) => char.uuid === PlejdCharacteristics.LastData);
    const pingChar = characteristics.find((char) => char.uuid === PlejdCharacteristics.Ping);
    this.dataCharacteristic = peripheral?.services[0]?.characteristics?.find((char) => char.uuid === PlejdCharacteristics.Data) ?? null;

    if (!authChar || !lastDataChar || !pingChar) {
      this.log.error('Unable to extract characteristic during discovery', authChar, lastDataChar, pingChar);
      return;
    }

    this.plejdAuth(authChar, () => {
      this.startPlejdPing(pingChar);

      lastDataChar.subscribe((error) => {
        if (error) {
          this.log.error('Error subscribing | ' + error);
          return;
        }

        lastDataChar.on('data', (data, isNotification) => this.gotData(data, isNotification));
      });
    });
  };

  private plejdAuth = (authChar: noble.Characteristic, callback: () => void) => {
    authChar.write(Buffer.from([0x00]), false, (error: string) => {
      if (error) {
        this.log.error('Error writing auth start | ' + error);
        return;
      }


      authChar.read((error, data) => {
        if (error) {
          this.log.error('Error reading auth | ' + error);
          return;
        }

        authChar.write(plejdCharResp(this.config.cryptoKey, data), false, (error) => {
          if (error) {
            this.log.error('Error writing auth char | ' + error);
            return;
          }

          callback();
        });
      });

    });
  };

  private startPlejdPing = (pingChar) => {
    clearInterval(this.pingIndex);
    this.pingIndex = setInterval(() => {
      if (this.connectedPeripheral) {
        this.plejdPing(pingChar, (pingOk) => {
          if (!pingOk) {
            this.disconnect(() => {
              this.startConnection();
            });
          }
        });
      }
    }, 1000 * 60 * 3);
  };

  private plejdPing = (pingChar: noble.Characteristic, callback: (boolean) => void) => {
    const ping = randomBytes(1);

    pingChar.write(ping, false, (error) => {
      if (error) {
        this.log.error('Error sending ping | ' + error);
        return callback(false);
      }

      pingChar.read((error, pong) => {
        if (error) {
          this.log.error('Error reading pong | ' + error);
          return callback(false);
        }

        if (((ping[0] + 1) & 0xff) !== pong[0]) {
          this.log.error(`Ping failed: ${ping[0]} ${pong[0]}`);
          callback(false);
        } else {
          this.log.debug(`Ping success: ${ping[0]} ${pong[0]}`);
          callback(true);
        }
      });
    });
  };

  private disconnect = (callback: () => void) => {
    if (!this.pingIndex) {
      return;
    }
    clearInterval(this.pingIndex);

    if (this.connectedPeripheral) {
      this.log.info('Disconnecting peripheral');
      this.connectedPeripheral.disconnect();
    }

    if (callback) {
      callback();
    }
  };

  private gotData = (data: Buffer, isNotification: boolean) => {
    if (!this.addressBuffer || this.addressBuffer?.byteLength === 0) {
      this.log.warn('Got data but address in unknown');
      return;
    }
    this.log.debug('GotData:', this.config.cryptoKey, this.addressBuffer, data);
    const decodedData = plejdEncodeDecode(this.config.cryptoKey, this.addressBuffer, data);
    const id = parseInt(decodedData[0].toString(), 10);
    const command = decodedData.toString('hex', 3, 5);

    const isOn = parseInt(decodedData.toString('hex', 5, 6), 10) === 1;

    const commandType = Object.values(PlejdCommand).find(x => x.toString() === command) ?? 'Unknown';
    // eslint-disable-next-line max-len
    this.log.debug(`GotData | id: ${id} | Command: ${command} - ${commandType} | On: ${isOn} | Notification: ${isNotification} | payload: ${decodedData.toString('hex')}`);

    switch (command) {
      case PlejdCommand.Time: {
        const arg = parseInt(reverseBuffer(decodedData.slice(5, 9)).toString('hex'), 16);
        const date = new Date(arg * 1000);
        this.log.debug('Time sync: ' + date.toString());
        break;
      }
      case PlejdCommand.Scene: {
        this.log.debug('Trigger scene: ' + isOn);
        break;
      }
      case PlejdCommand.Brightness:
      case PlejdCommand.StateBrightness: {
        const dim = parseInt(decodedData.toString('hex', 7, 8), 16);

        // Convert to Homebridge 1-100
        const converted = dim === 0 ? 1 : ((100 / 255) * dim);
        this.onUpdate(id, isOn, converted);
        break;
      }
      case PlejdCommand.UpdateState: {
        this.onUpdate(id, isOn);
        break;
      }
      case PlejdCommand.ButtonClick: {
        this.onUpdate(id, isOn);
        break;
      }
      default: {
        this.log.warn(`Unknown | command: ${command} | id: ${id} | ${decodedData.toString('hex')}`);
        break;
      }
    }
  };

  private plejdWrite = (dataChar: noble.Characteristic, data: Buffer) => {
    dataChar.write(data, false, (error) => {
      if (error) {
        this.log.error('Error writing data | ' + error);
        return;
      }
    });
  };
}