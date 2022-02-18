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

    this.plejdService = new PlejdService(log, this.onPlejdUpdates);

    // Update this to have it computed.
    const devs = config['devices'] as Device[];
    for (let i=0;i<devs.length;i++) {
      devs[i].isDimmer = PLEJD_LIGHTS.includes((devs[i].model));
    }

    const cryptoKey = Buffer.from(config['crypto_key'].replace(/-/g, ''), 'hex');
    this.userInputConfig = {
      devices: devs,
      cryptoKey: cryptoKey,
    };

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });
  }

  /**
 * This function is invoked when homebridge restores cached accessories from disk at startup.
 * It should be used to setup event handlers for characteristics and update respective values.
 */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  /**
 * This is an example method showing how to register discovered accessories.
 * Accessories must only be registered once, previously created accessories
 * must not be registered again to prevent "duplicate UUID" errors.
 */
  discoverDevices() {
    for (const device of this.userInputConfig.devices) {
      const uuid = this.api.hap.uuid.generate(device.identifier.toString());
      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
        existingAccessory.context.device = device;
        existingAccessory.displayName = device.name;
        this.api.updatePlatformAccessories([existingAccessory]);

        // Create a handle for the device to take care of logic
        // lives for as long as "this" is active.
        new PlejdPlatformAccessory(this, existingAccessory);

        // To remove accessory:
        // this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
        // this.log.info('Removing existing accessory from cache:', existingAccessory.displayName);
      } else {
        this.log.info('Adding new accessory:', device.name);
        const accessory = new this.api.platformAccessory(device.name, uuid);
        accessory.context.device = device;

        // See above.
        new PlejdPlatformAccessory(this, accessory);

        // link the accessory to your platform
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }

  // TODO: Call from plejd service once that's built
  onPlejdUpdates(identifier: number, state: number, dim?: number) {
    const uuid = this.api.hap.uuid.generate(identifier.toString());
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
    const device = this.userInputConfig.devices.find(dev => dev.identifier === identifier);
    if (existingAccessory && device) {
      if (device.isDimmer) {
        const ser = existingAccessory.getService(this.Service.Lightbulb);
        ser?.getCharacteristic(this.Characteristic.On)?.updateValue(state);
        ser?.getCharacteristic(this.Characteristic.Brightness)
          .updateValue(dim === 0 ? 1 : ((100 / 255) * dim!));
      } else {
        existingAccessory.getService(this.Service.Switch)
          ?.getCharacteristic(this.Characteristic.On)
          ?.updateValue(state);
      }
    }
  }
}