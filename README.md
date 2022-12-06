
<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

# [Plejd](https://www.plejd.com)
## HomeKit support for the Plejd BLE platform using [Homebridge](https://homebridge.io)

### Official support is released using the Plejd gateway.
##### This addon exist if you don't want to use yet another bridge.

<br />

[![Build and Lint](https://img.shields.io/github/workflow/status/herlix/homebridge-plejd/Build%20and%20Lint?style=flat-square)](https://github.com/Herlix/homebridge-plejd/actions/workflows/build.yml)
[![Build and Lint](https://img.shields.io/npm/dm/homebridge-plejd?style=flat-square)](https://github.com/Herlix/homebridge-plejd/actions/workflows/build.yml)

</DIV>
</SPAN>

<br />

### Dependencies needed for Raspberry PI
This is tested on a raspberry pi 3b+ & 4b using DIM-02 and DIM-01. Please let me know if there's any issues with other units. Feel free to poke around.

```bash
sudo apt-get install bluetooth bluez libbluetooth-dev libudev-dev
```

Check out ble lib [@abandonware/Noble](https://github.com/abandonware/noble) for you specific platform

<br/>

### Settings
To be able to communicate with Plejd you need the Crypto key. This is the hard part of getting up and running. A guide can be found [here](./docs/Extracting%20crypto%20key.md)!

Besides the crypto key you will have to add your devices. The info can be extracted alongside the crypto key extraction but it's a bit overkill if you have the key and need device info. Checkout this guide on how to get [this](./docs/Device%20Info.md) info from the app.

### Notes
This plugin lacks testing for multiple platforms. Feel free to test on your system. The main dependency [@abandonware/Noble](https://github.com/abandonware/noble) is your guide in case of your separate system. Usually BLE is the problem.

Feel free to open a ticket if you can't get it working. 

Docker: BLE seems to be a hassle to get up an running. If you get it up and running please let me know. (I've not poured much time into it.)

## Thanks

Big thanks to [@blommegard](https://github.com/blommegard) with [this](https://github.com/blommegard/homebridge-plejd) project. As well as [@klali](https://github.com/klali) with [this](https://github.com/klali/ha-plejd) project.
