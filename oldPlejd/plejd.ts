


import { createHash, createCipheriv, randomBytes } from 'crypto';
import noble from '@abandonware/noble';

import events from 'events';
import util from 'util';
import {
  PLEJD_CHARACTERISTIC_AUTH_UUID,
  PLEJD_CHARACTERISTIC_DATA_UUID,
  PLEJD_CHARACTERISTIC_LAST_DATA_UUID,
  PLEJD_CHARACTERISTIC_PING_UUID,
  PLEJD_SERVICE_UUID,
} from '../src/settings';

module.exports = Plejd;

// 10 = all

function Plejd(key, log) {
  this.log = log;

  this.key = key; // Buffer

  this.pingIndex = null;
  this.connectedPeripheral = null;

  noble.on('stateChange', this.stateChange.bind(this));
}

util.inherits(Plejd, events.EventEmitter);

// Lazy varaibales
Plejd.prototype.dataCharacteristic = function () {
  if (this.connectedPeripheral && this.connectedPeripheral.services.length > 0) {
    return this.connectedPeripheral.services[0].characteristics.find((char) => {
      return char.uuid === PLEJD_CHARACTERISTIC_DATA_UUID;
    });
  }
  return null;
};

Plejd.prototype.addressBuffer = function () {
  if (this.connectedPeripheral) {
    return reverseBuffer(Buffer.from(String(this.connectedPeripheral.address).replace(':', ''), 'hex'));
  }
  return null;
};

// Start
Plejd.prototype.stateChange = function (state) {
  if (state !== 'poweredOn') {
    this.log('Stopped | ' + state);
    noble.stopScanning();
  }

  this.log('Started | ' + state);

  this.startConnection();
};

Plejd.prototype.startConnection = function () {
  if (noble.state === 'poweredOn') {
    noble.startScanning([PLEJD_SERVICE_UUID], false);
    noble.once('discover', this.discover.bind(this)); // Only once
  }
};

Plejd.prototype.disconnect = function (callback) {
  clearInterval(this.pingIndex);

  if (this.connectedPeripheral) {
    this.log('Disconnecting peripheral');

    this.connectedPeripheral.disconnect(function (error) {
      if (error) {
        log('Error disconnecting peripheral');
      }

      connectedPeripheral = null;

      this.log('Disconnected');

      if (callback) {
        callback();
      }
    });
  } else {
    this.log('Already disconnected');

    if (callback) {
      callback();
    }
  }
};

Plejd.prototype.discover = function (peripheral) {
  this.log('Discovered | ' + peripheral.advertisement.localName + ' (' + peripheral.address + ') | RSSI ' + peripheral.rssi + 'dB');

  noble.stopScanning();

  peripheral.connect((error) => {
    this.connectToPeripheral(peripheral, error);
  });
};

Plejd.prototype.connectToPeripheral = function (peripheral, error) {
  if (error) {
    this.log('Connecting failed | ' + peripheral.advertisement.localName + ' (' + peripheral.address + ') | ' + error);
    return;
  }

  this.connectedPeripheral = peripheral;

  this.log('Connected | ' + peripheral.advertisement.localName + ' (' + peripheral.address + ')');

  const services = [PLEJD_SERVICE_UUID];
  const characteristics = [
    PLEJD_CHARACTERISTIC_DATA_UUID,
    PLEJD_CHARACTERISTIC_LAST_DATA_UUID,
    PLEJD_CHARACTERISTIC_AUTH_UUID,
    PLEJD_CHARACTERISTIC_PING_UUID];

  peripheral.discoverSomeServicesAndCharacteristics(services, characteristics, (error, services, characteristics) => {
    this.discovered(error, peripheral, services, characteristics);
  });

  peripheral.once('disconnect', () => {
    this.log('Peripheral disconnected');
    this.connectedPeripheral = null;
  });
};

Plejd.prototype.discovered = function (error, peripheral, services, characteristics) {
  if (error) {
    this.log('Discover failed | ' + peripheral.advertisement.localName + ' (' + peripheral.address + ') | ' + error);
    return;
  }

  const authChar = characteristics.find((char) => {
    return char.uuid === PLEJD_CHARACTERISTIC_AUTH_UUID;
  });

  const lastDataChar = characteristics.find((char) => {
    return char.uuid === PLEJD_CHARACTERISTIC_LAST_DATA_UUID;
  });

  const pingChar = characteristics.find((char) => {
    return char.uuid === PLEJD_CHARACTERISTIC_PING_UUID;
  });

  this.plejdAuth(authChar, () => {
    this.startPlejdPing(pingChar);

    lastDataChar.subscribe((error) => {
      if (error) {
        this.log('Error subscribing | ' + error);
        return;
      }

      lastDataChar.on('data', this.gotData.bind(this));
    });
  });
};

