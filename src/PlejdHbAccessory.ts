import {
  Service,
  PlatformAccessory,
  CharacteristicValue,
  Logger,
} from "homebridge";
import { Device } from "./model/device.js";

import { PlejdHbPlatform } from "./PlejdHbPlatform.js";
import {
  DEFAULT_BRIGHTNESS_TRANSITION_MS,
  PLATFORM_NAME,
} from "./constants.js";

interface DeviceState {
  isOn: boolean;
  brightness: number;
  transitionDuration: number;
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
  ) {
    this.state = {
      brightness: accessory.context.brightness ?? 100,
      isOn: accessory.context.isOn ?? false,
      transitionDuration: accessory.context.transitionDuration ?? 0,
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

      const durationChar =
        this.service.getCharacteristic(
          this.platform.Characteristic.SetDuration,
        ) ||
        this.service.addCharacteristic(
          this.platform.Characteristic.SetDuration,
        );

      durationChar
        .setProps({
          minValue: 0,
          maxValue: 3600000,
          minStep: 100,
        })
        .onSet(this.setTransitionDuration.bind(this))
        .onGet(this.getTransitionDuration.bind(this));

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
    const newState = value as boolean;
    this.log.info(
      `Homekit: turning ${value === true ? "on" : "off"} ${this.device.name} (current state: isOn=${this.state.isOn}, brightness=${this.state.brightness})`,
    );

    if (this.state.isOn === newState) {
      this.log.debug(
        `${this.device.name} already ${newState ? "on" : "off"}, skipping`,
      );
      return;
    }

    await this.platform.plejdService?.updateState(
      this.device.identifier,
      value as boolean,
    );
    this.state.isOn = value as boolean;
  };

  private getOn = (): CharacteristicValue => this.state.isOn;

  private setBrightness = async (value: CharacteristicValue) => {
    this.log.debug(
      `Homekit: Set brightness of ${this.device.name} to ${value}`,
    );
    const transitionMs =
      this.state.transitionDuration > 0
        ? this.state.transitionDuration
        : DEFAULT_BRIGHTNESS_TRANSITION_MS;

    await this.platform.plejdService?.updateState(
      this.device.identifier,
      true,
      {
        targetBrightness: value as number,
        currentBrightness: this.state.brightness,
        transitionMs,
      },
    );

    this.state.brightness = value as number;
    this.state.isOn = true;
  };

  private getBrightness = (): CharacteristicValue => this.state.brightness;

  private setTransitionDuration = async (value: CharacteristicValue) => {
    this.state.transitionDuration = value as number;
    this.accessory.context.transitionDuration = this.state.transitionDuration;
    this.log.debug(
      `Set transition duration for ${this.device.name} to ${value}ms`,
    );
  };

  private getTransitionDuration = (): CharacteristicValue =>
    this.state.transitionDuration;
}
