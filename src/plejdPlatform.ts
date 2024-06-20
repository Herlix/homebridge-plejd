import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from "homebridge";

import {
  PLATFORM_NAME,
  PLEJD_ADDONS,
  PLEJD_LIGHTS,
  PLUGIN_NAME,
} from "./settings.js";
import { PlejdPlatformAccessoryHandler } from "./plejdPlatformAccessory.js";
import { UserInputConfig } from "./model/userInputConfig.js";
import { Device } from "./model/device.js";
import { PlejdService } from "./plejdService.js";
import PlejdRemoteApi from "./plejdApi.js";
import { Site } from "./model/plejdSite.js";

export class PlejdPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public userInputConfig?: UserInputConfig;
  public plejdService?: PlejdService;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  public readonly plejdHandlers: PlejdPlatformAccessoryHandler[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly homebridgeApi: API,
  ) {
    this.log.debug("Finished initializing platform:", this.config.platform);

    homebridgeApi.on("didFinishLaunching", this.configurePlejd);
    this.Characteristic = homebridgeApi.hap.Characteristic;
    this.Service = homebridgeApi.hap.Service;
  }

  configurePlejd = () => {
    if (this.config.password && this.config.site && this.config.username) {
      this.log.info("Using login information to fetch devices & crypto key");
      this.log.info(
        "Any devices added manually will update the downloaded devices",
      );

      const pApi = new PlejdRemoteApi(
        this.log,
        this.config.site,
        this.config.username,
        this.config.password,
        true,
      );
      pApi
        .getPlejdRemoteSite()
        .then((site) => this.configureDevices(this.log, this.config, site))
        .catch((e) => this.log.error(`Plejd remote access error: ${e}`));
    } else if (
      this.config.crypto_key &&
      this.config.devices &&
      this.config.devices.count > 0
    ) {
      this.log.info("Using supplied crypto key & devices");
      this.configureDevices(this.log, this.config, undefined);
    } else {
      this.log.warn(
        "No settings are prepared, either supply crypto key & devices OR username, password & site",
      );
    }
  };

  configureDevices = (log: Logger, config: PlatformConfig, site?: Site) => {
    const devices = (config.devices as Device[]) || [];

    if (site) {
      config.crypto_key = site.plejdMesh.cryptoKey;
      const items: Device[] = [];
      // Extract devices
      site.devices.forEach((item) => {
        const name = item.title;
        const id = item.deviceId;

        const e = site.plejdDevices.find((x) => x.deviceId === id)!;
        const dim = e.firmware.notes;

        if (PLEJD_ADDONS.includes(dim)) {
          return;
        }

        const room = site.rooms.find((x) => x.roomId === item.roomId);

        let identifier = site.inputAddress[id]![0]!;
        if (
          dim.endsWith("-02") &&
          items.find((a) => a.identifier === identifier) !== undefined
        ) {
          identifier += 1;
        }

        const res: Device = {
          name: name,
          model: dim,
          identifier: identifier,
          isDimmer: PLEJD_LIGHTS.includes(dim),
          uuid: this.generateId(identifier.toString()),
          room: room?.title,
          hidden: false,
        };

        items.push(res);
      });

      items.forEach((item) => {
        const pre = devices.findIndex((x) => x.identifier === item.identifier);
        if (pre !== -1) {
          if (devices[pre].hidden) {
            log.debug("Hiding device |", devices[pre]);
            devices.splice(pre);
          } else {
            devices[pre].name = item.name;
          }
        } else {
          devices.push(item);
        }
      });
    }

    for (let i = 0; i < devices.length; i++) {
      if (devices[i].model) {
        devices[i].isDimmer = PLEJD_LIGHTS.includes(devices[i].model);
      } else {
        log.error("Missing device model |", devices[i].name);
      }

      if (devices[i].identifier) {
        devices[i].uuid = this.generateId(devices[i].identifier.toString());
      } else {
        log.error("Missing device identifier |", devices[i].name);
      }
    }

    if (!config.crypto_key) {
      log.error(
        "No Crypto key was found in the configuration. Check the plugin documentation for more info",
      );
    }

    const cryptoKey = Buffer.from(config.crypto_key.replace(/-/g, ""), "hex");
    this.userInputConfig = {
      devices: devices,
      cryptoKey: cryptoKey,
    };

    log.info("Plejd Crypto Key:", config.crypto_key);
    log.info(
      "Plejd Devices connected to HomeKit:",
      this.userInputConfig.devices,
    );

    this.plejdService = new PlejdService(
      this.userInputConfig,
      log,
      this.onPlejdUpdates.bind(this),
    );

    this.discoverDevices();
  };

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory = (accessory: PlatformAccessory) => {
    this.log.info("Loading accessory from cache | ", accessory.displayName);
    this.accessories.push(accessory);
  };

  discoverDevices = () => {
    const units = this.userInputConfig!.devices.map((x) => x.uuid);
    const notRegistered = this.accessories.filter(
      (ac) => !units.includes(ac.UUID),
    );
    if (notRegistered.length > 0) {
      this.homebridgeApi.unregisterPlatformAccessories(
        PLUGIN_NAME,
        PLATFORM_NAME,
        notRegistered,
      );
    }

    this.log.debug("registering devices", this.userInputConfig?.devices);

    for (const device of this.userInputConfig!.devices) {
      if (device.hidden) {
        continue;
      }

      const existingAccessory = this.accessories.find(
        (accessory) => accessory.UUID === device.uuid,
      );

      if (existingAccessory) {
        this.plejdHandlers.push(
          new PlejdPlatformAccessoryHandler(this, existingAccessory, device),
        );
      } else {
        this.addNewDevice(device);
      }
    }
  };

  addNewDevice = (device: Device) => {
    let name = device.name;
    this.log.info("Adding new accessory |", name);
    if (device.room) {
      name = device.room + " - " + name;
    }

    const accessory = new this.homebridgeApi.platformAccessory(
      device.name,
      device.uuid,
    );
    accessory.context.device = device;
    // See above.
    this.plejdHandlers.push(
      new PlejdPlatformAccessoryHandler(this, accessory, device),
    );

    // link the accessory to your platform
    this.homebridgeApi.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
      accessory,
    ]);

    if (!this.accessories.find((x) => x.UUID === device.uuid)) {
      this.accessories.push(accessory);
    }
  };

  onPlejdUpdates = (identifier: number, isOn: boolean, brightness?: number) => {
    const uuid = this.userInputConfig!.devices.find(
      (d) => d.identifier === identifier,
    )?.uuid;
    if (uuid === undefined) {
      // Scene or Room, eg: Unused
      return;
    }
    const existingAccessory = this.accessories.find(
      (accessory) => accessory.UUID === uuid!,
    );
    const device = this.userInputConfig!.devices.find(
      (dev) => dev.identifier === identifier,
    );
    const plejdHandler = this.plejdHandlers.find(
      (dev) => dev.device.identifier === identifier,
    );
    if (existingAccessory && device && plejdHandler) {
      if (device.isDimmer) {
        const ser = existingAccessory.getService(this.Service.Lightbulb);

        if (!ser) {
          this.log.warn("Unable to get service");
        }

        const on = ser?.getCharacteristic(this.Characteristic.On);

        if (!on) {
          this.log.warn("Unable to get Characteristic [On]");
        }

        on?.updateValue(isOn);

        if (brightness !== undefined) {
          ser
            ?.getCharacteristic(this.Characteristic.Brightness)
            .updateValue(brightness);
        }
      } else {
        existingAccessory
          .getService(this.Service.Switch)
          ?.getCharacteristic(this.Characteristic.On)
          ?.updateValue(isOn);
      }

      plejdHandler.updateState(isOn, brightness);
    } else {
      if (device) {
        this.addNewDevice(device);
        this.onPlejdUpdates(identifier, isOn, brightness);
      } else {
        this.log.info(
          "Unable find HomKit device associated with incoming Plejd update |",
          device,
        );
      }
    }
  };

  private generateId = (input: string): string => {
    return this.homebridgeApi.hap.uuid.generate(input);
  };
}
