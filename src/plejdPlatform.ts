import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLEJD_LIGHTS, PLUGIN_NAME } from './settings';
import { PlejdPlatformAccessoryHandler } from './plejdPlatformAccessory';
import { UserInputConfig } from './model/userInputConfig';
import { Device } from './model/device';
import { PlejdService } from './plejdService';
import PlejdRemoteApi from './plejdApi';
import { Site } from './model/plejdSite';

export class PlejdPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;


  public userInputConfig?: UserInputConfig;
  public plejdService?: PlejdService;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  public readonly plejdHandlers: PlejdPlatformAccessoryHandler[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Finished initializing platform:', this.config.platform);

    api.on('didFinishLaunching', this.configurePlejd);
  }

  configurePlejd = () => {
    if (this.config.password && this.config.site && this.config.username) {
      this.log.info('Using login information to fetch devices & crypto key');
      this.log.info('Any devices added manually will update the downloaded devices');

      const pApi = new PlejdRemoteApi(this.log, this.config.site, this.config.username, this.config.password, true);
      pApi.getPlejdRemoteSite()
        .then(site => this.configureDevices(this.log, this.config, site))
        .catch(e => this.log.error(`Plejd remote access error: ${e}`));
    } else if (this.config.crypto_key && this.config.devices && this.config.devices.count > 0) {
      this.log.info('Using supplied crypto key & devices');
      this.configureDevices(this.log, this.config, undefined);
    } else {
      this.log.warn('No settings are prepared, either supply crypto key & devices OR username, password & site');
    }
  };

  configureDevices = (log: Logger, config: PlatformConfig, site?: Site) => {
    const devices = config.devices as Device[];

    if (site) {
      config.crypto_key = site.plejdMesh.cryptoKey;
      log.info('Plejd Crypto Key:', site.plejdMesh.cryptoKey);

      const items: Device[] = [];
      // Extract devices
      site.devices.forEach((item) => {
        const name = item.title;
        const id = item.deviceId;

        const e = site.plejdDevices.find((x) => x.deviceId === id)!;
        const dim = e.firmware.notes;

        let identifier = site.inputAddress[id]![0]!;
        if (dim.endsWith('-02') && items.find((a) => a.identifier === identifier) !== undefined) {
          identifier += 1;
        }

        const res: Device = {
          name: name,
          model: dim,
          identifier: identifier,
          isDimmer: PLEJD_LIGHTS.includes(dim),
          uuid: this.generateId(identifier.toString()),
        };

        items.push(res);
      });

      items.forEach((item) => {
        const pre = devices.findIndex((x) => x.identifier === item.identifier);
        if (pre !== -1) {
          devices[pre].name = item.name;
        } else {
          devices.push(item);
        }
      });
    }

    for (let i = 0; i < devices.length; i++) {
      if (devices[i].model) {
        devices[i].isDimmer = PLEJD_LIGHTS.includes((devices[i].model));
      } else {
        log.error('Missing device model |', devices[i].name);
      }


      if (devices[i].identifier) {
        devices[i].uuid = this.generateId(devices[i].identifier.toString());
      } else {
        log.error('Missing device identifier |', devices[i].name);
      }
    }

    if (!config.crypto_key) {
      log.error('No Crypto key was found in the configuration. Check the plugin documentation for more info');
    }

    const cryptoKey = Buffer.from((config.crypto_key).replace(/-/g, ''), 'hex');
    this.userInputConfig = {
      devices: devices,
      cryptoKey: cryptoKey,
    };
    this.log.debug('UserConfig: ', this.userInputConfig);
    this.plejdService = new PlejdService(this.userInputConfig, log, this.onPlejdUpdates.bind(this));

    this.api.on('didFinishLaunching', () => this.discoverDevices());
  };

  /**
* This function is invoked when homebridge restores cached accessories from disk at startup.
* It should be used to setup event handlers for characteristics and update respective values.
*/
  configureAccessory = (accessory: PlatformAccessory) => {
    this.log.info('Loading accessory from cache | ', accessory.displayName);
    this.accessories.push(accessory);
  };

  discoverDevices = () => {
    const units = this.userInputConfig!.devices.map(x => x.uuid);
    const notRegistered = this.accessories.filter(ac => !units.includes(ac.UUID));
    if (notRegistered.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, notRegistered);
    }

    for (const device of this.userInputConfig!.devices) {
      const existingAccessory = this.accessories.find(accessory => accessory.UUID === device.uuid);
      if (existingAccessory) {
        this.plejdHandlers.push(new PlejdPlatformAccessoryHandler(this, existingAccessory, device));
      } else {
        this.log.info('Adding new accessory |', device.name);
        const accessory = new this.api.platformAccessory(device.name, device.uuid);
        accessory.context.device = device;
        // See above.
        this.plejdHandlers.push(new PlejdPlatformAccessoryHandler(this, accessory, device));
        // link the accessory to your platform
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  };

  onPlejdUpdates = (identifier: number, isOn: boolean, brightness?: number) => {
    const uuid = this.userInputConfig!.devices.find(d => d.identifier === identifier)?.uuid;
    if (uuid === undefined) {
      this.log.warn(`Got updates on a device with identifier ${identifier} but it is not registered in HB settings`);
      return;
    }
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid!);
    const device = this.userInputConfig!.devices.find(dev => dev.identifier === identifier);
    const plejdHandler = this.plejdHandlers.find(dev => dev.device.identifier === identifier);
    if (existingAccessory && device && plejdHandler) {
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

        if (brightness !== undefined) {
          ser?.getCharacteristic(this.Characteristic.Brightness)
            .updateValue(brightness);
        }

      } else {
        existingAccessory.getService(this.Service.Switch)
          ?.getCharacteristic(this.Characteristic.On)
          ?.updateValue(isOn);
      }

      plejdHandler.updateState(isOn, brightness);
    } else {
      this.log.warn('Unable find device associated with update |', existingAccessory, device, plejdHandler);
    }
  };

  private generateId = (input: string): string => {
    return this.api.hap.uuid.generate(input);
  };
}