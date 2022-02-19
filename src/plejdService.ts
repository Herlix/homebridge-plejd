import { Logger } from 'homebridge';
import { UserInputConfig } from './model';
import { plejdChalResp, plejdEncodeDecode, reverseBuffer } from './plejdUtils';

import { randomBytes } from 'crypto';
import noble from '@abandonware/noble';
import {
  PLEJD_CHARACTERISTIC_AUTH_UUID,
  PLEJD_CHARACTERISTIC_DATA_UUID,
  PLEJD_CHARACTERISTIC_LAST_DATA_UUID,
  PLEJD_CHARACTERISTIC_PING_UUID,
  PLEJD_SERVICE_UUID,
} from './settings';

const NOBLE_IS_POWER_ON = 'poweredOn';

export class PlejdService {
  private connectedPeripheral!: noble.Peripheral | null;
  private pingIndex!: NodeJS.Timer;

  constructor(
        private readonly config: UserInputConfig,
        public readonly log: Logger,
        private readonly onUpdate: (identifier: number, state: number, dim?: number) => void) {

    noble.on('stateChange', (state) => this.stateChange(state));

    noble.on('warning', (msg) => this.log.warn('Noble warning: ', msg));
  }


  turnOn(identifier: number, brightness?: number) {
    const char = this.dataCharacteristic();
    if (!char) {
      this.log.warn('TurnOn characteristic not found');
      return;
    }
    const command = (brightness !== undefined) ? '0098' : '0097';

    let payload = Buffer.from((identifier).toString(16).padStart(2, '0') + '0110' + command + '01', 'hex');

    if (brightness !== undefined) {
      payload = Buffer.concat([payload, Buffer.from(brightness!.toString(16).padStart(4, '0'), 'hex')]);
    }

    const addr = this.addressBuffer();
    if (!addr) {
      return;
    }
    const data = plejdEncodeDecode(this.config.cryptoKey, addr!, payload);
    this.plejdWrite(char, data);
  }

  turnOff(identifier: number) {
    const char = this.dataCharacteristic();
    const addr = this.addressBuffer();
    if (!char || !addr) {
      return;
    }

    const payload = Buffer.from((identifier).toString(16).padStart(2, '0') + '0110009700', 'hex');
    const data = plejdEncodeDecode(this.config.cryptoKey, addr!, payload);
    this.plejdWrite(char, data);

  }

  //   -------------- Private -------------- \\
  private stateChange(state: string) {
    if (state !== NOBLE_IS_POWER_ON) {
      this.log.debug('stateChange: Stopped | ' + state);
      noble.stopScanning();
    }
    this.log.debug('stateChange: Started | ' + state);
    this.startConnection();
  }

  private startConnection() {
    if (noble.state === NOBLE_IS_POWER_ON) {
      noble.startScanning([PLEJD_SERVICE_UUID], false);
      noble.once('discover', (peripheral) => this.discover(peripheral));
    }
  }

  private discover(peripheral: noble.Peripheral) {
    this.log.info(`Discovered | ${peripheral.advertisement.localName} | addr: ${peripheral.address} | RSSI: ${peripheral.rssi} dB`);

    noble.stopScanning();

    peripheral.connect((error) => {
      if (error) {
        this.log.error(`Connecting failed | ${peripheral.advertisement.localName} | addr: ${peripheral.address}) - err: ${error}`);
        return;
      }
      this.connectToPeripheral(peripheral);
    });
  }

  private connectToPeripheral(peripheral: noble.Peripheral) {
    this.log.info(`Connected | ${peripheral.advertisement.localName} (addr: ${peripheral.address})`);

    this.connectedPeripheral = peripheral;

    const services = [PLEJD_SERVICE_UUID];
    const characteristics = [
      PLEJD_CHARACTERISTIC_DATA_UUID,
      PLEJD_CHARACTERISTIC_LAST_DATA_UUID,
      PLEJD_CHARACTERISTIC_AUTH_UUID,
      PLEJD_CHARACTERISTIC_PING_UUID];

    peripheral.discoverSomeServicesAndCharacteristics(services, characteristics, (error, services, characteristics) => {
      if (error) {
        this.log.error('Discover failed | ' + peripheral.advertisement.localName + ' (' + peripheral.address + ') | ' + error);
        return;
      }

      this.discovered(peripheral, services, characteristics);
    });

    this.log.debug('Connected - Peripheral: ', peripheral);

    peripheral.once('disconnect', () => {
      this.log.info('Peripheral disconnected');
      this.connectedPeripheral = null;
    });
  }

