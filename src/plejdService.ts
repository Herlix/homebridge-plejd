import { Logger } from 'homebridge';
import { UserInputConfig } from './model';
import { plejdChalResp, plejdEncodeDecode, reverseBuffer } from './plejdUtils';

import { randomBytes } from 'crypto';
import noble from '@abandonware/noble';

const NOBLE_IS_POWER_ON = 'poweredOn';

/**
 * Plejd BLE UUIDs
 */
enum PlejdCharacteristics {
  Service = '31ba000160854726be45040c957391b5',
  Data = '31ba000460854726be45040c957391b5',
  LastData = '31ba000560854726be45040c957391b5',
  Auth = '31ba000960854726be45040c957391b5',
  Ping = '31ba000a60854726be45040c957391b5',
}

enum PlejdCommand {
  StateOnOff = '0097',
  StateDim = '00c8',
  Dim = '0098', // 0-255
  Time = '001b',
  Scene = '0021',
}

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

  /// Brightness should be between 1-100
  updateState(identifier: number, isOn: boolean, brightness?: number) {
    const char = this.dataCharacteristic();
    const addr = this.addressBuffer();
    if (!char || !addr) {
      this.log.warn(`UpdateState | characteristic (${char}) or address (${addr}) not found`);
      return;
    }

    const dimming = brightness !== undefined;
    const command = (isOn && dimming) ? PlejdCommand.Dim : PlejdCommand.StateOnOff;
    const on = isOn ? '01' : '00';

    let payload = Buffer.from((identifier).toString(16).padStart(2, '0') + '0110' + command + on, 'hex');

    if (dimming) {
      const dim = Math.round((2.55 * brightness!)); // Convert to Plejd 0-255
      payload = Buffer.concat([payload, Buffer.from(dim.toString(16).padStart(4, '0'), 'hex')]);
    }

    const data = plejdEncodeDecode(this.config.cryptoKey, addr!, payload);
    this.plejdWrite(char, data);
  }

  //   -------------- Private -------------- \\
  private stateChange(state: string) {
    if (state !== NOBLE_IS_POWER_ON) {
      this.log.debug('stateChange | Stopped | ' + state);
      noble.stopScanning();
    }
    this.log.debug('stateChange | Started | ' + state);
    this.startConnection();
  }

  private startConnection() {
    if (noble.state === NOBLE_IS_POWER_ON) {
      noble.startScanning([PlejdCharacteristics.Service], false);
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

    this.log.debug('Connected | Peripheral |', peripheral);

    peripheral.once('disconnect', () => {
      this.log.info('Peripheral disconnected');
      this.connectedPeripheral = null;
    });
  }

  private discovered(peripheral: noble.Peripheral, services: noble.Service[], characteristics: noble.Characteristic[]) {
    const authChar = characteristics.find((char) => char.uuid === PlejdCharacteristics.Auth);
    const lastDataChar = characteristics.find((char) => char.uuid === PlejdCharacteristics.LastData);
    const pingChar = characteristics.find((char) => char.uuid === PlejdCharacteristics.Ping);

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
          this.log.error(`Ping failed: ${ping[0]} ${pong[0]}`);
          callback(false);
        } else {
          this.log.debug(`Ping success: ${ping[0]} ${pong[0]}`);
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
    const addr = this.addressBuffer();
    if (!addr) {
      return;
    }

    const decodedData = plejdEncodeDecode(this.config.cryptoKey, addr!, data);
    const id = parseInt(decodedData[0].toString(), 10);
    const command = decodedData.toString('hex', 3, 5);
    const argument = parseInt(decodedData.toString('hex', 5, 6), 10);

    this.log.debug(`GotData | id: ${id} | command: ${command} | arg: ${argument} | isNotification: ${isNotification}`);
    switch (command) {
      case PlejdCommand.Time: {
        const arg = parseInt(reverseBuffer(decodedData.slice(5, 9)).toString('hex'), 16);
        const date = new Date(arg * 1000);
        this.log.debug('Time sync: ' + date.toString());
        break;
      }
      case PlejdCommand.Scene: {
        this.log.debug('Trigger scene: ' + argument);
        break;
      }
      case PlejdCommand.Dim:
      case PlejdCommand.StateDim: {
        const dim = parseInt(decodedData.toString('hex', 7, 8), 16);

        // Convert to Homebridge 1-100
        const cdim = dim === 0 ? 1 : ((100 / 255) * dim!);
        this.onUpdate(id, argument, cdim);
        break;
      }
      case PlejdCommand.StateOnOff: {
        this.onUpdate(id, argument);
        break;
      }
      default: {
        this.log.warn(`Unknown command | ${command} | ${id} | ${decodedData.toString('hex')}`);
        break;
      }
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
        return char.uuid === PlejdCharacteristics.Data;
      });
    }
    return null;
  }
}