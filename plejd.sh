#/bin/bash

UNAME=$(uname)
if [ $UNAME != 'Darwin' ]; then 
    echo "For now only works on mac"
    exit 0
fi

PREFIX=$(npm config get prefix)
NODE_IBACKUP_DIR=$PREFIX/lib/node_modules/ibackuptool

if [ ! -d "$NODE_IBACKUP_DIR" ]; then
then
    sudo npm i -g ibackuptool
    echo "Installing ibackuptool https://github.com/richinfante/iphonebackuptools" 
    # To make it run on mac we need to fix the line breaks in the files.
    sudo find $NODE_IBACKUP_DIR/**/*js -exec sudo dos2unix {} \;
    echo "System preferences -> Security & Privacy -> Privacy -> tick Full disk access for terminal"
fi

RAW=$(ibackuptool -l -f json)
UUID=$(echo ${RAW} | sed 's/run backups.list //' | jq '.[0].udid' | sed 's/"//g')
mkdir temp
Q=$(sudo ibackuptool -b ${UUID} -r backup.files --extract ./temp --regex-filter '\.(site)$')
mv temp/App/com.plejd.consumer.light/Documents/**/*.site ./temp/site.json
cat ./temp/site.json | jq '.PlejdMesh.CryptoKey' | sed 's/-//g' | sed 's/"//g'
cat ./temp/site.json | jq '.PlejdMesh._outputAddresses' | grep -v '\$type' | jq '.[][]' 
rm -rf temp