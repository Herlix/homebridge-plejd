import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { Device } from './model';

import { PlejdPlatform } from './plejdPlatform';
import { PLATFORM_NAME } from './settings';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class PlejdPlatformAccessory {
  private service: Service;
  private device: Device;

  /**
   * These are just used to create a working example
   * You should implement your own code to track the state of your accessory
   */
  private deviceState = {
    On: false,
    Brightness: 100,
  };

  constructor(
    private readonly platform: PlejdPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.device = this.accessory.context.device as Device;

    platform.log.debug(`Adding handler for a ${this.device.model} with id ${this.device.identifier}`);

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
    this.deviceState.On = value as boolean;
    this.platform.log.debug('Set Characteristic On', this.device.name, this.deviceState.On);

    if(this.deviceState.On) {
      this.platform.plejdService.turnOn(this.device.identifier);
    } else {
      this.platform.plejdService.turnOff(this.device.identifier);
    }
  }

  async getOn(): Promise<CharacteristicValue> {
    this.platform.log.debug('Get Characteristic On', this.device.name, this.deviceState.On);
    return this.deviceState.On;
  }

  async setBrightness(value: CharacteristicValue) {
    const dim = value as number;
    this.deviceState.Brightness = dim;
    this.platform.log.debug('Set Characteristic Brightness', this.device.name, dim);
    this.platform.plejdService.turnOn(this.device.identifier, dim === 0 ? 1 : ((100 / 255) * dim!));
  }

  async getBrightness(): Promise<CharacteristicValue> {
    this.platform.log.debug('Get Characteristic Brightness', this.device.name, this.deviceState.Brightness);
    return this.deviceState.Brightness;
  }
}
