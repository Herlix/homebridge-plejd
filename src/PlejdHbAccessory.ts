import {
  Service,
  PlatformAccessory,
  CharacteristicValue,
  Logger,
} from "homebridge";
import { Device } from "./model/device.js";

import { PlejdHbPlatform } from "./PlejdHbPlatform.js";
import { PLATFORM_NAME } from "./constants.js";

interface DeviceState {
  isOn: boolean;
  brightness: number;
}

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class PlejdHbAccessory {
  private service: Service;
  private state: DeviceState;

  constructor(
    private readonly platform: PlejdHbPlatform,
    private readonly log: Logger,
    private readonly accessory: PlatformAccessory,
    public readonly device: Device,
    private readonly brightnessDelayMs?: number,
  ) {
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

  onPlejdUpdates = (isOn: boolean, brightness?: number) => {
    this.platform.log.debug(
      `Updating Homekit state from ${this.device.name} device state`,
    );
    this.state.isOn = isOn;

    this.service
      .getCharacteristic(this.platform.Characteristic.On)
      .updateValue(isOn);

    if (brightness) {
      this.state.brightness = Math.round(brightness);
      this.service
        .getCharacteristic(this.platform.Characteristic.Brightness)
        .updateValue(this.state.brightness);
    }

    this.accessory.context = this.state;
  };

  private setOn = async (value: CharacteristicValue) => {
    this.log.debug(`Homekit: Turn on ${this.device.name}`);
    await this.platform.plejdService?.updateState(
      this.device.identifier,
      value as boolean,
      {
        targetBrightness: this.state.brightness,
        currentBrightness: this.state.brightness,
        transitionMS: this.brightnessDelayMs,
      },
    );
  };

  private getOn = (): CharacteristicValue => this.state.isOn;

  private setBrightness = async (value: CharacteristicValue) => {
    this.log.debug(`Homekit: Set brightness of ${this.device.name}`);
    await this.platform.plejdService?.updateState(
      this.device.identifier,
      this.state.isOn,
      {
        targetBrightness: value as number,
        currentBrightness: this.state.brightness,
        transitionMS: this.brightnessDelayMs,
      },
    );
  };

  private getBrightness = (): CharacteristicValue => this.state.brightness;
}
