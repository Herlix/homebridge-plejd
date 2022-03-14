import { existsSync, mkdir, readFileSync, writeFile } from 'fs';
import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { join } from 'path';
import { Device } from './model';

import { PlejdPlatform } from './plejdPlatform';
import { PLATFORM_NAME } from './settings';

interface DeviceState {
  isOn: boolean;
  brightness: number;
}

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class PlejdPlatformAccessory {
  private service: Service;
  private state: DeviceState;
  private cachePath: string;

  constructor(
    private readonly platform: PlejdPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly device: Device,
  ) {
    platform.log.debug(`Adding handler for a ${this.device.model} with id ${this.device.identifier}`);

    const dirPath = join(platform.api.user.storagePath(), 'plugin-persist', 'plejd-cache');
    if(!existsSync(dirPath)) {
      mkdir(dirPath, {recursive: true}, (err) => {
        if (err) {
          this.platform.log.warn('Unable to create storage path |', err);
        }
      });
    }
    this.cachePath = join(dirPath, `${device.identifier}.json`);


    this.state = this.getStoredStateCache();
    this.updateStoredStateCache();

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, PLATFORM_NAME)
      .setCharacteristic(this.platform.Characteristic.Model, this.device.model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.identifier.toString());

    if (this.device.isDimmer) {
      // get the LightBulb service if it exists, otherwise create a new LightBulb service
      this.service = this.accessory.getService(this.platform.Service.Lightbulb) ||
        this.accessory.addService(this.platform.Service.Lightbulb);

      this.service.getCharacteristic(this.platform.Characteristic.Brightness)
        .onGet(this.getBrightness.bind(this))
        .onSet(this.setBrightness.bind(this));
    } else {
      this.service = this.accessory.getService(this.platform.Service.Switch) ||
       this.accessory.addService(this.platform.Service.Switch);
    }

    // register handlers for the On/Off Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    this.service.setCharacteristic(this.platform.Characteristic.Name, this.device.name);
  }

  async setOn(value: CharacteristicValue) {
    const oldVal = this.state.isOn;
    const newVal = value as boolean;
    this.state.isOn = newVal;
    this.updateStoredStateCache();
    this.platform.log.info(`Updating state | ${this.device.name} | to ${ newVal ? 'On' : 'off'} | from ${ oldVal ? 'On' : 'Off'}`);
    this.platform.plejdService.updateState(this.device.identifier, newVal, null);
  }

  async getOn(): Promise<CharacteristicValue> {
    this.platform.log.debug('Get Characteristic On', this.device.name, this.state.isOn);
    // this.platform.plejdService.getState(this.device.identifier);
    return this.state.isOn;
  }

  async setBrightness(value: CharacteristicValue) {
    const oldValue = this.state.brightness;
    const newVal = value as number; // Number between 1-100
    this.state.brightness = newVal;
    this.updateStoredStateCache();
    this.platform.log.info(`Updating brightness | ${this.device.name} | to ${ newVal } | from ${oldValue}`);
    this.platform.plejdService.updateState(this.device.identifier, this.state.isOn, newVal);
  }

  async getBrightness(): Promise<CharacteristicValue> {
    this.platform.log.debug('Get Characteristic Brightness', this.device.name, this.state.brightness);
    return this.state.brightness;
  }

  updateStoredStateCache() {
    if (this.state) {
      writeFile(this.cachePath, JSON.stringify(this.state), 'utf-8', (err) => {
        if (err) {
          this.platform.log.warn('Unable to write cache file.');
        }
      });
    }
  }

  getStoredStateCache(): DeviceState {
    return existsSync(this.cachePath) ? JSON.parse(readFileSync(this.cachePath, 'utf-8')) : { brightness: 100, isOn: false };
  }
}
