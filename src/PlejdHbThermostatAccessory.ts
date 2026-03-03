import { Service, PlatformAccessory, CharacteristicValue } from "homebridge";
import { Device } from "./model/device.js";
import { ThermostatState } from "./plejdService.js";

import { PlejdHbPlatform } from "./PlejdHbPlatform.js";
import { PLATFORM_NAME } from "./constants.js";

const PLEJD_MODE_SERVICE = 0;
const PLEJD_MODE_NORMAL = 7;

const DEFAULT_MIN_TEMP = 7;
const DEFAULT_MAX_TEMP = 35;

interface ThermostatDeviceState {
  currentTemperature: number;
  targetTemperature: number;
  heating: boolean;
  modeOff: boolean;
}

/**
 * Thermostat Accessory
 * Exposes a Plejd TRM-01 thermostat as a HomeKit Thermostat service.
 */
export class PlejdHbThermostatAccessory {
  private service: Service;
  private state: ThermostatDeviceState;

  constructor(
    private readonly platform: PlejdHbPlatform,
    private readonly accessory: PlatformAccessory,
    public readonly device: Device,
  ) {
    this.state = {
      currentTemperature: accessory.context.currentTemperature ?? 20,
      targetTemperature: accessory.context.targetTemperature ?? 20,
      heating: accessory.context.heating ?? false,
      modeOff: accessory.context.modeOff ?? false,
    };

    // Set accessory information
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(
        this.platform.Characteristic.Manufacturer,
        PLATFORM_NAME,
      )
      .setCharacteristic(this.platform.Characteristic.Model, this.device.model)
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        this.device.identifier
          ? this.device.identifier.toString()
          : this.device.uuid,
      )
      .setCharacteristic(this.platform.Characteristic.Name, this.device.name);

    // Remove stale services from previous type assignments
    for (const staleService of [
      this.platform.Service.Switch,
      this.platform.Service.Lightbulb,
      this.platform.Service.MotionSensor,
    ]) {
      const existing = this.accessory.getService(staleService);
      if (existing) {
        this.platform.log.info(
          `Removing stale service from ${this.device.name} (now CLIMATE)`,
        );
        this.accessory.removeService(existing);
      }
    }

    this.service =
      this.accessory.getService(this.platform.Service.Thermostat) ||
      this.accessory.addService(this.platform.Service.Thermostat);

    const minTemp =
      this.device.climateSettings?.minTemp ?? DEFAULT_MIN_TEMP;
    const maxTemp =
      this.device.climateSettings?.maxTemp ?? DEFAULT_MAX_TEMP;

    // Current Temperature
    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .setProps({ minValue: -10, maxValue: 53 })
      .onGet(this.getCurrentTemperature.bind(this));

    // Target Temperature
    this.service
      .getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .setProps({ minValue: minTemp, maxValue: maxTemp, minStep: 1 })
      .onGet(this.getTargetTemperature.bind(this))
      .onSet(this.setTargetTemperature.bind(this));

    // Current Heating/Cooling State (read-only)
    this.service
      .getCharacteristic(
        this.platform.Characteristic.CurrentHeatingCoolingState,
      )
      .onGet(this.getCurrentHeatingCoolingState.bind(this));

    // Target Heating/Cooling State (OFF or HEAT only)
    this.service
      .getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [
          this.platform.Characteristic.TargetHeatingCoolingState.OFF,
          this.platform.Characteristic.TargetHeatingCoolingState.HEAT,
        ],
      })
      .onGet(this.getTargetHeatingCoolingState.bind(this))
      .onSet(this.setTargetHeatingCoolingState.bind(this));

    // Temperature Display Units (Celsius, read-only)
    this.service
      .getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onGet(
        () => this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS,
      );

    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      this.device.name,
    );
  }

  /**
   * Called by the platform when BLE thermostat state is received.
   */
  onThermostatUpdate(thermoState: ThermostatState): void {
    this.state.currentTemperature = thermoState.current;
    this.state.targetTemperature = thermoState.target;
    this.state.heating = thermoState.heating ?? false;
    this.state.modeOff = thermoState.mode === PLEJD_MODE_SERVICE;

    this.platform.log.debug(
      `Updating HomeKit thermostat ${this.device.name}: current=${thermoState.current}°C target=${thermoState.target}°C heating=${thermoState.heating} mode=${thermoState.mode}`,
    );

    this.service
      .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .updateValue(this.state.currentTemperature);

    this.service
      .getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .updateValue(this.state.targetTemperature);

    this.service
      .getCharacteristic(
        this.platform.Characteristic.CurrentHeatingCoolingState,
      )
      .updateValue(
        this.state.heating
          ? this.platform.Characteristic.CurrentHeatingCoolingState.HEAT
          : this.platform.Characteristic.CurrentHeatingCoolingState.OFF,
      );

    this.service
      .getCharacteristic(
        this.platform.Characteristic.TargetHeatingCoolingState,
      )
      .updateValue(
        this.state.modeOff
          ? this.platform.Characteristic.TargetHeatingCoolingState.OFF
          : this.platform.Characteristic.TargetHeatingCoolingState.HEAT,
      );

    this.accessory.context = this.state;
  }

  private getCurrentTemperature(): CharacteristicValue {
    return this.state.currentTemperature;
  }

  private getTargetTemperature(): CharacteristicValue {
    return this.state.targetTemperature;
  }

  private setTargetTemperature(value: CharacteristicValue): void {
    const temp = value as number;
    this.platform.log.debug(
      `HomeKit: Set target temperature of ${this.device.name} to ${temp}°C`,
    );
    this.state.targetTemperature = temp;
    this.platform.plejdService?.updateThermostat(this.device.identifier, {
      targetTemp: temp,
    });
  }

  private getCurrentHeatingCoolingState(): CharacteristicValue {
    return this.state.heating
      ? this.platform.Characteristic.CurrentHeatingCoolingState.HEAT
      : this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
  }

  private getTargetHeatingCoolingState(): CharacteristicValue {
    return this.state.modeOff
      ? this.platform.Characteristic.TargetHeatingCoolingState.OFF
      : this.platform.Characteristic.TargetHeatingCoolingState.HEAT;
  }

  private setTargetHeatingCoolingState(value: CharacteristicValue): void {
    const mode = value as number;
    const isOff =
      mode === this.platform.Characteristic.TargetHeatingCoolingState.OFF;

    this.platform.log.debug(
      `HomeKit: Set thermostat mode of ${this.device.name} to ${isOff ? "OFF" : "HEAT"}`,
    );

    this.state.modeOff = isOff;
    this.platform.plejdService?.updateThermostat(this.device.identifier, {
      mode: isOff ? PLEJD_MODE_SERVICE : PLEJD_MODE_NORMAL,
    });
  }
}
