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
  DEFAULT_DOUBLE_PRESS_WINDOW_MS,
  DEFAULT_LONG_PRESS_THRESHOLD_MS,
  DEFAULT_MOTION_RESET_SEC,
  PLATFORM_NAME,
  PLUGIN_NAME,
} from "./constants.js";
import { PlejdHbAccessory } from "./PlejdHbAccessory.js";
import { PlejdHbThermostatAccessory } from "./PlejdHbThermostatAccessory.js";
import { PlejdHbSceneAccessory } from "./PlejdHbSceneAccessory.js";
import { PlejdHbButtonAccessory } from "./PlejdHbButtonAccessory.js";
import { ButtonPressDetector, PressType } from "./ButtonPressDetector.js";
import { UserInputConfig } from "./model/userInputConfig.js";
import { ClimateSettings, Device } from "./model/device.js";
import { Button } from "./model/button.js";
import { Scene } from "./model/scene.js";
import { PlejdService, ThermostatState } from "./plejdService.js";
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
  public readonly plejdHbThermostatAccessories: PlejdHbThermostatAccessory[] = [];
  public readonly plejdHbSceneAccessories: PlejdHbSceneAccessory[] = [];
  public readonly plejdHbButtonAccessories: PlejdHbButtonAccessory[] = [];
  private buttonPressDetector?: ButtonPressDetector;
  private readonly transitionMs: number;
  private readonly motionResetMs: number;
  private readonly doublePressWindowMs: number;
  private readonly longPressThresholdMs: number;

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
    this.motionResetMs =
      (config.motion_reset_seconds ?? DEFAULT_MOTION_RESET_SEC) * 1000;
    this.doublePressWindowMs =
      config.double_press_window_ms ?? DEFAULT_DOUBLE_PRESS_WINDOW_MS;
    this.longPressThresholdMs =
      config.long_press_threshold_ms ?? DEFAULT_LONG_PRESS_THRESHOLD_MS;
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
    const buttons: Button[] = [];

    if (site) {
      config.crypto_key = site.plejdMesh.cryptoKey;

      site.devices.forEach((device) => {
        const plejdDevice = site.plejdDevices.find(
          (x) => x.deviceId === device.deviceId,
        )!;
        const model = plejdDevice.firmware.notes;

        const room = site.rooms.find((x) => x.roomId === device.roomId);

        const outputAddresses = site.outputAddress[device.deviceId];
        let identifier = outputAddresses ? outputAddresses["0"] : undefined;
        const twoOutputDeviceId = outputAddresses ? outputAddresses["1"] : undefined;

        // Sensors (e.g. WMS-01) have no outputAddress, use inputAddress instead
        if (identifier === undefined && site.inputAddress[device.deviceId]) {
          identifier = site.inputAddress[device.deviceId]["0"];
        }

        if (
          twoOutputDeviceId &&
          devices.find((a) => a.identifier === identifier) !== undefined
        ) {
          identifier = twoOutputDeviceId;
        }

        const CLIMATE_TRAIT = 0x20;
        let outputType: Device["outputType"] = device.outputType ?? "SENSOR";
        let climateSettings: ClimateSettings | undefined;

        if (
          outputType !== "LIGHT" &&
          outputType !== "RELAY" &&
          device.traits & CLIMATE_TRAIT
        ) {
          outputType = "CLIMATE";

          const outputSetting = site.outputSettings.find(
            (os) => os.deviceId === device.deviceId && os.output === 0,
          );
          const cs = outputSetting?.climateSettings;
          if (cs) {
            if (cs.regulationMode === "PWM" && cs.pwmRegulationConfig) {
              climateSettings = {
                regulationMode: "PWM",
                minTemp: cs.pwmRegulationConfig.minDutyUserInput,
                maxTemp: cs.pwmRegulationConfig.maxDutyUserInput,
                step: cs.pwmRegulationConfig.interval,
              };
            } else if (cs.temperatureLimits) {
              climateSettings = {
                regulationMode: "TEMP",
                minTemp: cs.temperatureLimits.minUserInputTemperature,
                maxTemp: cs.temperatureLimits.maxUserInputTemperature,
              };
            }
          }
        }

        const res: Device = {
          name: device.title,
          model: model,
          identifier: identifier,
          outputType: outputType,
          uuid: this.generateId(identifier ? identifier.toString() : device.deviceId),
          room: room?.title,
          hidden: false,
          plejdDeviceId: device.deviceId,
          climateSettings,
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

      // Extract buttons from cloud data
      site.inputSettings.forEach((input) => {
        const deviceAddress = site.deviceAddress[input.deviceId];
        if (deviceAddress === undefined) {
          this.log.warn(
            `Button input for device ${input.deviceId} has no mesh address, skipping`,
          );
          return;
        }

        const plejdDevice = site.plejdDevices.find(
          (x) => x.deviceId === input.deviceId,
        );

        // Try to find the device this button's input controls
        // by correlating input index → output address → device
        const outputAddresses = site.outputAddress?.[input.deviceId];
        const outputAddr = outputAddresses?.[input.input.toString()];
        const controlledDevice =
          outputAddr !== undefined
            ? devices.find((d) => d.identifier === outputAddr)
            : undefined;

        // Fall back to the first site device with this deviceId
        const siteDevice = site.devices.find(
          (x) => x.deviceId === input.deviceId,
        );
        const room = siteDevice
          ? site.rooms.find((x) => x.roomId === siteDevice.roomId)
          : undefined;

        const model = plejdDevice?.firmware.notes ?? "Unknown";

        const name = controlledDevice?.name
          ?? `${siteDevice?.title ?? input.deviceId} Button ${input.input + 1}`;

        const button: Button = {
          name,
          deviceId: input.deviceId,
          deviceAddress,
          buttonIndex: input.input,
          model,
          uuid: this.generateId(`button-${input.deviceId}-${input.input}`),
          room: room?.title,
        };

        buttons.push(button);
        this.log.info(
          `Found button: ${button.name} (device=${button.deviceAddress}, index=${button.buttonIndex})`,
        );
      });
    }

    for (let i = devices.length - 1; i >= 0; i--) {
      if (!devices[i].name || !devices[i].identifier) {
        log.error(
          `Skipping invalid device entry (name: ${devices[i].name}, identifier: ${devices[i].identifier}). ` +
            `Check your configuration for empty or incomplete devices.`,
        );
        devices.splice(i, 1);
        continue;
      }

      if (!devices[i].outputType) {
        log.warn(
          `Device "${devices[i].name}" is missing the "type" field. ` +
            `Defaulting to "LIGHT". Please update your configuration.`,
        );
        devices[i].outputType = "LIGHT";
      }

      devices[i].uuid = this.generateId(devices[i].identifier.toString());
    }

    if (!config.crypto_key) {
      log.error(
        "No Crypto key was found in the configuration. Check the plugin documentation for more info",
      );
    }

    const cryptoKey = Buffer.from(config.crypto_key.replace(/-/g, ""), "hex");
    this.userInputConfig = {
      devices: devices.filter(
        (device) =>
          device.outputType === "LIGHT" ||
          device.outputType === "RELAY" ||
          device.outputType === "SENSOR" ||
          device.outputType === "CLIMATE",
      ),
      scenes: scenes,
      buttons: buttons,
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
      this.onButtonEvent.bind(this),
      this.onThermostatUpdate.bind(this),
    );
    this.plejdService.configureBLE();

    this.discoverDevices();
    this.discoverScenes();

    if (config.show_buttons !== false) {
      this.discoverButtons();
    } else {
      log.info("Buttons disabled via show_buttons config option");
    }
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
    const buttons = this.userInputConfig!.buttons;
    const buttonUuids = this.config.expand_buttons
      ? buttons.map((b) => b.uuid)
      : buttons.length > 0 ? [this.generateId("plejd-remote")] : [];
    const allUuids = [...deviceUuids, ...sceneUuids, ...buttonUuids];

    const notRegistered = this.accessories.filter(
      (ac) => !allUuids.includes(ac.UUID),
    );
    if (notRegistered.length > 0) {
      const names = notRegistered.map((ac) => ac.displayName).join(", ");
      this.log.info(
        `Removing ${notRegistered.length} stale accessor${notRegistered.length === 1 ? "y" : "ies"}: ${names}`,
      );
      this.homebridgeApi.unregisterPlatformAccessories(
        PLUGIN_NAME,
        PLATFORM_NAME,
        notRegistered,
      );
      const staleUuids = new Set(notRegistered.map((ac) => ac.UUID));
      for (let i = this.accessories.length - 1; i >= 0; i--) {
        if (staleUuids.has(this.accessories[i].UUID)) {
          this.accessories.splice(i, 1);
        }
      }
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
        existingAccessory.displayName = device.name;
        this.homebridgeApi.updatePlatformAccessories([existingAccessory]);

        if (device.outputType === "CLIMATE") {
          this.plejdHbThermostatAccessories.push(
            new PlejdHbThermostatAccessory(this, existingAccessory, device),
          );
        } else {
          this.plejdHbAccessories.push(
            new PlejdHbAccessory(
              this,
              existingAccessory,
              device,
              this.transitionMs,
              this.motionResetMs,
            ),
          );
        }
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
        existingAccessory.context.scene = scene;
        existingAccessory.displayName = scene.name;
        this.homebridgeApi.updatePlatformAccessories([existingAccessory]);
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

    if (device.outputType === "CLIMATE") {
      this.plejdHbThermostatAccessories.push(
        new PlejdHbThermostatAccessory(this, accessory, device),
      );
    } else {
      this.plejdHbAccessories.push(
        new PlejdHbAccessory(this, accessory, device, this.transitionMs, this.motionResetMs),
      );
    }

    // link the accessory to your platform
    this.homebridgeApi.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
      accessory,
    ]);

    if (!this.accessories.find((x) => x.UUID === device.uuid)) {
      this.accessories.push(accessory);
    }
  };

  onThermostatUpdate = (identifier: number, state: ThermostatState) => {
    const thermostatAccessory = this.plejdHbThermostatAccessories.find(
      (acc) => acc.device.identifier === identifier,
    );
    if (thermostatAccessory) {
      thermostatAccessory.onThermostatUpdate(state);
    } else {
      this.log.debug(
        `Received thermostat update for unknown device ${identifier}`,
      );
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
      } else if (device.outputType === "SENSOR") {
        // Sensor state is handled entirely by PlejdHbAccessory.onPlejdUpdates
        // which always sets MotionDetected=true with an auto-reset timer.
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

  discoverButtons = () => {
    this.buttonPressDetector = new ButtonPressDetector(
      this.onPressDetected.bind(this),
      this.doublePressWindowMs,
      this.longPressThresholdMs,
      this.log,
    );

    // Filter out hidden buttons by name
    const hiddenButtons = (this.config.hidden_buttons as string[]) || [];
    const buttons = this.userInputConfig!.buttons.filter((b) => {
      if (hiddenButtons.includes(b.name)) {
        this.log.info(`Hiding button "${b.name}" (matched hidden_buttons)`);
        return false;
      }
      return true;
    });

    if (buttons.length === 0) {
      this.log.info("No buttons to register");
      return;
    }

    // Sort all buttons by deviceAddress then buttonIndex for stable ordering
    buttons.sort(
      (a, b) => a.deviceAddress - b.deviceAddress || a.buttonIndex - b.buttonIndex,
    );

    if (this.config.expand_buttons) {
      this.discoverButtonsExpanded(buttons);
    } else {
      this.discoverButtonsGrouped(buttons);
    }
  };

  private discoverButtonsExpanded = (buttons: Button[]) => {
    for (const button of buttons) {
      const displayName = `${button.name} Button`;
      const existingAccessory = this.accessories.find(
        (accessory) => accessory.UUID === button.uuid,
      );

      if (existingAccessory) {
        existingAccessory.context.button = button;
        existingAccessory.displayName = displayName;
        this.homebridgeApi.updatePlatformAccessories([existingAccessory]);
        this.plejdHbButtonAccessories.push(
          PlejdHbButtonAccessory.createExpanded(this, existingAccessory, button),
        );
      } else {
        const accessory = new this.homebridgeApi.platformAccessory(
          displayName,
          button.uuid,
        );
        accessory.context.button = button;

        this.plejdHbButtonAccessories.push(
          PlejdHbButtonAccessory.createExpanded(this, accessory, button),
        );

        this.homebridgeApi.registerPlatformAccessories(
          PLUGIN_NAME, PLATFORM_NAME, [accessory],
        );

        if (!this.accessories.find((x) => x.UUID === button.uuid)) {
          this.accessories.push(accessory);
        }
      }
    }
  };

  private discoverButtonsGrouped = (buttons: Button[]) => {
    const uuid = this.generateId("plejd-remote");
    const name = "Plejd Remote";

    const existingAccessory = this.accessories.find(
      (accessory) => accessory.UUID === uuid,
    );

    if (existingAccessory) {
      existingAccessory.context.buttons = buttons;
      existingAccessory.displayName = name;
      this.homebridgeApi.updatePlatformAccessories([existingAccessory]);
      this.plejdHbButtonAccessories.push(
        PlejdHbButtonAccessory.createGrouped(this, existingAccessory, buttons),
      );
    } else {
      const accessory = new this.homebridgeApi.platformAccessory(name, uuid);
      accessory.context.buttons = buttons;

      this.plejdHbButtonAccessories.push(
        PlejdHbButtonAccessory.createGrouped(this, accessory, buttons),
      );

      this.homebridgeApi.registerPlatformAccessories(
        PLUGIN_NAME, PLATFORM_NAME, [accessory],
      );

      if (!this.accessories.find((x) => x.UUID === uuid)) {
        this.accessories.push(accessory);
      }
    }
  };

  onButtonEvent = (
    deviceAddress: number,
    buttonIndex: number,
    action: "press" | "release",
  ) => {
    this.log.debug(
      `Button event: device=${deviceAddress} button=${buttonIndex} action=${action}`,
    );
    this.buttonPressDetector?.handleEvent(deviceAddress, buttonIndex, action);
  };

  private onPressDetected = (
    deviceAddress: number,
    buttonIndex: number,
    pressType: PressType,
  ) => {
    this.log.info(
      `Button press detected: device=${deviceAddress} button=${buttonIndex} type=${pressType}`,
    );

    if (this.plejdHbButtonAccessories.length === 0) {
      this.log.debug(
        `No button accessory registered for device=${deviceAddress} button=${buttonIndex}`,
      );
      return;
    }

    if (this.config.expand_buttons) {
      // Expanded mode: find the specific accessory for this button
      const acc = this.plejdHbButtonAccessories.find(
        (a) =>
          a.button?.deviceAddress === deviceAddress &&
          a.button?.buttonIndex === buttonIndex,
      );
      if (acc) {
        acc.firePressEvent(deviceAddress, buttonIndex, pressType);
      } else {
        this.log.debug(
          `No expanded button accessory for device=${deviceAddress} button=${buttonIndex}`,
        );
      }
    } else {
      // Grouped mode: fire on the single grouped accessory
      this.plejdHbButtonAccessories[0].firePressEvent(
        deviceAddress,
        buttonIndex,
        pressType,
      );
    }
  };

  private generateId = (input: string): string => {
    return this.homebridgeApi.hap.uuid.generate(input);
  };
}
