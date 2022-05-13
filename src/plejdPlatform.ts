import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLEJD_LIGHTS, PLUGIN_NAME } from './settings';
import { PlejdPlatformAccessory } from './plejdPlatformAccessory';
import { Device, UserInputConfig } from './model';
import { PlejdService } from './plejdService';

export class PlejdPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;
  public readonly userInputConfig!: UserInputConfig;

  public readonly plejdService: PlejdService;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Finished initializing platform:', this.config.platform);
    // Update this to have it computed.
    const devices = config['devices'] as Device[];
    for (let i = 0; i < devices.length; i++) {
      devices[i].isDimmer = PLEJD_LIGHTS.includes((devices[i].model));
      devices[i].uuid = this.generateId(devices[i].identifier.toString());
    }

    const cryptoKey = Buffer.from((config['crypto_key'] ?? config['key']).replace(/-/g, ''), 'hex');
    this.userInputConfig = {
      devices: devices,
      cryptoKey: cryptoKey,
    };
    this.log.debug('UserConfig: ', this.userInputConfig);
    this.plejdService = new PlejdService(this.userInputConfig, log, this.onPlejdUpdates.bind(this));

    this.api.on('didFinishLaunching', () => this.discoverDevices());
  }

  /**
 * This function is invoked when homebridge restores cached accessories from disk at startup.
 * It should be used to setup event handlers for characteristics and update respective values.
 */
  configureAccessory = (accessory: PlatformAccessory) => {
    this.log.info('Loading accessory from cache | ', accessory.displayName);
    this.accessories.push(accessory);
  };

  discoverDevices = () => {
    const units = this.userInputConfig.devices.map(x => x.uuid);
    const notRegistered = this.accessories.filter(ac => !units.includes(ac.UUID));
    if (notRegistered.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, notRegistered);
    }

    for (const device of this.userInputConfig.devices) {
      const existingAccessory = this.accessories.find(accessory => accessory.UUID === device.uuid);
      if (existingAccessory) {
        new PlejdPlatformAccessory(this, existingAccessory, device);
      } else {
        this.log.info('Adding new accessory |', device.name);
        const accessory = new this.api.platformAccessory(device.name, device.uuid);
        accessory.context.device = device;
        // See above.
        new PlejdPlatformAccessory(this, accessory, device);
        // link the accessory to your platform
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  };

  onPlejdUpdates = (identifier: number, isOn: boolean, dim?: number) => {
    const uuid = this.userInputConfig.devices.find(d => d.identifier === identifier)?.uuid;
    if (uuid === undefined) {
      this.log.warn(`Got updates on a device with identifier ${identifier} but it is not registered in HB settings`);
      return;
    }
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid!);
    const device = this.userInputConfig.devices.find(dev => dev.identifier === identifier);
    if (existingAccessory && device) {

      if (device.isDimmer) {
        const ser = existingAccessory.getService(this.Service.Lightbulb);

        if (!ser) {
          this.log.warn('Unable to get service');
        }

        const on = ser?.getCharacteristic(this.Characteristic.On);

        if (!on) {
          this.log.warn('Unable to get Characteristic [On]');
        }
        on?.updateValue(isOn);

        if (dim !== undefined) {
          ser?.getCharacteristic(this.Characteristic.Brightness)
            .updateValue(dim);
        }

      } else {
        existingAccessory.getService(this.Service.Switch)
          ?.getCharacteristic(this.Characteristic.On)
          ?.updateValue(isOn);
      }
    } else {
      this.log.warn('Unable find device associated with update.');
    }
  };

  private generateId = (input: string): string => {
    return this.api.hap.uuid.generate(input);
  };
}