  private discovered(peripheral: noble.Peripheral, services: noble.Service[], characteristics: noble.Characteristic[]) {
    const authChar = characteristics.find((char) => char.uuid === PLEJD_CHARACTERISTIC_AUTH_UUID);
    const lastDataChar = characteristics.find((char) => char.uuid === PLEJD_CHARACTERISTIC_LAST_DATA_UUID);
    const pingChar = characteristics.find((char) => char.uuid === PLEJD_CHARACTERISTIC_PING_UUID);

    if(!authChar || !lastDataChar || !pingChar) {
      this.log.error('Unable to extract characteristic during discovery', authChar, lastDataChar, pingChar);
      return;
    }

    this.plejdAuth(authChar!, () => {
      this.startPlejdPing(pingChar);

            lastDataChar!.subscribe((error) => {
              if (error) {
                this.log.error('Error subscribing | ' + error);
                return;
              }

              lastDataChar!.on('data', (data, isNotification) => this.gotData(data, isNotification));
            });
    });
  }

  private plejdAuth(authChar: noble.Characteristic, callback: () => void) {
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

        authChar.write(plejdChalResp(this.config.cryptoKey, data), false, (error) => {
          if (error) {
            this.log.error('Error writing auth chal | ' + error);
            return;
          }

          callback();
        });
      });

    });
  }

  private startPlejdPing(pingChar) {
    clearInterval(this.pingIndex);
    this.pingIndex = setInterval(() => {
      if (this.connectedPeripheral) {
        this.plejdPing(pingChar, (pingOk) => {
          if (pingOk === false) {
            this.disconnect(() => {
              this.startConnection();
            });
          }
        });
      } else {
        this.disconnect(() => {
          this.startConnection();
        });
      }
    }, 1000 * 60 * 3);
  }

  private plejdPing(pingChar: noble.Characteristic, callback: (boolean) => void) {
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
          this.log.error('Ping failed: ' + ping[0] + ' ' + pong[0]);
          callback(false);
        } else {
          this.log.error('Ping success: ' + ping[0] + ' ' + pong[0]);
          callback(true);
        }
      });
    });
  }

  private disconnect(callback: () => void) {
    clearInterval(this.pingIndex);

    if (this.connectedPeripheral) {
      this.log.info('Disconnecting peripheral');

      this.connectedPeripheral.disconnect(() => {
        this.connectedPeripheral = null;
        if (callback) {
          callback();
          return;
        }
      });
    }

    if (callback) {
      callback();
    }
  }

  private gotData(data: Buffer, isNotification: boolean) {
    this.log.debug(`GotData: data: ${data} - isNotification: ${isNotification}`);
    const addr = this.addressBuffer();
    if (!addr) {
      return;
    }

    const decodedData = plejdEncodeDecode(this.config.cryptoKey, addr!, data);
    let state = 0;

    const id = parseInt(decodedData[0].toString(), 10);
    const command = decodedData.toString('hex', 3, 5);
    const argument = parseInt(decodedData.toString('hex', 5, 6), 10);

    if (command === '001b') {
      // time
      const argument = parseInt(reverseBuffer(decodedData.slice(5, 9)).toString('hex'), 16);
      const date = new Date(argument * 1000);

      this.log.debug('Time sync: ' + date.toString());
      return;
    } else if (command === '0021') {
      // scene
      this.log.debug('Trigger scene: ' + argument);
      return;
    } else if (command === '00c8' || command === '0098') {
      // 00c8, 0098 = state + dim
      // state 0 or 1
      state = argument;
      const dim = parseInt(decodedData.toString('hex', 7, 8), 16);

      this.log.debug(id + ' state: ' + state + ' dim: ' + dim);

      this.onUpdate(id, state, dim);
    } else if (command === '0097') {
      // 0097 = state only
      // state 0 or 1
      state = argument;

      this.log.debug(id + ' state: ' + state);

      this.onUpdate(id, state);
      return;
    } else {
      this.log.warn('Unknown command: ' + command + ' for device: ' + id + ' ' + (decodedData.toString('hex')));
      return;
    }
  }

  private plejdWrite(dataChar: noble.Characteristic, data: Buffer) {
    dataChar.write(data, false, (error) => {
      if (error) {
        this.log.error('Error writing data | ' + error);
        return;
      }
    });
  }

  private addressBuffer() {
    if (this.connectedPeripheral) {
      return reverseBuffer(Buffer.from(String(this.connectedPeripheral.address).replace(/:/g, ''), 'hex'));
    }
    return null;
  }

  private dataCharacteristic() {
    if (this.connectedPeripheral && this.connectedPeripheral.services.length > 0) {
      return this.connectedPeripheral.services[0].characteristics.find((char) => {
        return char.uuid === PLEJD_CHARACTERISTIC_DATA_UUID;
      });
    }
    return null;
  }
}