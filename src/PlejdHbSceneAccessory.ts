import { Service, PlatformAccessory, CharacteristicValue } from "homebridge";
import { Scene } from "./model/scene.js";

import { PlejdHbPlatform } from "./PlejdHbPlatform.js";
import { PLATFORM_NAME } from "./constants.js";

const SCENE_RESET_DELAY_MS = 1000;

/**
 * Scene Accessory
 * Exposes Plejd scenes as HomeKit switches that trigger when activated
 * and auto-reset to OFF after 1 second.
 */
export class PlejdHbSceneAccessory {
  private service: Service;
  private isOn = false;
  private resetTimeout: NodeJS.Timeout | null = null;

  constructor(
    private readonly platform: PlejdHbPlatform,
    private readonly accessory: PlatformAccessory,
    public readonly scene: Scene,
  ) {
    // Set accessory information
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(
        this.platform.Characteristic.Manufacturer,
        PLATFORM_NAME,
      )
      .setCharacteristic(this.platform.Characteristic.Model, "Plejd Scene")
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        `scene-${this.scene.sceneIndex}`,
      );

    // Use Switch service for scenes
    this.service =
      this.accessory.getService(this.platform.Service.Switch) ||
      this.accessory.addService(this.platform.Service.Switch);

    // Register handlers for the On/Off Characteristic
    this.service
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      this.scene.name,
    );
  }

  private setOn = async (value: CharacteristicValue) => {
    const turnOn = value as boolean;

    if (!turnOn) {
      // User manually turned off, just update state
      this.isOn = false;
      return;
    }

    this.platform.log.debug(`Homekit: triggering scene ${this.scene.name}`);

    // Trigger the scene
    this.platform.plejdService?.triggerScene(this.scene.sceneIndex);
    this.isOn = true;

    // Clear any existing reset timeout
    if (this.resetTimeout) {
      clearTimeout(this.resetTimeout);
    }

    // Auto-reset to OFF after delay
    this.resetTimeout = setTimeout(() => {
      this.isOn = false;
      this.service
        .getCharacteristic(this.platform.Characteristic.On)
        .updateValue(false);
      this.resetTimeout = null;
    }, SCENE_RESET_DELAY_MS);
  };

  private getOn = (): CharacteristicValue => this.isOn;
}
