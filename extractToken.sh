#/bin/bash

# ----> Check if you're using a mac, if not don't continue
UNAME=$(uname)
if [ $UNAME != 'Darwin' ]; then 
    echo "For now only works on mac"
    exit 0
fi

# ----> Look for global NPM modules and set the path to ibackuptool that we'll use for extraction
PREFIX=$(npm config get prefix)
NODE_IBACKUP_DIR=$PREFIX/lib/node_modules/ibackuptool

# ----> If the ibackup tool is not installed, let's install it
if [ ! -d "$NODE_IBACKUP_DIR" ]; then
then
    sudo npm i -g ibackuptool
    echo "Installing ibackuptool https://github.com/richinfante/iphonebackuptools" 
    # To make it run on mac we need to fix the line breaks in the files.
    sudo find $NODE_IBACKUP_DIR/**/*js -exec sudo dos2unix {} \;
    echo "System preferences -> Security & Privacy -> Privacy -> tick Full disk access for terminal"
fi

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

echo "System preferences -> Security & Privacy -> Privacy -> un-tick Full disk access for terminal"