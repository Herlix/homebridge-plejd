#/bin/bash

# install: sudo i -g ibackuptool https://github.com/richinfante/iphonebackuptools
# sudo find /usr/local/lib/node_modules/ibackuptool/**/*js -exec sudo dos2unix {} \;
# System preferences -> Security & Privacy -> Privacy -> tick Full disk access for terminal
echo "https://github.com/klali/ha-plejd"
raw=$(ibackuptool -l -f json)
UUID=$(echo ${raw} | sed 's/run backups.list //' | jq '.[0].udid' | sed 's/"//g')
mkdir temp
q=$(sudo ibackuptool -b ${UUID} -r backup.files --extract ./temp --regex-filter '\.(site)$')
mv temp/App/com.plejd.consumer.light/Documents/**/*.site ./temp/site.json
cat ./temp/site.json | jq '.PlejdMesh.CryptoKey' | sed 's/-//g' | sed 's/"//g'
cat ./temp/site.json | jq '.PlejdMesh._outputAddresses' | grep -v '\$type' | jq '.[][]' 
rm -rf temp



