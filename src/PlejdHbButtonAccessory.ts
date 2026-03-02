import { Service, PlatformAccessory, Characteristic } from "homebridge";
import { Button } from "./model/button.js";

import { PlejdHbPlatform } from "./PlejdHbPlatform.js";
import { PLATFORM_NAME } from "./constants.js";
import { PressType } from "./ButtonPressDetector.js";

/**
 * Button Accessory
 * Groups all Plejd buttons across all physical devices into a single HomeKit
 * "Plejd Remote" accessory with multiple StatelessProgrammableSwitch services.
 * Each button service is named after what it controls (e.g., "Divan Light").
 */
export class PlejdHbButtonAccessory {
  private readonly buttonServices = new Map<
    string,
    { service: Service; characteristic: Characteristic }
  >();

  constructor(
    private readonly platform: PlejdHbPlatform,
    private readonly accessory: PlatformAccessory,
    public readonly buttons: Button[],
  ) {
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(
        this.platform.Characteristic.Manufacturer,
        PLATFORM_NAME,
      )
      .setCharacteristic(
        this.platform.Characteristic.Model,
        "Plejd Remote",
      )
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        "plejd-remote",
      );

    // ServiceLabel is required by HAP spec for accessories with multiple
    // StatelessProgrammableSwitch services
    const labelService =
      this.accessory.getService(this.platform.Service.ServiceLabel) ||
      this.accessory.addService(this.platform.Service.ServiceLabel);
    labelService.setCharacteristic(
      this.platform.Characteristic.ServiceLabelNamespace,
      this.platform.Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS,
    );

    for (let i = 0; i < buttons.length; i++) {
      const button = buttons[i];
      const key = `${button.deviceAddress}-${button.buttonIndex}`;
      const subtype = `button-${key}`;

      let service = this.accessory.getServiceById(
        this.platform.Service.StatelessProgrammableSwitch,
        subtype,
      );
      if (!service) {
        service = this.accessory.addService(
          this.platform.Service.StatelessProgrammableSwitch,
          button.name,
          subtype,
        );
      }

      service.setCharacteristic(
        this.platform.Characteristic.Name,
        button.name,
      );
      service.setCharacteristic(
        this.platform.Characteristic.ConfiguredName,
        button.name,
      );

      // HomeKit ServiceLabelIndex is 1-based, sequential across all buttons
      service.setCharacteristic(
        this.platform.Characteristic.ServiceLabelIndex,
        i + 1,
      );

      const switchEventCharacteristic = service.getCharacteristic(
        this.platform.Characteristic.ProgrammableSwitchEvent,
      );

      // Declare valid values: SINGLE_PRESS=0, DOUBLE_PRESS=1, LONG_PRESS=2
      switchEventCharacteristic.setProps({
        validValues: [
          this.platform.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
          this.platform.Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS,
          this.platform.Characteristic.ProgrammableSwitchEvent.LONG_PRESS,
        ],
      });

      this.buttonServices.set(key, {
        service,
        characteristic: switchEventCharacteristic,
      });
    }

    this.removeStaleServices();
  }

  firePressEvent(deviceAddress: number, buttonIndex: number, pressType: PressType) {
    const key = `${deviceAddress}-${buttonIndex}`;
    const entry = this.buttonServices.get(key);
    if (!entry) {
      this.platform.log.debug(
        `No service found for device=${deviceAddress} buttonIndex=${buttonIndex}`,
      );
      return;
    }

    const value = this.pressTypeToCharacteristicValue(pressType);
    this.platform.log.debug(
      `Button ${deviceAddress}[${buttonIndex}]: firing ${pressType} (value=${value})`,
    );
    entry.characteristic.updateValue(value);
  }

  /**
   * Remove cached StatelessProgrammableSwitch services that no longer match
   * any button in the current config (handles removed buttons and legacy
   * per-device accessories that had different subtypes).
   */
  private removeStaleServices() {
    const validSubtypes = new Set(
      this.buttons.map((b) => `button-${b.deviceAddress}-${b.buttonIndex}`),
    );

    const allSwitchServices = this.accessory.services.filter(
      (s) =>
        s.UUID === this.platform.Service.StatelessProgrammableSwitch.UUID,
    );

    for (const service of allSwitchServices) {
      if (!service.subtype || !validSubtypes.has(service.subtype)) {
        this.platform.log.debug(
          `Removing stale button service subtype=${service.subtype ?? "none"}`,
        );
        this.accessory.removeService(service);
      }
    }
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
