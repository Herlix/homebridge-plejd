
<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

# [Plejd](https://www.plejd.com)

## HomeKit support for the Plejd BLE platform using [Homebridge](https://homebridge.io)


<br />

[![Build and Lint](https://img.shields.io/github/workflow/status/herlix/homebridge-plejd/Build%20and%20Lint?style=flat-square)](https://github.com/Herlix/homebridge-plejd/actions/workflows/build.yml)
[![Build and Lint](https://img.shields.io/npm/dm/homebridge-plejd?style=flat-square)](https://github.com/Herlix/homebridge-plejd/actions/workflows/build.yml)

</DIV>
</SPAN>

<br />

### Dependencies needed for Raspberry PI
This is tested on a raspberry pi 3b+ using DIM-02 and DIM-01. Please let me know if there's any issues with other units. Feel free to poke around.

```bash
sudo apt-get install bluetooth bluez libbluetooth-dev libudev-dev
```

Check out ble lib [@abandonware/Noble](https://github.com/abandonware/noble) for you specific platform

<br/>

## TODO: Extract crypto key

For now look for guides online. Backup your phone unencrypted. Download an extractor and look for a .site file within plejd. 

```com.plejd.consumer.light ... .site .... .PlejdMesh.CryptoKey ```

<br />

## Thanks

Big thanks to [@blommegard](https://github.com/blommegard) (https://github.com/blommegard/homebridge-plejd) for the base of this repo
