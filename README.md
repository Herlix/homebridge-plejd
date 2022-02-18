# @herlix/homebridge-plejd
Homebridge plugin for Plejd

### Dependencies needed for RPI

```bash
sudo apt-get install bluetooth bluez libbluetooth-dev libudev-dev
```

Check out ble lib [@abandonware/Noble](https://www.npmjs.com/package/@abandonware/noble#start-scanning) for you specific platform

----
#### TODO: Extract crypto key

TODO!

For now look for guides online. Backup your phone unencrypted. Download an extracter and look for a .site file within plejd. 

```com.plejd.consumer.light ... .site .... .PlejdMesh.CryptoKey ```

----
## Thanks

Big thanks to [@blommegard](https://github.com/blommegard) (https://github.com/blommegard/homebridge-plejd) for the base of this repo
