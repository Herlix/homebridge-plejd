#### 1.4.8 (2024-08-16)

Catch all Noble errors, refactor ping pong and message queue logic.

#### 1.4.7 (2024-08-15)

Yet another try at the re-connection issue.

#### 1.4.7 (2024-08-13)

Check support for HB 2.0. Added more retry if device has not proppely disconnected yet.

#### 1.4.6 (2024-07-09)

Fix for unknown device from Noble. I have yet to re-produce the error in my development environment.

#### 1.4.5 (2024-07-09)

Add hard reset to noble on disconnect.

#### 1.4.4 (2024-07-09)

Enable lower level reset on disconnect & add timeout ms.

#### 1.4.3 (2024-07-10)

BLE issue still seems to be there. This update will take another path on reconnecting to the mesh as well as handle any errors when we send commands to the Plejd device, it should now retry on reconnect.

#### 1.4.3 (2024-07-09)

Re-occuring issue with reconnection to mesh, another try plus removal of unused items.

#### 1.4.2 (2024-07-09)

Attempt to fix issue with reconnection to mesh.

#### 1.4.1 (2024-06-30)

Bug fix: Re-scan when unable to connect to Plejd device

#### 1.4.0 (2024-06-21)

Move to async/await paradigm and fix flickering ouccuring when updating device brightness from home assistant and other sources.

#### 1.3.9 (2024-06-21)

Clear out dependencies & refactor

#### 1.3.8 (2024-06-20)

Updated plejd ble characteristict

#### 1.3.7 (2024-06-20)

Fix import issues and update configurations

#### 1.3.6 (2024-06-20)

Update dependencies

#### 1.3.5 (2024-03-14)

Update dependencies

#### 1.3.4 (2023-06-18)

Move internal plugin errors to debug mode, reducing clutter in the log.

#### 1.3.3 (2023-06-10)

Improve log messages & minor improvements

#### 1.3.2-beta (2023-06-10)

Added possibility to hide items from HomeKit by adding "hidden": true to a device in the config.json file.
