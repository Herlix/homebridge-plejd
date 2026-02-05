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
  DEFAULT_BRIGHTNESS_TRANSITION_MS,
  PLATFORM_NAME,
  PLUGIN_NAME,
} from "./constants.js";
import { PlejdHbAccessory } from "./PlejdHbAccessory.js";
import { PlejdHbSceneAccessory } from "./PlejdHbSceneAccessory.js";
import { UserInputConfig } from "./model/userInputConfig.js";
import { Device } from "./model/device.js";
import { Scene } from "./model/scene.js";
import { PlejdService } from "./plejdService.js";
import PlejdRemoteApi from "./plejdApi.js";
import { Site } from "./model/plejdSite.js";

export class PlejdHbPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public userInputConfig?: UserInputConfig;
  public plejdService?: PlejdService;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  public readonly plejdHbAccessories: PlejdHbAccessory[] = [];
  public readonly plejdHbSceneAccessories: PlejdHbSceneAccessory[] = [];
  private readonly transitionMs: number;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly homebridgeApi: API,
  ) {
    homebridgeApi.on("didFinishLaunching", this.configurePlejd);
    this.Characteristic = homebridgeApi.hap.Characteristic;
    this.Service = homebridgeApi.hap.Service;

    this.transitionMs =
      config.transition_ms ?? DEFAULT_BRIGHTNESS_TRANSITION_MS;
  }

  configurePlejd = async () => {
    if (this.config.password && this.config.site && this.config.username) {
      this.log.info(
        "Using login information to fetch devices & crypto key\n" +
          "Any devices added manually will override the remote site information",
      );
      const pApi = new PlejdRemoteApi(
        this.log,
        this.config.site,
        this.config.username,
        this.config.password,
        true,
      );
      const site = await pApi.getPlejdRemoteSite();
      this.configureDevices(this.log, this.config, site);
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
    const scenes: Scene[] = [];

    if (site) {
      config.crypto_key = site.plejdMesh.cryptoKey;

      site.devices.forEach((device) => {
        const plejdDevice = site.plejdDevices.find(
          (x) => x.deviceId === device.deviceId,
        )!;
        const model = plejdDevice.firmware.notes;

        const room = site.rooms.find((x) => x.roomId === device.roomId);

        let identifier = site.outputAddress[device.deviceId]["0"];
        const twoOutputDeviceId = site.outputAddress[device.deviceId]["1"];

        if (
          twoOutputDeviceId &&
          devices.find((a) => a.identifier === identifier) !== undefined
        ) {
          identifier = twoOutputDeviceId;
        }

        const res: Device = {
          name: device.title,
          model: model,
          identifier: identifier,
          outputType: device.outputType,
          uuid: this.generateId(identifier.toString()),
          room: room?.title,
          hidden: false,
          plejdDeviceId: device.deviceId,
        };

        const pre = devices.findIndex((x) => x.identifier === res.identifier);
        if (pre !== -1) {
          if (devices[pre].hidden) {
            this.log.info(`${res.name} is set to hidden. Will ignore device.`);
          } else {
            this.log.debug(
              `${res.name} already configured manually, skipping cloud config`,
            );
          }
        } else {
          devices.push(res);
        }
      });

      // Extract scenes from cloud data
      site.scenes.forEach((siteScene) => {
        if (siteScene.hiddenFromSceneList) {
          return;
        }

        const sceneIndex = site.sceneIndex[siteScene.sceneId];
        if (sceneIndex === undefined) {
          this.log.warn(
            `Scene "${siteScene.title}" has no index mapping, skipping`,
          );
          return;
        }

        const scene: Scene = {
          name: siteScene.title,
          sceneIndex: sceneIndex,
          sceneId: siteScene.sceneId,
          uuid: this.generateId(`scene-${siteScene.sceneId}`),
          hidden: false,
        };

        scenes.push(scene);
        this.log.info(
          `Found scene: ${scene.name} (index: ${scene.sceneIndex})`,
        );
      });
    }

    for (let i = 0; i < devices.length; i++) {
      if (!devices[i].outputType) {
        log.warn(
          `Device "${devices[i].name}" is missing the "type" field. ` +
            `Defaulting to "LIGHT". Please update your configuration.`,
        );
        devices[i].outputType = "LIGHT";
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
      // There could be other output types eg: WMS-01
      devices: devices.filter(
        (device) =>
          device.outputType === "LIGHT" || device.outputType === "RELAY",
      ),
      scenes: scenes,
      cryptoKey: cryptoKey,
    };

    log.debug("Plejd Crypto Key:", config.crypto_key);
    log.debug(
      "Plejd Devices connected to HomeKit:",
      this.userInputConfig.devices,
    );
    log.debug(
      "Plejd Scenes connected to HomeKit:",
      this.userInputConfig.scenes,
    );

    this.plejdService = new PlejdService(
      this.userInputConfig,
      log,
      this.onPlejdUpdates.bind(this),
    );
    this.plejdService.configureBLE();

    this.discoverDevices();
    this.discoverScenes();
  };

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory = (accessory: PlatformAccessory) => {
    this.accessories.push(accessory);
  };

  discoverDevices = () => {
    const deviceUuids = this.userInputConfig!.devices.map((x) => x.uuid);
    const sceneUuids = this.userInputConfig!.scenes.map((x) => x.uuid);
    const allUuids = [...deviceUuids, ...sceneUuids];

    const notRegistered = this.accessories.filter(
      (ac) => !allUuids.includes(ac.UUID),
    );
    if (notRegistered.length > 0) {
      this.homebridgeApi.unregisterPlatformAccessories(
        PLUGIN_NAME,
        PLATFORM_NAME,
        notRegistered,
      );
    }

    for (const device of this.userInputConfig!.devices) {
      if (device.hidden) {
        continue;
      }

      const existingAccessory = this.accessories.find(
        (accessory) => accessory.UUID === device.uuid,
      );

      if (existingAccessory) {
        existingAccessory.context.device = device;
        this.plejdHbAccessories.push(
          new PlejdHbAccessory(
            this,
            existingAccessory,
            device,
            this.transitionMs,
          ),
        );
      } else {
        this.addNewDevice(device);
      }
    }
  };

  discoverScenes = () => {
    for (const scene of this.userInputConfig!.scenes) {
      if (scene.hidden) {
        continue;
      }

      const existingAccessory = this.accessories.find(
        (accessory) => accessory.UUID === scene.uuid,
      );

      if (existingAccessory) {
        this.plejdHbSceneAccessories.push(
          new PlejdHbSceneAccessory(this, existingAccessory, scene),
        );
      } else {
        this.addNewScene(scene);
      }
    }
  };

  addNewScene = (scene: Scene) => {
    const accessory = new this.homebridgeApi.platformAccessory(
      scene.name,
      scene.uuid,
    );
    accessory.context.scene = scene;

    this.plejdHbSceneAccessories.push(
      new PlejdHbSceneAccessory(this, accessory, scene),
    );

    this.homebridgeApi.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
      accessory,
    ]);

    if (!this.accessories.find((x) => x.UUID === scene.uuid)) {
      this.accessories.push(accessory);
    }
  };

  addNewDevice = (device: Device) => {
    const accessory = new this.homebridgeApi.platformAccessory(
      device.name,
      device.uuid,
    );
    accessory.context.device = device;
    // See above.
    this.plejdHbAccessories.push(
      new PlejdHbAccessory(this, accessory, device, this.transitionMs),
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
    const plejdHbAccessory = this.plejdHbAccessories.find(
      (dev) => dev.device.identifier === identifier,
    );
    if (existingAccessory && device && plejdHbAccessory) {
      if (device.outputType === "LIGHT") {
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

      plejdHbAccessory.onPlejdUpdates(isOn, brightness);
    } else {
      if (device) {
        this.addNewDevice(device);
        this.onPlejdUpdates(identifier, isOn, brightness);
      }
    }
  };

  private generateId = (input: string): string => {
    return this.homebridgeApi.hap.uuid.generate(input);
  };
}
