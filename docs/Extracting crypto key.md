## Extract crypto key

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

