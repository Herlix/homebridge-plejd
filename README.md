<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

# [Plejd](https://www.plejd.com)

## HomeKit support for the Plejd BLE platform using [Homebridge](https://homebridge.io)

### Official support is released using the Plejd gateway

#### This addon exist if you don't want to use yet another hardware to control your Plejd devices

[![Build and Lint](https://img.shields.io/github/workflow/status/herlix/homebridge-plejd/Build%20and%20Lint?style=flat-square)](https://github.com/Herlix/homebridge-plejd/actions/workflows/build.yml)
[![Build and Lint](https://img.shields.io/npm/dm/homebridge-plejd?style=flat-square)](https://github.com/Herlix/homebridge-plejd/actions/workflows/build.yml)

</DIV>
</SPAN>

## Docker Compose

I'm running this in docker-compose on a Raspberry PI 4b 8gb.

Raspberry pi is running Debian Bullseye (Raspberry Pi OS) with docker and docker compose installed, nothing extra.

```yml
homebridge:
  image: oznu/homebridge:latest
  restart: unless-stopped
  network_mode: host
  privileged: true
  volumes:
    - /home/pi/.homebridge:/homebridge
  logging:
    driver: json-file
    options:
      max-size: "10mb"
      max-file: "1"
```

### If not docker: Dependencies needed for Raspberry PI

This is tested on a raspberry pi 3b+ & 4b using DIM-02 and DIM-01. Please let me know if there's any issues with other units. Feel free to poke around.

```bash
sudo apt-get install bluetooth bluez libbluetooth-dev libudev-dev
```

Check out ble lib [@abandonware/Noble](https://github.com/abandonware/noble) for you specific platform

### Settings

Use Plejd Login information (username, password, site) to let the addon take care of getting token.

Another alternative is to list the crypto key and devices manually.

If you choose to use both, the devices will be updated according yo what you set them to in the config list.

Check the logs on start up if you'd like to remove the login info after it's been used.

Device info can be found like [this](./docs/Device%20Info.md)!

### Notes

This plugin lacks testing for multiple platforms. Feel free to test on your system. The main dependency [@abandonware/Noble](https://github.com/abandonware/noble) is your guide in case of your separate system. Usually BLE is the problem.

Feel free to open a ticket if you can't get it working.

The underlying protocol is relying on the BLE address to be exposed. This is not available on mac, meaning this app won't work on mac for now. There might be workarounds for this.

I do not own all hardware from Plejd, this means I have not been able to make sure that it all works. However, feel free to add a PR. I'd like to add switches and sensors, this is not yet available as I do not own any of these.

## Thanks

Big thanks to:

[@blommegard](https://github.com/blommegard) with [homebridge-plejd](https://github.com/blommegard/homebridge-plejd)

[@klali](https://github.com/klali) with [ha-plejd](https://github.com/klali/ha-plejd)

[@thomasloven](https://github.com/thomasloven) with [plejd2mqtt](https://github.com/thomasloven/plejd2mqtt)
