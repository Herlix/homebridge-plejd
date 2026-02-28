import { Service, PlatformAccessory, Characteristic } from "homebridge";
import { Button } from "./model/button.js";

import { PlejdHbPlatform } from "./PlejdHbPlatform.js";
import { PLATFORM_NAME } from "./constants.js";
import { PressType } from "./ButtonPressDetector.js";

/**
 * Button Accessory
 * Exposes Plejd physical buttons as HomeKit StatelessProgrammableSwitch
 * supporting SINGLE_PRESS, DOUBLE_PRESS, and LONG_PRESS events.
 */
export class PlejdHbButtonAccessory {
  private service: Service;
  private switchEventCharacteristic: Characteristic;

  constructor(
    private readonly platform: PlejdHbPlatform,
    private readonly accessory: PlatformAccessory,
    public readonly button: Button,
  ) {
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(
        this.platform.Characteristic.Manufacturer,
        PLATFORM_NAME,
      )
      .setCharacteristic(this.platform.Characteristic.Model, button.model)
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        `button-${button.deviceId}-${button.buttonIndex}`,
      );

    this.service =
      this.accessory.getService(
        this.platform.Service.StatelessProgrammableSwitch,
      ) ||
      this.accessory.addService(
        this.platform.Service.StatelessProgrammableSwitch,
      );

    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      this.button.name,
    );

    // HomeKit ServiceLabelIndex is 1-based
    this.service.setCharacteristic(
      this.platform.Characteristic.ServiceLabelIndex,
      this.button.buttonIndex + 1,
    );

    this.switchEventCharacteristic = this.service.getCharacteristic(
      this.platform.Characteristic.ProgrammableSwitchEvent,
    );

    // Declare valid values: SINGLE_PRESS=0, DOUBLE_PRESS=1, LONG_PRESS=2
    this.switchEventCharacteristic.setProps({
      validValues: [
        this.platform.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
        this.platform.Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS,
        this.platform.Characteristic.ProgrammableSwitchEvent.LONG_PRESS,
      ],
    });
  }

  firePressEvent(pressType: PressType) {
    const value = this.pressTypeToCharacteristicValue(pressType);
    this.platform.log.debug(
      `Button ${this.button.name}: firing ${pressType} (value=${value})`,
    );
    this.switchEventCharacteristic.updateValue(value);
  }

  private pressTypeToCharacteristicValue(pressType: PressType): number {
    switch (pressType) {
      case "SINGLE_PRESS":
        return this.platform.Characteristic.ProgrammableSwitchEvent
          .SINGLE_PRESS;
      case "DOUBLE_PRESS":
        return this.platform.Characteristic.ProgrammableSwitchEvent
          .DOUBLE_PRESS;
      case "LONG_PRESS":
        return this.platform.Characteristic.ProgrammableSwitchEvent.LONG_PRESS;
    }
  }
}