Plejd.prototype.gotData = function (data, isNotification) {
  const decodedData = plejdEncodeDecode(this.key, this.addressBuffer(), data);

  let state = 0;

  const id = parseInt(decodedData[0].toString(), 10);
  const command = decodedData.toString('hex', 3, 5);
  const argument = parseInt(decodedData.toString('hex', 5, 6), 10);

  this.log('--');
  this.log(decodedData);

  if (command === '001b') {
    // time
    const argument = parseInt(reverseBuffer(decodedData.slice(5, 9)).toString('hex'), 16);
    const date = new Date(argument * 1000);

    this.log('Time sync: ' + date.toString());
    return;
  } else if (command === '0021') {
    // scene
    this.log('Trigger scene: ' + argument);
    return;
  } else if (command === '00c8' || command === '0098') {
    // 00c8, 0098 = state + dim
    // state 0 or 1
    state = argument;
    const dim = parseInt(decodedData.toString('hex', 7, 8), 16);

    this.log(id + ' state: ' + state + ' dim: ' + dim);

    this.emit('updateDevice', id, state, dim);
  } else if (command === '0097') {
    // 0097 = state only
    // state 0 or 1
    state = argument;

    this.log(id + ' state: ' + state);

    this.emit('updateDevice', id, state);
    return;
  } else {
    this.log('Unknown command: ' + command + ' for device: ' + id + ' ' + (decodedData.toString('hex')));
    return;
  }
};

Plejd.prototype.turnOn = function (device, brightness) {
  const char = this.dataCharacteristic();
  if (!char) {
    return;
  }

  const command = (brightness !== null) ? '0098' : '0097';

  let payload = Buffer.from((device).toString(16).padStart(2, '0') + '0110' + command + '01', 'hex');

  if (brightness !== null) {
    payload = Buffer.concat([payload, Buffer.from(brightness.toString(16).padStart(4, '0'), 'hex')]);
  }

  const data = plejdEncodeDecode(this.key, this.addressBuffer(), payload);
  this.plejdWrite(char, data);
};

Plejd.prototype.turnOff = function (device) {
  const char = this.dataCharacteristic();
  if (!char) {
    return;
  }

  const payload = Buffer.from((device).toString(16).padStart(2, '0') + '0110009700', 'hex');
  const data = plejdEncodeDecode(this.key, this.addressBuffer(), payload);
  this.plejdWrite(char, data);
};

Plejd.prototype.startPlejdPing = function (pingChar) {
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
};

// Plejd Helpers
Plejd.prototype.plejdWrite = function (dataChar, data) {
  dataChar.write(data, false, (error) => {
    if (error) {
      this.log('Error writing data | ' + error);
      return;
    }
  });
};

Plejd.prototype.plejdAuth = function (authChar, callback) {
  if (authChar === null || authChar === undefined) {
    return;
  }
  authChar.write(Buffer.from([0x00]), false, (error) => {
    if (error) {
      this.log('Error writing auth start | ' + error);
    }

    authChar.read((error, data) => {
      if (error) {
        this.log('Error reading auth | ' + error);
      }

      authChar.write(plejdChalResp(this.key, data), false, (error) => {
        if (error) {
          this.log('Error writing auth chal | ' + error);
        }

        callback();
      });
    });
  });
};

Plejd.prototype.plejdPing = function (pingChar, callback) {
  const ping = randomBytes(1);

  pingChar.write(ping, false, (error) => {
    if (error) {
      this.log('Error sending ping | ' + error);
      return callback(false);
    }

    pingChar.read((error, pong) => {
      if (error) {
        this.log('Error reading pong | ' + error);
        return callback(false);
      }

      if (((ping[0] + 1) & 0xff) !== pong[0]) {
        this.log('Ping failed: ' + ping[0] + ' ' + pong[0]);
        callback(false);
      } else {
        this.log('Ping success: ' + ping[0] + ' ' + pong[0]);
        callback(true);
      }
    });
  });
};

// Plejd Utilities
function plejdChalResp(key, chal) {
  const intermediate = createHash('sha256').update(xor(key, chal)).digest();

  const part1 = intermediate.slice(0, 16);
  const part2 = intermediate.slice(16);

  return xor(part1, part2);
}

function plejdEncodeDecode(key, adressBuffer, data): Buffer {
  const buf = Buffer.concat([adressBuffer, adressBuffer, adressBuffer.subarray(0, 4)]);

  const cipher = createCipheriv('aes-128-ecb', key, '');
  cipher.setAutoPadding(false);

  let ct = cipher.update(buf).toString('hex');
  ct += cipher.final().toString('hex');
  const ctBuff = Buffer.from(ct, 'hex');

  let output = '';
  for (let i = 0, length = data.length; i < length; i++) {
    output += String.fromCharCode(data[i] ^ ctBuff[i % 16]);
  }

  return Buffer.from(output, 'ascii');
}

// Utilities
function xor(first: Buffer, second: Buffer): Buffer {
  const result = Buffer.alloc(first.length);
  for (let i = 0; i < first.length; i++) {
    result[i] = first[i] ^ second[i];
  }
  return result;
}

function reverseBuffer(src: Buffer): Buffer {
  const buffer = Buffer.allocUnsafe(src.length);

  for (let i = 0, j = src.length - 1; i <= j; ++i, --j) {
    buffer[i] = src[j];
    buffer[j] = src[i];
  }

  return buffer;
}