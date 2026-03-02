import { Service, PlatformAccessory, Characteristic } from "homebridge";
import { Button } from "./model/button.js";

import { PlejdHbPlatform } from "./PlejdHbPlatform.js";
import { PLATFORM_NAME } from "./constants.js";
import { PressType } from "./ButtonPressDetector.js";

/**
 * Button Accessory — supports two modes:
 *
 * **Grouped mode** (expand_buttons=false, default):
 *   All Plejd buttons across all physical devices are grouped into a single
 *   HomeKit "Plejd Remote" accessory with multiple StatelessProgrammableSwitch
 *   services. Each button service is named after what it controls.
 *
 * **Expanded mode** (expand_buttons=true):
 *   Each button becomes its own accessory with a single
 *   StatelessProgrammableSwitch service. The accessory name is the button name,
 *   which Home Assistant uses for entity naming.
 */
export class PlejdHbButtonAccessory {
  private readonly buttonServices = new Map<
    string,
    { service: Service; characteristic: Characteristic }
  >();

  /** The button this accessory represents (expanded mode only). */
  public readonly button?: Button;
  /** All buttons in this accessory (grouped mode only). */
  public readonly buttons?: Button[];

  /**
   * Create a grouped-mode accessory (all buttons in one "Plejd Remote").
   */
  static createGrouped(
    platform: PlejdHbPlatform,
    accessory: PlatformAccessory,
    buttons: Button[],
  ): PlejdHbButtonAccessory {
    return new PlejdHbButtonAccessory(platform, accessory, buttons, undefined);
  }

  /**
   * Create an expanded-mode accessory (single button per accessory).
   */
  static createExpanded(
    platform: PlejdHbPlatform,
    accessory: PlatformAccessory,
    button: Button,
  ): PlejdHbButtonAccessory {
    return new PlejdHbButtonAccessory(platform, accessory, undefined, button);
  }

  private constructor(
    private readonly platform: PlejdHbPlatform,
    private readonly accessory: PlatformAccessory,
    buttons: Button[] | undefined,
    button: Button | undefined,
  ) {
    if (button) {
      // Expanded mode — single button per accessory
      this.button = button;
      this.initExpanded(button);
    } else {
      // Grouped mode — all buttons in one accessory
      this.buttons = buttons!;
      this.initGrouped(buttons!);
    }
  }

  private initExpanded(button: Button) {
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(
        this.platform.Characteristic.Manufacturer,
        PLATFORM_NAME,
      )
      .setCharacteristic(this.platform.Characteristic.Model, button.model)
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        `button-${button.deviceAddress}-${button.buttonIndex}`,
      )
      .setCharacteristic(this.platform.Characteristic.Name, button.name);

    // Remove any leftover ServiceLabel from a previous grouped-mode cache
    const staleLabel = this.accessory.getService(
      this.platform.Service.ServiceLabel,
    );
    if (staleLabel) {
      this.accessory.removeService(staleLabel);
    }

    let service = this.accessory.getService(
      this.platform.Service.StatelessProgrammableSwitch,
    );
    if (!service) {
      service = this.accessory.addService(
        this.platform.Service.StatelessProgrammableSwitch,
        button.name,
      );
    }

    service.setCharacteristic(this.platform.Characteristic.Name, button.name);
    service.setCharacteristic(
      this.platform.Characteristic.ConfiguredName,
      button.name,
    );

    const switchEventCharacteristic = service.getCharacteristic(
      this.platform.Characteristic.ProgrammableSwitchEvent,
    );
    switchEventCharacteristic.setProps({
      validValues: [
        this.platform.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
        this.platform.Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS,
        this.platform.Characteristic.ProgrammableSwitchEvent.LONG_PRESS,
      ],
    });

    const key = `${button.deviceAddress}-${button.buttonIndex}`;
    this.buttonServices.set(key, {
      service,
      characteristic: switchEventCharacteristic,
    });
  }

  private initGrouped(buttons: Button[]) {
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
      )
      .setCharacteristic(this.platform.Characteristic.Name, "Plejd Remote");

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
      this.buttons!.map((b) => `button-${b.deviceAddress}-${b.buttonIndex}`),
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
