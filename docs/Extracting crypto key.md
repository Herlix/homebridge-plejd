## Extract crypto key 

This parts means digging into often encrypted information in a file on your phone. This is done through making a local un-encrypted backup onto you computer no matter operative system, after that you need to somehow get to the information.

The information is mostly based on [this](https://github.com/klali/ha-plejd) project.

I've composed a [shell script](./../extractToken.sh) for doing the tasks listed here, feel free to have a look.

### Steps for Android on MacOs/Linux:

Turn on USB debugging and connect the phone to a computer.

Extract a backup from the phone:
```bash 
$ adb backup com.plejd.plejdapp
```
Unpack the backup:
```bash
$ dd if=backup.ab bs=1 skip=24 | zlib-flate -uncompress | tar -xv
```
Recover the .site file:
```bash
$ cp apps/com.plejd.plejdapp/f/*/*.site site.json
```

### Steps for iOS on MacOs:

Connect you iPhone to your computer and make a backup 

*Steps: finder -> locations -> [phone] -> un-tick 'Encrypt local backup' -> Back up now*

```bash
./plejd.sh
```

All the info will be printed in the terminal for you.

Requirements: ```node``` & ```jq```
<br />

