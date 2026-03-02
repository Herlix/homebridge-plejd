import { Service, PlatformAccessory, CharacteristicValue } from "homebridge";
import { Device } from "./model/device.js";

import { PlejdHbPlatform } from "./PlejdHbPlatform.js";
import { PLATFORM_NAME } from "./constants.js";

interface DeviceState {
  isOn: boolean;
  brightness: number;
  transitionMs: number;
}

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class PlejdHbAccessory {
  private service: Service;
  private state: DeviceState;
  private motionResetTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly platform: PlejdHbPlatform,
    private readonly accessory: PlatformAccessory,
    public readonly device: Device,
    private readonly transitionMs: number,
    private readonly motionResetMs: number,
  ) {
    this.state = {
      brightness: accessory.context.brightness ?? 100,
      isOn: accessory.context.isOn ?? false,
      transitionMs,
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
        this.device.identifier ? this.device.identifier.toString() : this.device.uuid,
      )
      .setCharacteristic(this.platform.Characteristic.Name, this.device.name);

    if (this.device.outputType === "SENSOR") {
      // Remove stale services from previous type assignments
      for (const staleService of [
        this.platform.Service.Switch,
        this.platform.Service.Lightbulb,
      ]) {
        const existing = this.accessory.getService(staleService);
        if (existing) {
          this.platform.log.info(
            `Removing stale service from ${this.device.name} (now SENSOR)`,
          );
          this.accessory.removeService(existing);
        }
      }

      this.service =
        this.accessory.getService(this.platform.Service.MotionSensor) ||
        this.accessory.addService(this.platform.Service.MotionSensor);

      this.service
        .getCharacteristic(this.platform.Characteristic.MotionDetected)
        .onGet(() => this.state.isOn);
    } else if (this.device.outputType === "LIGHT") {
      // Remove Switch service if it exists (device type may have changed)
      const existingSwitch = this.accessory.getService(
        this.platform.Service.Switch,
      );
      if (existingSwitch) {
        this.platform.log.info(
          `Removing stale Switch service from ${this.device.name} (now LIGHT)`,
        );
        this.accessory.removeService(existingSwitch);
      }

      this.service =
        this.accessory.getService(this.platform.Service.Lightbulb) ||
        this.accessory.addService(this.platform.Service.Lightbulb);

      this.service
        .getCharacteristic(this.platform.Characteristic.Brightness)
        .onGet(this.getBrightness.bind(this))
        .onSet(this.setBrightness.bind(this));
    } else {
      // Remove Lightbulb service if it exists (device type may have changed)
      const existingLightbulb = this.accessory.getService(
        this.platform.Service.Lightbulb,
      );
      if (existingLightbulb) {
        this.platform.log.info(
          `Removing stale Lightbulb service from ${this.device.name} (now RELAY)`,
        );
        this.accessory.removeService(existingLightbulb);
      }

      this.service =
        this.accessory.getService(this.platform.Service.Switch) ||
        this.accessory.addService(this.platform.Service.Switch);
    }

    if (this.device.outputType !== "SENSOR") {
      // register handlers for the On/Off Characteristic
      this.service
        .getCharacteristic(this.platform.Characteristic.On)
        .onSet(this.setOn.bind(this))
        .onGet(this.getOn.bind(this));
    }

    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      this.device.name,
    );
  }

  onPlejdUpdates = (isOn: boolean, brightness?: number) => {
    if (this.device.outputType === "SENSOR") {
      this.state.isOn = true;
      this.service
        .getCharacteristic(this.platform.Characteristic.MotionDetected)
        .updateValue(true);

      // Only start the auto-reset timer if one isn't already running.
      // The sensor broadcasts every ~30s while motion is active;
      // resetting the 75s timer each time would prevent it from ever firing.
      if (!this.motionResetTimer) {
        this.platform.log.info(
          `Motion detected from ${this.device.name}, will auto-reset in ${this.motionResetMs / 1000}s`,
        );
        this.motionResetTimer = setTimeout(() => {
          this.motionResetTimer = undefined;
          this.state.isOn = false;
          this.service
            .getCharacteristic(this.platform.Characteristic.MotionDetected)
            .updateValue(false);
          this.platform.log.info(
            `Motion auto-reset for ${this.device.name}`,
          );
          this.accessory.context = this.state;
        }, this.motionResetMs);
      } else {
        this.platform.log.debug(
          `Motion sustained for ${this.device.name} (timer already running)`,
        );
      }

      this.accessory.context = this.state;
      return;
    }

    this.platform.log.debug(
      `Updating Homekit state from ${this.device.name}: on=${isOn}, brightness=${brightness?.toFixed(1)}%`,
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
    this.platform.log.debug(
      `Homekit: turning ${value === true ? "on" : "off"} ${this.device.name}`,
    );

    await this.platform.plejdService?.updateState(
      this.device.identifier,
      value as boolean,
    );
    this.state.isOn = value as boolean;
  };

  private getOn = (): CharacteristicValue => this.state.isOn;

  private setBrightness = async (value: CharacteristicValue) => {
    this.platform.log.debug(
      `Homekit: Set brightness of ${this.device.name} to ${value}`,
    );
    await this.platform.plejdService?.updateState(
      this.device.identifier,
      true,
      {
        targetBrightness: value as number,
        currentBrightness: this.state.brightness,
        transitionMs: this.transitionMs,
      },
    );

    this.state.brightness = value as number;
    this.state.isOn = true;
  };

  private getBrightness = (): CharacteristicValue => this.state.brightness;
}
