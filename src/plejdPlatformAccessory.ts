import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { Device } from './model/device';

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
export class PlejdPlatformAccessoryHandler {
  private service: Service;
  private state: DeviceState;

  constructor(
    private readonly platform: PlejdPlatform,
    private readonly accessory: PlatformAccessory,
    public readonly device: Device,
  ) {
    platform.log.debug(
      `Adding handler for a ${this.device.model} with id ${this.device.identifier}`,
    );

    this.state = {
      brightness: accessory.context.brightness ?? 100,
      isOn: accessory.context.isOn ?? false,
    };

    // set accessory information
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(
        this.platform.Characteristic.Manufacturer,
        PLATFORM_NAME,
      )
      .setCharacteristic(this.platform.Characteristic.Model, this.device.model)
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        this.device.identifier.toString(),
      );

    if (this.device.isDimmer) {
      // get the LightBulb service if it exists, otherwise create a new LightBulb service
      this.service =
        this.accessory.getService(this.platform.Service.Lightbulb) ||
        this.accessory.addService(this.platform.Service.Lightbulb);

      this.service
        .getCharacteristic(this.platform.Characteristic.Brightness)
        .onGet(this.getBrightness.bind(this))
        .onSet(this.setBrightness.bind(this));
    } else {
      this.service =
        this.accessory.getService(this.platform.Service.Switch) ||
        this.accessory.addService(this.platform.Service.Switch);
    }

    // register handlers for the On/Off Characteristic
    this.service
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      this.device.name,
    );
  }

  updateState = (isOn: boolean, brightness?: number) => {
    this.state.isOn = isOn;
    this.platform.log.debug('updateState | Sending isOn', isOn);
    this.service
      .getCharacteristic(this.platform.Characteristic.On)
      .updateValue(isOn);

    if (brightness) {
      this.state.brightness = Math.round(brightness);
      this.platform.log.debug(
        'update state | Sending brightness',
        this.state.brightness,
      );
      this.service
        .getCharacteristic(this.platform.Characteristic.Brightness)
        .updateValue(this.state.brightness);
    }

    this.accessory.context = this.state;
    this.platform.log.debug(`State updated | ${JSON.stringify(this.state)}`);
  };

  private setOn = async (value: CharacteristicValue) => {
    const newVal = value as boolean;
    this.platform.log.info(
      `Updating state | ${this.device.name} | to ${
        newVal ? 'On' : 'off'
      } | from ${this.state.isOn ? 'On' : 'Off'}`,
    );
    this.updateState(newVal, this.state.brightness);
    this.platform.plejdService?.updateState(
      this.device.identifier,
      newVal,
      null,
    );
  };

  private getOn = async (): Promise<CharacteristicValue> => {
    this.platform.log.debug(
      'Get Characteristic On',
      this.device.name,
      this.state.isOn,
    );
    return this.state.isOn;
  };

  private setBrightness = async (value: CharacteristicValue) => {
    const newVal = value as number; // Number between 1-100
    this.platform.log.debug(
      `Updating brightness | ${this.device.name} | to ${newVal} | from ${this.state.brightness}`,
    );
    this.updateState(this.state.isOn, newVal);
    this.platform.plejdService?.updateState(
      this.device.identifier,
      this.state.isOn,
      newVal,
    );
  };

  private getBrightness = async (): Promise<CharacteristicValue> => {
    this.platform.log.debug(
      'Get Characteristic Brightness',
      this.device.name,
      this.state.brightness,
    );
    return this.state.brightness;
  };
}
