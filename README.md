# @herlix/homebridge-plejd
Homebridge plugin for Plejd

### Dependencies needed for RPI

```bash
sudo apt-get install bluetooth bluez libbluetooth-dev libudev-dev
```

Check out ble lib [@abandonware/Noble](https://www.npmjs.com/package/@abandonware/noble#start-scanning) for you specific platform

----
#### Example configuration:
```json
"platforms": [
        {
            "platform": "plejd",
            "key": "82-82-91-3E-90-F1-4A-42-C0-84-B7-CB-A4-2B-91-FD",
            "devices": [
                {
                    "name": "Mirror",
                    "model": "DIM-02",
                    "identifier": 11,
                    "dimming": true
                },
                {
                    "name": "Shower",
                    "model": "DIM-02",
                    "identifier": 12,
                    "dimming": true
                },
                {
                    "name": "Towel Dryer",
                    "model": "CTR-01",
                    "identifier": 13
                }
            ]
        }
    ]
```
----
## Thanks

Big thanks to [@blommegard](https://github.com/blommegard) (https://github.com/blommegard/homebridge-plejd) for the base of this repo
