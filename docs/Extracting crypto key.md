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

### Steps for iOS:


One free alternative is to use [this](https://github.com/richinfante/iphonebackuptools) npm package.

There's some information on how to use it. This means using the terminal. 

There might be other alternatives out there.

### Using NPM & JQ
Connect you iPhone to your computer and make a backup 

Mac: *Steps: finder -> locations -> [phone] -> un-tick 'Encrypt local backup' -> Back up now*

```bash 
# on mac you need to use sudo.
npm i -g ibackuptool
```

Mac: *System preferences -> Security & Privacy -> Privacy -> tick Full disk access for terminal*
```bash
#!/bin/bash
PREFIX=`npm config get prefix`
NODE_IBACKUP_DIR=$PREFIX/lib/node_modules/ibackuptool

sudo find $NODE_IBACKUP_DIR/**/*js -exec sudo dos2unix {} \;
```

Run the extraction:
```bash
ibackuptool -l -f json > temp.json
````
This output can be read using any editor, search for ```.PlejdMesh.CryptoKey```


If you'd want to automate it a bit more using jq: 

```
#!/bin/bash
# ----> Run the ibackup tool and put all information into a raw json variable
RAW=$(ibackuptool -l -f json)

# ----> Get the fields needed
UUID=$(echo ${RAW} | sed 's/run backups.list //' | jq '.[0].udid' | sed 's/"//g')

# ----> Extract the actual needed data into a temp dir
mkdir temp
Q=$(sudo ibackuptool -b ${UUID} -r backup.files --extract ./temp --regex-filter '\.(site)$')
mv temp/App/com.plejd.consumer.light/Documents/**/*.site ./temp/site.json

# ----> List the data and remove the temp dir
cat ./temp/site.json | jq '.PlejdMesh.CryptoKey' | sed 's/-//g' | sed 's/"//g'
cat ./temp/site.json | jq '.PlejdMesh._outputAddresses' | grep -v '\$type' | jq '.[][]' 
rm -rf temp
````

Mac: *System preferences -> Security & Privacy -> Privacy -> un-tick Full disk access for terminal*

<br />

