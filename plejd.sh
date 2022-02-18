#/bin/bash

# DON'T RUN.
# This is very much WIP. I've just stored what i've used to extract my token.

# install: sudo i -g ibackuptool https://github.com/richinfante/iphonebackuptools
# System preferences -> Security & Privacy -> Privacy -> tick Full disk access for terminal

# # To make it run on mac we need to fix the line breaks in the files.
# sudo find /usr/local/lib/node_modules/ibackuptool/**/*js -exec sudo dos2unix {} \;

raw=$(ibackuptool -l -f json)
UUID=$(echo ${raw} | sed 's/run backups.list //' | jq '.[0].udid' | sed 's/"//g')
mkdir temp
q=$(sudo ibackuptool -b ${UUID} -r backup.files --extract ./temp --regex-filter '\.(site)$')
mv temp/App/com.plejd.consumer.light/Documents/**/*.site ./temp/site.json
cat ./temp/site.json | jq '.PlejdMesh.CryptoKey' | sed 's/-//g' | sed 's/"//g'
cat ./temp/site.json | jq '.PlejdMesh._outputAddresses' | grep -v '\$type' | jq '.[][]' 
rm -rf temp



